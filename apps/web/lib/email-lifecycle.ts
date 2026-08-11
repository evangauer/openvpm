import { and, eq, lte } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { alertOps } from "@/lib/alerts";
import { marketingEmailEnabledForRecipient } from "@/lib/platform-email-preferences";
import {
  lockPracticeForExternalSideEffects,
  practiceAllowsExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";

type SendResult = { success: boolean; id?: string; error?: string };
type ClaimedLifecycleEmail = { id: string };
type LifecycleEmailCategory = "transactional" | "marketing";

type LifecycleEmailOptions = {
  practiceId: string;
  to: string;
  emailType: string;
  dedupeKey: string;
  send: () => Promise<SendResult>;
  retryOnFail?: boolean;
  category: LifecycleEmailCategory;
  /** Recheck mutable campaign eligibility under the final provider-call lock. */
  stillEligible?: (tx: Database) => Promise<boolean>;
};

export const LIFECYCLE_EMAIL_PENDING_RECLAIM_MS = 30 * 60 * 1000;

/**
 * Send a system lifecycle email exactly once, recording it in the practice's
 * communications history.
 *
 * Idempotency: we first try to claim a row keyed by `dedupeKey` (unique index);
 * if the row already exists, the email was already sent/in-flight and we no-op.
 * This is race-safe under Stripe webhook redelivery and cron re-runs.
 *
 * On a hard send failure we alert ops. For cron-triggered mail (`retryOnFail`)
 * we delete the claim so the next run retries; for webhook mail we keep it
 * (Stripe redelivers the event anyway) so customers never get duplicates.
 */
export async function sendLifecycleEmail(
  opts: LifecycleEmailOptions,
): Promise<{ sent: boolean; deduped: boolean; suppressed?: boolean }> {
  // Never throw into the caller (Stripe webhook / cron). Any infra error
  // (incl. a not-yet-migrated dedupe column) degrades to "not sent" + an alert.
  try {
    if (
      !(await withSystem(db, (tx) =>
        practiceAllowsExternalSideEffects(tx, opts.practiceId),
      ))
    ) {
      await alertOps(
        "Lifecycle email blocked by recovery hold",
        `practice=${opts.practiceId} emailType=${opts.emailType}: ${RECOVERY_HOLD_BLOCK_MESSAGE}`,
      );
      return { sent: false, deduped: false, suppressed: true };
    }

    if (opts.category === "marketing") {
      if (!(await marketingEmailEnabledForRecipient(opts.to))) {
        return { sent: false, deduped: false, suppressed: true };
      }
    }

    // 1. Atomic claim. A fresh existing pending row means another worker is
    // sending right now; an old pending row means the previous worker likely
    // died before recording sent/failed, so it can be reclaimed.
    const row = await claimLifecycleEmail(opts);
    if (!row) {
      return { sent: false, deduped: true };
    }

    // 2. Send.
    let result: SendResult;
    try {
      const delivery = await withSystem(db, async (tx) => {
        if (!(await lockPracticeForExternalSideEffects(tx, opts.practiceId))) {
          return { blocked: true as const };
        }
        if (opts.stillEligible && !(await opts.stillEligible(tx))) {
          return { blocked: true as const };
        }
        return { blocked: false as const, result: await opts.send() };
      });
      if (delivery.blocked) {
        // Recovery or campaign state changed after the claim. Remove it because
        // no provider request occurred; a future eligible run can claim again.
        await withSystem(db, (tx) =>
          tx.delete(communications).where(eq(communications.id, row.id)),
        );
        return { sent: false, deduped: false, suppressed: true };
      }
      result = delivery.result;
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : "send threw",
      };
    }

    // 3. Record the outcome.
    if (result.success) {
      const sentUpdate: {
        status: "sent";
        providerMessageId?: string;
      } = { status: "sent" };
      if (result.id) {
        sentUpdate.providerMessageId = result.id;
      }

      await withSystem(db, (tx) =>
        tx
          .update(communications)
          .set(sentUpdate)
          .where(eq(communications.id, row.id)),
      );
      return { sent: true, deduped: false };
    }

    await alertOps(
      "Lifecycle email failed",
      `${opts.emailType} → ${opts.to}: ${result.error ?? "unknown error"}`,
    );

    if (opts.retryOnFail) {
      // Drop the claim so the next cron sweep can try again.
      await withSystem(db, (tx) =>
        tx.delete(communications).where(eq(communications.id, row.id)),
      );
    } else {
      await withSystem(db, (tx) =>
        tx
          .update(communications)
          .set({ status: "failed" })
          .where(eq(communications.id, row.id)),
      );
    }
    return { sent: false, deduped: false };
  } catch (err) {
    await alertOps(
      "Lifecycle email error",
      `${opts.emailType} → ${opts.to}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { sent: false, deduped: false };
  }
}

/**
 * The only supported boundary for optional platform lifecycle email. Keeping
 * the category out of the caller's hands makes the preference check mandatory
 * for every campaign that adopts this sender.
 */
export function sendOptionalPlatformEmail(
  opts: Omit<LifecycleEmailOptions, "category">,
) {
  return sendLifecycleEmail({ ...opts, category: "marketing" });
}

async function claimLifecycleEmail(opts: {
  practiceId: string;
  emailType: string;
  dedupeKey: string;
}): Promise<ClaimedLifecycleEmail | null> {
  const claimed = await insertLifecycleEmailClaim(opts);
  const row = claimed[0];
  if (row) return row;

  const [existing] = await withSystem(db, (tx) =>
    tx
      .select({
        id: communications.id,
        status: communications.status,
        createdAt: communications.createdAt,
      })
      .from(communications)
      .where(eq(communications.dedupeKey, opts.dedupeKey))
      .limit(1),
  );
  if (!existing || existing.status !== "pending") return null;

  const staleBefore = new Date(Date.now() - LIFECYCLE_EMAIL_PENDING_RECLAIM_MS);
  if (new Date(existing.createdAt).getTime() > staleBefore.getTime()) {
    return null;
  }

  const deleted = await withSystem(db, (tx) =>
    tx
      .delete(communications)
      .where(
        and(
          eq(communications.dedupeKey, opts.dedupeKey),
          eq(communications.status, "pending"),
          lte(communications.createdAt, staleBefore),
        ),
      )
      .returning({ id: communications.id }),
  );
  if (!deleted[0]) return null;

  return (await insertLifecycleEmailClaim(opts))[0] ?? null;
}

function insertLifecycleEmailClaim(opts: {
  practiceId: string;
  emailType: string;
  dedupeKey: string;
}) {
  return withSystem(db, (tx) =>
    tx
      .insert(communications)
      .values({
        practiceId: opts.practiceId,
        clientId: null,
        channel: "email",
        direction: "outbound",
        subject: opts.emailType,
        content: opts.emailType,
        status: "pending",
        dedupeKey: opts.dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning({ id: communications.id }),
  );
}
