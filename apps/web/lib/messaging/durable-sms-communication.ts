import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { and, eq, isNull, lte } from "drizzle-orm";
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
 * The parent row is locked before checking for an attempt. A concurrent
 * attempt reservation must acquire an FK key lock, so it cannot race this
 * decision. Any attempt at all means the provider may have been called and
 * permanently blocks automatic recovery here.
 */
export async function recoverStaleUnreservedSmsCommunication(
  tx: Pick<Database, "select">,
  options: {
    practiceId: string;
    dedupeKey: string;
    now?: Date;
  },
): Promise<string | null> {
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - STALE_SMS_COMMUNICATION_CLAIM_MS,
  );
  const [communication] = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, options.practiceId),
        eq(communications.dedupeKey, options.dedupeKey),
        eq(communications.channel, "sms"),
        eq(communications.direction, "outbound"),
        eq(communications.status, "pending"),
        lte(communications.createdAt, cutoff),
        isNull(communications.deletedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!communication) return null;

  const [attempt] = await tx
    .select({ id: smsSendAttempts.id })
    .from(smsSendAttempts)
    .where(
      and(
        eq(smsSendAttempts.practiceId, options.practiceId),
        eq(smsSendAttempts.communicationId, communication.id),
      ),
    )
    .limit(1);

  return attempt ? null : communication.id;
}
