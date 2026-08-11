import { and, eq, lte } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { alertOps } from "@/lib/alerts";
import {
  lockAndCheckMarketingEmailEnabled,
  marketingEmailEnabledForRecipient,
} from "@/lib/platform-email-preferences";
import { emailPreferenceRecipientHash } from "@/lib/email-preferences";
import {
  lockPracticeForExternalSideEffects,
  practiceAllowsExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";

type SendResult = {
  success: boolean;
  id?: string;
  error?: string;
  outcome?: "accepted" | "definite_failure" | "outcome_unknown";
  failureCode?: string;
};
type ClaimedLifecycleEmail = { id: string };
type LifecycleEmailClaim =
  | { kind: "claimed"; row: ClaimedLifecycleEmail }
  | { kind: "duplicate"; state: "sent" | "in_flight" | "failed" };
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
export async function sendLifecycleEmail(opts: LifecycleEmailOptions): Promise<{
  sent: boolean;
  deduped: boolean;
  suppressed?: boolean;
  dedupeState?: "sent" | "in_flight" | "failed";
}> {
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
    const claim = await claimLifecycleEmail(opts);
    if (claim.kind === "duplicate") {
      return {
        sent: false,
        deduped: true,
        dedupeState: claim.state,
      };
    }
    const row = claim.row;

    // 2. Send.
    let result: SendResult;
    try {
      const delivery = await withSystem(db, async (tx) => {
        if (!(await lockPracticeForExternalSideEffects(tx, opts.practiceId))) {
          return { blocked: true as const };
        }
        if (
          opts.category === "marketing" &&
          !(await lockAndCheckMarketingEmailEnabled(tx, opts.to))
        ) {
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
      lifecycleAlertDetail(
        opts,
        result.failureCode ?? result.outcome ?? "send_failed",
      ),
    );

    if (result.outcome === "outcome_unknown") {
      // Keep the recipient-bound claim pending. A stale retry reuses the same
      // provider idempotency key; deleting here could duplicate an accepted
      // request whose response was lost.
      return { sent: false, deduped: false };
    }

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
      lifecycleAlertDetail(opts, "lifecycle_exception"),
    );
    return { sent: false, deduped: false };
  }
}

function lifecycleAlertDetail(
  opts: Pick<LifecycleEmailOptions, "practiceId" | "to" | "emailType">,
  errorCode: string,
): string {
  const recipientHash = emailPreferenceRecipientHash(opts.to);
  return [
    `practice=${opts.practiceId}`,
    `emailType=${opts.emailType}`,
    `recipientHash=${recipientHash?.slice(0, 16) ?? "unavailable"}`,
    `errorCode=${errorCode.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64)}`,
  ].join(" ");
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
  to: string;
  emailType: string;
  dedupeKey: string;
}): Promise<LifecycleEmailClaim> {
  const claimed = await insertLifecycleEmailClaim(opts);
  const row = claimed[0];
  if (row) return { kind: "claimed", row };

  const [existing] = await withSystem(db, (tx) =>
    tx
      .select({
        id: communications.id,
        status: communications.status,
        createdAt: communications.createdAt,
        content: communications.content,
      })
      .from(communications)
      .where(eq(communications.dedupeKey, opts.dedupeKey))
      .limit(1),
  );
  if (!existing) {
    // The unique conflict disappeared between INSERT and SELECT. Treat the
    // outcome as in-flight so webhook callers retry instead of acknowledging
    // a delivery whose durable state cannot be proven.
    return { kind: "duplicate", state: "in_flight" };
  }
  if (existing.status !== "pending") {
    return {
      kind: "duplicate",
      state: existing.status === "sent" ? "sent" : "failed",
    };
  }

  const expectedRecipientBinding = lifecycleRecipientBinding(opts);
  if (existing.content !== expectedRecipientBinding) {
    await alertOps(
      "Lifecycle email recipient changed after an ambiguous send",
      lifecycleAlertDetail(
        opts,
        "recipient binding differs from the pending provider attempt",
      ),
    );
    return { kind: "duplicate", state: "in_flight" };
  }

  const staleBefore = new Date(Date.now() - LIFECYCLE_EMAIL_PENDING_RECLAIM_MS);
  if (new Date(existing.createdAt).getTime() > staleBefore.getTime()) {
    return { kind: "duplicate", state: "in_flight" };
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
  if (!deleted[0]) {
    return { kind: "duplicate", state: "in_flight" };
  }

  const reclaimed = (await insertLifecycleEmailClaim(opts))[0];
  return reclaimed
    ? { kind: "claimed", row: reclaimed }
    : { kind: "duplicate", state: "in_flight" };
}

function insertLifecycleEmailClaim(opts: {
  practiceId: string;
  to: string;
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
        content: lifecycleRecipientBinding(opts),
        status: "pending",
        dedupeKey: opts.dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning({ id: communications.id }),
  );
}

function lifecycleRecipientBinding(opts: {
  to: string;
  emailType: string;
}): string {
  const recipientHash = emailPreferenceRecipientHash(opts.to);
  if (!recipientHash) {
    throw new Error("email preference identity is not configured");
  }
  return `${opts.emailType}:recipient:${recipientHash}`;
}
