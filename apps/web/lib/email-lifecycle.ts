import { eq } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { alertOps } from "@/lib/alerts";

type SendResult = { success: boolean; id?: string; error?: string };

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
export async function sendLifecycleEmail(opts: {
  practiceId: string;
  to: string;
  emailType: string;
  dedupeKey: string;
  send: () => Promise<SendResult>;
  retryOnFail?: boolean;
}): Promise<{ sent: boolean; deduped: boolean }> {
  // Never throw into the caller (Stripe webhook / cron). Any infra error
  // (incl. a not-yet-migrated dedupe column) degrades to "not sent" + an alert.
  try {
    // 1. Atomic claim — no row back means someone already claimed this key.
    const claimed = await withSystem(db, (tx) =>
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

    const row = claimed[0];
    if (!row) {
      return { sent: false, deduped: true };
    }

    // 2. Send.
    let result: SendResult;
    try {
      result = await opts.send();
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : "send threw",
      };
    }

    // 3. Record the outcome.
    if (result.success) {
      await withSystem(db, (tx) =>
        tx
          .update(communications)
          .set({ status: "sent" })
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
