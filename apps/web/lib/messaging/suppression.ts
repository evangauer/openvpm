import { and, eq } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { smsSuppressions } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { normalizeE164 } from "./phone";

export type SuppressionReason = "stop" | "manual" | "bounce" | "complaint";

/**
 * Is this number on the practice's do-not-text list? Opt-out is practice-wide
 * (TCPA). Throws on a DB error so the caller can fail closed (block the send)
 * rather than text someone who may have opted out.
 */
export async function isSuppressed(
  practiceId: string,
  phone: string
): Promise<boolean> {
  const e164 = normalizeE164(phone);
  if (!e164) return false;
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ id: smsSuppressions.id })
      .from(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, practiceId),
          eq(smsSuppressions.phone, e164)
        )
      )
      .limit(1)
  );
  return Boolean(row);
}

/**
 * Add a number to the practice's suppression list (idempotent on
 * practice + phone). Used by the inbound STOP webhook and manual opt-outs.
 */
export async function addSuppression(opts: {
  practiceId: string;
  phone: string;
  locationId?: string;
  reason?: SuppressionReason;
  detail?: string;
}): Promise<void> {
  const e164 = normalizeE164(opts.phone);
  if (!e164) return;
  await withSystem(db, (tx) =>
    tx
      .insert(smsSuppressions)
      .values({
        practiceId: opts.practiceId,
        locationId: opts.locationId,
        phone: e164,
        reason: opts.reason ?? "stop",
        detail: opts.detail,
      })
      .onConflictDoNothing({
        target: [smsSuppressions.practiceId, smsSuppressions.phone],
      })
  );
}

/** Remove a number from the suppression list (e.g. recipient texts START). */
export async function removeSuppression(
  practiceId: string,
  phone: string
): Promise<void> {
  const e164 = normalizeE164(phone);
  if (!e164) return;
  await withSystem(db, (tx) =>
    tx
      .delete(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, practiceId),
          eq(smsSuppressions.phone, e164)
        )
      )
  );
}
