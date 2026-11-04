import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { communications, smsSendAttempts } from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";

export const STALE_SMS_COMMUNICATION_CLAIM_MS = 15 * 60 * 1000;

/**
 * SMS communication claims and projections must commit outside a tRPC caller's
 * surrounding transaction. The immutable attempt ledger foreign-keys the
 * communication snapshot and reserves in its own transaction before provider
 * dispatch, so the parent row must already be visible and durable.
 */
export function withDurableSmsCommunication<T>(
  practiceId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return withTenant(db, practiceId, fn);
}

/**
 * Recover only the narrow crash seam where a pending SMS communication claim
 * committed but the process died before reserving an immutable send attempt.
 *
 * This is one conditional UPDATE so concurrent claimers cannot all win. The
 * claim is judged stale by `updated_at` on the database clock, and winning
 * sets `updated_at = now()`; a reclaimed row (for example a failed reminder
 * just reset to pending) is therefore fresh and every other claimer gets
 * nothing. A claimer that waits on the row lock re-checks `updated_at`
 * against the winner's write. Any attempt at all means the provider may have
 * been called and permanently blocks recovery here; a reservation racing this
 * statement still uses the claim's idempotency key, which the attempt ledger
 * keeps unique.
 */
export async function recoverStaleUnreservedSmsCommunication(
  tx: Pick<Database, "update">,
  options: {
    practiceId: string;
    dedupeKey: string;
  },
): Promise<string | null> {
  const [communication] = await tx
    .update(communications)
    .set({ updatedAt: sql`now()` })
    .where(
      and(
        eq(communications.practiceId, options.practiceId),
        eq(communications.dedupeKey, options.dedupeKey),
        eq(communications.channel, "sms"),
        eq(communications.direction, "outbound"),
        eq(communications.status, "pending"),
        sql`${communications.updatedAt} <= now() - make_interval(secs => ${STALE_SMS_COMMUNICATION_CLAIM_MS / 1000})`,
        isNull(communications.deletedAt),
        sql`not exists (
          select 1 from ${smsSendAttempts}
          where ${smsSendAttempts.practiceId} = ${communications.practiceId}
            and ${smsSendAttempts.communicationId} = ${communications.id}
        )`,
      ),
    )
    .returning({ id: communications.id });

  return communication?.id ?? null;
}
