import { createHash } from "node:crypto";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  clients,
  communications,
  locationMessaging,
  locations,
  practices,
  smsSuppressions,
} from "@openpims/db";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { normalizeE164 } from "./phone";
import {
  acquireSmsRecipientLockInTransaction,
  revokeSmsConsentByPhone,
} from "./suppression";
import { inboundSmsOptInEvidence, SMS_INBOUND_OPT_IN } from "./consent";
import {
  appendSmsConsentEventInTransaction,
  inboundSmsConsentEventKey,
} from "./consent-events";
import { latestAssignedToForClient } from "@/lib/communications/assignment";

export type InboundSmsProvider = "telnyx" | "twilio";
export type InboundSmsAction =
  | "ignored"
  | "suppressed"
  | "unsuppressed"
  | "logged";
export type InboundSmsClassification = "stop" | "start" | "help" | "other";

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

function normalizedKeyword(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * Carrier keywords must be the whole message. A small, anchored set of plain
 * language requests covers unmistakable revocations without guessing at
 * ambiguous conversational messages (for example, “do not stop texting me”).
 */
export function classifyInboundSms(text: string): InboundSmsClassification {
  const trimmed = text.trim();
  if (!trimmed) return "other";
  const keyword = normalizedKeyword(trimmed);
  if (STOP_KEYWORDS.has(keyword)) return "stop";
  if (START_KEYWORDS.has(keyword)) return "start";
  if (HELP_KEYWORDS.has(keyword)) return "help";
  if (/\?\s*$/.test(trimmed)) return "other";

  const sentence = trimmed
    .toLowerCase()
    .replace(/[.!,;:]+$/g, "")
    .replace(/\s+/g, " ");
  const naturalOptOut = [
    /^(?:please |kindly )?stop (?:texting|messaging)(?: me)?$/,
    /^(?:please |kindly )?stop sending me (?:texts|text messages|messages|sms messages)$/,
    /^(?:please |kindly )?(?:do not|don['’]t) (?:text|message) me$/,
    /^(?:please |kindly )?(?:do not|don['’]t) send me (?:texts|text messages|sms messages)$/,
    /^(?:please |kindly )?no more (?:texts|text messages|sms messages)$/,
    /^(?:please |kindly )?(?:remove me from|take me off) (?:your |the )?(?:text|texting|sms) list$/,
    /^(?:please |kindly )?unsubscribe me from (?:texts|text messages|sms messages)$/,
  ].some((pattern) => pattern.test(sentence));
  return naturalOptOut ? "stop" : "other";
}

export function inboundSmsDedupeKey(
  provider: InboundSmsProvider,
  providerMessageId: string | null,
): string | undefined {
  if (!providerMessageId) return undefined;
  const prefix = `${provider}:inbound:`;
  const key = `${prefix}${providerMessageId}`;
  if (key.length <= 160) return key;
  const digest = createHash("sha256").update(providerMessageId).digest("hex");
  return `${prefix}${digest}`;
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedClientPhoneCondition(e164: string): SQL | null {
  const normalized = normalizeE164(e164);
  if (!normalized) return null;
  const fullDigits = normalized.replace(/\D/g, "");
  const nationalDigits =
    normalized.startsWith("+1") && fullDigits.length === 11
      ? fullDigits.slice(1)
      : fullDigits;
  return or(
    sql`regexp_replace(${clients.phone}, '\D', '', 'g') = ${fullDigits}`,
    sql`regexp_replace(${clients.phone}, '\D', '', 'g') = ${nationalDigits}`,
  )!;
}

async function findMessagingLocationMatching(
  provider: InboundSmsProvider,
  matchCondition: SQL,
): Promise<{ practiceId: string; locationId: string } | null> {
  const matches = await withSystem(db, (tx) =>
    tx
      .select({
        practiceId: locationMessaging.practiceId,
        locationId: locationMessaging.locationId,
      })
      .from(locationMessaging)
      .innerJoin(
        locations,
        and(
          eq(locations.id, locationMessaging.locationId),
          eq(locations.practiceId, locationMessaging.practiceId),
          isNull(locations.deletedAt),
        ),
      )
      .innerJoin(
        practices,
        and(
          eq(practices.id, locationMessaging.practiceId),
          isNull(practices.deletedAt),
        ),
      )
      .where(
        and(
          matchCondition,
          eq(locationMessaging.provider, provider),
          isNull(locationMessaging.deletedAt),
          eq(locations.practiceId, locationMessaging.practiceId),
          isNull(locations.deletedAt),
        ),
      )
      .limit(2),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function findMessagingLocationBySender(
  senderE164: string,
  provider: InboundSmsProvider,
): Promise<{ practiceId: string; locationId: string } | null> {
  const sender = normalizeE164(senderE164);
  if (!sender) return null;
  return findMessagingLocationMatching(
    provider,
    sql`trim(${locationMessaging.senderE164}) = ${sender}`,
  );
}

export async function findMessagingLocationForWebhook(opts: {
  senderE164?: string | null;
  messagingProfileId?: string | null;
  provider: InboundSmsProvider;
}): Promise<{ practiceId: string; locationId: string } | null> {
  const sender = opts.senderE164 ? normalizeE164(opts.senderE164) : null;
  const messagingProfileId = nonBlank(opts.messagingProfileId);

  if (sender) {
    const loc = await findMessagingLocationMatching(
      opts.provider,
      sql`trim(${locationMessaging.senderE164}) = ${sender}`,
    );
    if (loc) return loc;
  }

  if (!messagingProfileId) return null;
  return findMessagingLocationMatching(
    opts.provider,
    sql`trim(${locationMessaging.messagingProfileId}) = ${messagingProfileId}`,
  );
}

/** Best-effort: find the only active client in the practice matching this phone. */
export async function findClientIdByPhone(
  practiceId: string,
  e164: string,
): Promise<string | null> {
  const phoneCondition = normalizedClientPhoneCondition(e164);
  if (!phoneCondition) return null;
  const matches = await withSystem(db, (tx) =>
    tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, practiceId),
          isNull(clients.deletedAt),
          phoneCondition,
        ),
      )
      .limit(2),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

async function applyInboundSmsOptIn(opts: {
  practiceId: string;
  locationId: string;
  provider: InboundSmsProvider;
  providerMessageId: string;
  phone: string;
  keyword: string;
}): Promise<{ clientId: string | null; remainsSuppressed: boolean }> {
  const destination = normalizeE164(opts.phone);
  const phoneCondition = normalizedClientPhoneCondition(opts.phone);
  if (!destination || !phoneCondition) {
    return { clientId: null, remainsSuppressed: true };
  }

  return withSystem(db, async (tx) => {
    await acquireSmsRecipientLockInTransaction(
      tx,
      opts.practiceId,
      destination,
    );

    const matches = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, opts.practiceId),
          isNull(clients.deletedAt),
          phoneCondition,
        ),
      )
      .limit(2)
      .for("update");
    const clientId = matches.length === 1 ? (matches[0]?.id ?? null) : null;

    const [suppression] = await tx
      .select({ reason: smsSuppressions.reason })
      .from(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, opts.practiceId),
          eq(smsSuppressions.phone, destination),
        ),
      )
      .limit(1);
    if (suppression && suppression.reason !== "stop") {
      return { clientId, remainsSuppressed: true };
    }

    const disclosure = inboundSmsOptInEvidence(opts.keyword);
    const eventInserted = await appendSmsConsentEventInTransaction(tx, {
      practiceId: opts.practiceId,
      clientId,
      locationId: opts.locationId,
      destinationE164: destination,
      action: "granted",
      source: SMS_INBOUND_OPT_IN.source,
      disclosureVersion: SMS_INBOUND_OPT_IN.version,
      disclosure,
      detail: `Inbound opt-in keyword: "${opts.keyword}"`,
      actorType: "client",
      provider: opts.provider,
      providerMessageId: opts.providerMessageId,
      eventKey: inboundSmsConsentEventKey(
        opts.provider,
        opts.providerMessageId,
        "granted",
      ),
    });

    if (!eventInserted) {
      // A replay must report the state that is still current. In particular,
      // START(event A) -> STOP(event B) -> replay START(A) must not claim the
      // later STOP was removed when the idempotent event insert was skipped.
      return { clientId, remainsSuppressed: Boolean(suppression) };
    }

    await tx
      .delete(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, opts.practiceId),
          eq(smsSuppressions.phone, destination),
          eq(smsSuppressions.reason, "stop"),
        ),
      );

    if (clientId) {
      const updated = await tx
        .update(clients)
        .set({
          smsConsent: true,
          smsConsentAt: new Date(),
          smsConsentSource: SMS_INBOUND_OPT_IN.source,
          smsConsentDisclosure: disclosure,
        })
        .where(
          and(
            eq(clients.id, clientId),
            eq(clients.practiceId, opts.practiceId),
            isNull(clients.deletedAt),
            phoneCondition,
          ),
        )
        .returning({ id: clients.id });
      if (updated.length !== 1) {
        throw new Error(
          "Inbound SMS opt-in client changed before consent could be projected",
        );
      }
    }

    return { clientId, remainsSuppressed: false };
  });
}

async function logInboundSmsCommunication(opts: {
  practiceId: string;
  clientId: string | null;
  provider: InboundSmsProvider;
  fromPhone: string;
  text: string;
  providerMessageId: string | null;
  subject?: string;
}): Promise<void> {
  await withTenant(db, opts.practiceId, (tx) =>
    tx
      .insert(communications)
      .values({
        practiceId: opts.practiceId,
        clientId: opts.clientId ?? undefined,
        channel: "sms",
        direction: "inbound",
        subject: opts.subject ?? `SMS from ${opts.fromPhone}`,
        content: opts.text,
        status: "delivered",
        providerMessageId: opts.providerMessageId ?? undefined,
        dedupeKey: inboundSmsDedupeKey(opts.provider, opts.providerMessageId),
        ...(opts.clientId
          ? {
              assignedTo: latestAssignedToForClient(
                opts.practiceId,
                opts.clientId,
              ),
            }
          : {}),
      })
      .onConflictDoNothing({ target: communications.dedupeKey }),
  );
}

export async function handleInboundSmsReply(opts: {
  provider: InboundSmsProvider;
  fromPhone: string;
  toPhone?: string | null;
  text: string;
  providerMessageId: string | null;
  messagingProfileId?: string | null;
}): Promise<{ ok: true; action: InboundSmsAction }> {
  const fromPhone = normalizeE164(opts.fromPhone);
  const toPhone = opts.toPhone ? normalizeE164(opts.toPhone) : null;
  const text = opts.text.trim();
  if (!fromPhone || !text || (!toPhone && !nonBlank(opts.messagingProfileId))) {
    return { ok: true, action: "ignored" };
  }

  const loc = await findMessagingLocationForWebhook({
    senderE164: toPhone,
    messagingProfileId: opts.messagingProfileId,
    provider: opts.provider,
  });
  if (!loc) return { ok: true, action: "ignored" };

  const classification = classifyInboundSms(text);
  const keyword = normalizedKeyword(text);
  if (classification === "stop") {
    const providerMessageId = opts.providerMessageId;
    if (!providerMessageId) {
      // Consent state changes require a durable provider identity. Without one,
      // a replay cannot be distinguished from a later legitimate decision.
      return { ok: true, action: "ignored" };
    }
    await revokeSmsConsentByPhone({
      practiceId: loc.practiceId,
      locationId: loc.locationId,
      phone: fromPhone,
      reason: "stop",
      detail: `Inbound opt-out: "${text}"`,
      evidence: {
        // STOP is a destination-wide instruction. Do not bind immutable
        // evidence to a client selected before the recipient lock: the phone
        // can move concurrently, and duplicate clients are all revoked.
        clientId: null,
        locationId: loc.locationId,
        source: "inbound_opt_out:v1",
        detail: `Inbound opt-out: "${text}"`,
        actorType: "client",
        provider: opts.provider,
        providerMessageId,
        eventKey: inboundSmsConsentEventKey(
          opts.provider,
          providerMessageId,
          "revoked",
        ),
      },
    });
    const clientId = await findClientIdByPhone(loc.practiceId, fromPhone);
    await logInboundSmsCommunication({
      practiceId: loc.practiceId,
      clientId,
      provider: opts.provider,
      fromPhone,
      text,
      providerMessageId: opts.providerMessageId,
      subject: `SMS opt-out from ${fromPhone}`,
    });
    return { ok: true, action: "suppressed" };
  }

  if (classification === "start") {
    const providerMessageId = opts.providerMessageId;
    if (!providerMessageId) {
      return { ok: true, action: "ignored" };
    }
    // START can remove only a carrier STOP. The event, suppression removal,
    // and (only for a unique client match) current projection change commit
    // together. Manual, complaint, and bounce suppressions remain authoritative.
    const optIn = await applyInboundSmsOptIn({
      practiceId: loc.practiceId,
      locationId: loc.locationId,
      provider: opts.provider,
      providerMessageId,
      phone: fromPhone,
      keyword,
    });
    const remainsSuppressed = optIn.remainsSuppressed;
    await logInboundSmsCommunication({
      practiceId: loc.practiceId,
      clientId: optIn.clientId,
      provider: opts.provider,
      fromPhone,
      text,
      providerMessageId: opts.providerMessageId,
      subject: remainsSuppressed
        ? `SMS opt-in blocked for ${fromPhone}`
        : `SMS opt-in from ${fromPhone}`,
    });
    return {
      ok: true,
      action: remainsSuppressed ? "suppressed" : "unsuppressed",
    };
  }

  const clientId = await findClientIdByPhone(loc.practiceId, fromPhone);

  if (classification === "help") {
    // Carriers commonly generate their own HELP response. Log one staff-visible
    // request but do not dispatch a second automated reply.
    await logInboundSmsCommunication({
      practiceId: loc.practiceId,
      clientId,
      provider: opts.provider,
      fromPhone,
      text,
      providerMessageId: opts.providerMessageId,
      subject: `SMS help request from ${fromPhone}`,
    });
    return { ok: true, action: "logged" };
  }

  await logInboundSmsCommunication({
    practiceId: loc.practiceId,
    clientId,
    provider: opts.provider,
    fromPhone,
    text,
    providerMessageId: opts.providerMessageId,
  });

  return { ok: true, action: "logged" };
}
