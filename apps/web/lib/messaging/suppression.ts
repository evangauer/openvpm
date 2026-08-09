import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { clients, smsSuppressions } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { normalizeE164 } from "./phone";
import {
  appendSmsConsentEventInTransaction,
  type SmsConsentEventEvidence,
} from "./consent-events";

export type SuppressionReason = "stop" | "manual" | "bounce" | "complaint";
type SmsRevocationDatabase = Pick<Database, "execute" | "insert" | "update">;
type SmsRecipientLockDatabase = Pick<Database, "execute">;
type SmsRevocationEvidence = Omit<
  SmsConsentEventEvidence,
  "practiceId" | "destinationE164" | "action"
>;

export async function acquireSmsRecipientLockInTransaction(
  tx: SmsRecipientLockDatabase,
  practiceId: string,
  phone: string,
): Promise<string> {
  const e164 = normalizeE164(phone);
  if (!e164) {
    throw new Error("A valid SMS phone number is required for revocation.");
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms:${practiceId}:${e164}`}, 0))`,
  );
  return e164;
}

/**
 * Is this number on the practice's do-not-text list? Opt-out is practice-wide
 * (TCPA). Throws on a DB error so the caller can fail closed (block the send)
 * rather than text someone who may have opted out.
 */
export async function isSuppressed(
  practiceId: string,
  phone: string,
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
          eq(smsSuppressions.phone, e164),
        ),
      )
      .limit(1),
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
      }),
  );
}

/**
 * Practice-wide revocation primitive shared by carrier opt-outs and staff
 * actions. The suppression and every active duplicate client consent row change
 * in one transaction, under the same recipient lock used by hosted dispatch.
 */
async function revokeSmsConsentAfterLock(
  tx: SmsRevocationDatabase,
  e164: string,
  opts: {
    practiceId: string;
    locationId?: string;
    reason: "stop" | "manual";
    detail?: string;
    evidence: SmsRevocationEvidence;
  },
): Promise<{ phone: string; clientsRevoked: number }> {
  const fullDigits = e164.replace(/\D/g, "");
  const nationalDigits =
    e164.startsWith("+1") && fullDigits.length === 11
      ? fullDigits.slice(1)
      : fullDigits;

  const eventInserted = await appendSmsConsentEventInTransaction(tx, {
    ...opts.evidence,
    practiceId: opts.practiceId,
    destinationE164: e164,
    action: "revoked",
    detail: opts.evidence.detail ?? opts.detail,
  });
  if (!eventInserted) {
    if (opts.evidence.actorType !== "client") {
      throw new Error("SMS consent revocation evidence could not be appended");
    }
    return { phone: e164, clientsRevoked: 0 };
  }

  await tx
    .insert(smsSuppressions)
    .values({
      practiceId: opts.practiceId,
      locationId: opts.locationId,
      phone: e164,
      reason: opts.reason,
      detail: opts.detail,
    })
    .onConflictDoUpdate({
      target: [smsSuppressions.practiceId, smsSuppressions.phone],
      set: {
        // A carrier STOP must never downgrade a prior staff/complaint/bounce
        // suppression into a removable STOP. Manual revocation is the only
        // path here that intentionally upgrades an existing row.
        locationId:
          opts.reason === "manual"
            ? opts.locationId
            : smsSuppressions.locationId,
        reason: opts.reason === "manual" ? "manual" : smsSuppressions.reason,
        detail: opts.reason === "manual" ? opts.detail : smsSuppressions.detail,
        deletedAt: null,
        updatedAt: new Date(),
      },
    });

  const revoked = await tx
    .update(clients)
    .set({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    })
    .where(
      and(
        eq(clients.practiceId, opts.practiceId),
        isNull(clients.deletedAt),
        or(
          sql`regexp_replace(${clients.phone}, '\D', '', 'g') = ${fullDigits}`,
          sql`regexp_replace(${clients.phone}, '\D', '', 'g') = ${nationalDigits}`,
        ),
      ),
    )
    .returning({ id: clients.id });

  return { phone: e164, clientsRevoked: revoked.length };
}

/**
 * Apply revocation after the caller has acquired the practice/recipient
 * advisory lock and, where applicable, revalidated any row it then locked.
 * This explicit variant keeps every route on the same advisory-before-row
 * ordering as hosted dispatch.
 */
export async function revokeSmsConsentAfterRecipientLockInTransaction(
  tx: SmsRevocationDatabase,
  opts: {
    practiceId: string;
    phone: string;
    locationId?: string;
    reason: "stop" | "manual";
    detail?: string;
    evidence: SmsRevocationEvidence;
  },
): Promise<{ phone: string; clientsRevoked: number }> {
  const e164 = normalizeE164(opts.phone);
  if (!e164) {
    throw new Error("A valid SMS phone number is required for revocation.");
  }
  return revokeSmsConsentAfterLock(tx, e164, opts);
}

export async function revokeSmsConsentByPhoneInTransaction(
  tx: SmsRevocationDatabase,
  opts: {
    practiceId: string;
    phone: string;
    locationId?: string;
    reason: "stop" | "manual";
    detail?: string;
    evidence: SmsRevocationEvidence;
  },
): Promise<{ phone: string; clientsRevoked: number }> {
  const e164 = await acquireSmsRecipientLockInTransaction(
    tx,
    opts.practiceId,
    opts.phone,
  );
  return revokeSmsConsentAfterLock(tx, e164, opts);
}

export async function revokeSmsConsentByPhone(opts: {
  practiceId: string;
  phone: string;
  locationId?: string;
  reason: "stop" | "manual";
  detail?: string;
  evidence: SmsRevocationEvidence;
}): Promise<{ phone: string; clientsRevoked: number }> {
  return withSystem(db, (tx) => revokeSmsConsentByPhoneInTransaction(tx, opts));
}

/**
 * Remove carrier STOP suppression after an explicit opt-in keyword. Manual,
 * bounce, and complaint suppressions remain as staff/provider safety gates.
 */
