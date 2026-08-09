import { createHash, randomUUID } from "node:crypto";
import { smsConsentEvents } from "@openpims/db";
import type { Database } from "@openpims/db/client";

type SmsConsentEventDatabase = Pick<Database, "insert">;

export const SMS_CONSENT_EVENT_DETAIL_MAX_LENGTH = 2000;

export type SmsConsentEventEvidence = {
  practiceId: string;
  clientId?: string | null;
  locationId?: string | null;
  destinationE164: string;
  action: "granted" | "revoked";
  source: string;
  disclosureVersion?: string | null;
  disclosure?: string | null;
  detail?: string | null;
  actorType: "staff" | "client" | "system";
  actorUserId?: string | null;
  actorName?: string | null;
  provider?: "telnyx" | "twilio" | null;
  providerMessageId?: string | null;
  eventKey: string;
  occurredAt?: Date;
};

export function staffSmsConsentEventKey(): string {
  return `staff:${randomUUID()}`;
}

export function inboundSmsConsentEventKey(
  provider: "telnyx" | "twilio",
  providerMessageId: string,
  action: "granted" | "revoked",
): string {
  const raw = `inbound:${provider}:${providerMessageId}:${action}`;
  if (raw.length <= 200) return raw;
  return `inbound:${provider}:${action}:${createHash("sha256")
    .update(providerMessageId)
    .digest("hex")}`;
}

/**
 * Append consent evidence inside the caller's projection/suppression
 * transaction. A false result means this exact event was already applied (for
 * example, a carrier replay) and callers must not repeat its state mutation.
 */
export async function appendSmsConsentEventInTransaction(
  tx: SmsConsentEventDatabase,
  evidence: SmsConsentEventEvidence,
): Promise<boolean> {
  const inserted = await tx
    .insert(smsConsentEvents)
    .values({
      practiceId: evidence.practiceId,
      clientId: evidence.clientId ?? null,
      locationId: evidence.locationId ?? null,
      destinationE164: evidence.destinationE164,
      action: evidence.action,
      source: evidence.source,
      disclosureVersion: evidence.disclosureVersion ?? null,
      disclosure: evidence.disclosure ?? null,
      detail:
        evidence.detail == null
          ? null
          : evidence.detail.slice(0, SMS_CONSENT_EVENT_DETAIL_MAX_LENGTH),
      actorType: evidence.actorType,
      actorUserId: evidence.actorUserId ?? null,
      actorName: evidence.actorName ?? null,
      provider: evidence.provider ?? null,
      providerMessageId: evidence.providerMessageId ?? null,
      eventKey: evidence.eventKey,
      occurredAt: evidence.occurredAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [smsConsentEvents.practiceId, smsConsentEvents.eventKey],
    })
    .returning({ id: smsConsentEvents.id });

  return inserted.length === 1;
}

/**
 * Staff-originated projection changes are not replayable. Require their
 * evidence row to be inserted so a vanishingly unlikely event-key collision
 * rolls the entire transaction back instead of leaving an unaudited state.
 */
export async function appendRequiredSmsConsentEventInTransaction(
  tx: SmsConsentEventDatabase,
  evidence: SmsConsentEventEvidence,
): Promise<void> {
  const inserted = await appendSmsConsentEventInTransaction(tx, evidence);
  if (!inserted) {
    throw new Error("SMS consent evidence event could not be appended");
  }
}
