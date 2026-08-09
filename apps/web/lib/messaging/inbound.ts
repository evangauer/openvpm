import { createHash } from "node:crypto";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  clients,
  communications,
  locationMessaging,
  locations,
  practices,
} from "@openpims/db";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { normalizeE164 } from "./phone";
import {
  isSuppressed,
  removeSuppression,
  revokeSmsConsentByPhone,
} from "./suppression";
import { inboundSmsOptInEvidence, SMS_INBOUND_OPT_IN } from "./consent";
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
  providerMessageId: string | null
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
    sql`regexp_replace(${clients.phone}, '\D', '', 'g') = ${nationalDigits}`
  )!;
}

async function findMessagingLocationMatching(
  provider: InboundSmsProvider,
  matchCondition: SQL
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
          isNull(locations.deletedAt)
        )
      )
      .innerJoin(
        practices,
        and(
          eq(practices.id, locationMessaging.practiceId),
          isNull(practices.deletedAt)
        )
      )
      .where(
        and(
          matchCondition,
          eq(locationMessaging.provider, provider),
          isNull(locationMessaging.deletedAt),
          eq(locations.practiceId, locationMessaging.practiceId),
          isNull(locations.deletedAt)
        )
      )
      .limit(2)
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function findMessagingLocationBySender(
  senderE164: string,
  provider: InboundSmsProvider
): Promise<{ practiceId: string; locationId: string } | null> {
  const sender = normalizeE164(senderE164);
  if (!sender) return null;
  return findMessagingLocationMatching(
    provider,
    sql`trim(${locationMessaging.senderE164}) = ${sender}`
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
      sql`trim(${locationMessaging.senderE164}) = ${sender}`
    );
    if (loc) return loc;
  }

  if (!messagingProfileId) return null;
  return findMessagingLocationMatching(
    opts.provider,
    sql`trim(${locationMessaging.messagingProfileId}) = ${messagingProfileId}`
  );
}

/** Best-effort: find the only active client in the practice matching this phone. */
export async function findClientIdByPhone(
  practiceId: string,
  e164: string
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
          phoneCondition
        )
      )
      .limit(2)
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/** Flip a client's SMS consent flag after carrier opt-out / opt-in callbacks. */
export async function setClientSmsConsentByPhone(
  practiceId: string,
  e164: string,
  consent: boolean,
  matchedClientId?: string | null,
  optInKeyword?: string
): Promise<void> {
  const phoneCondition = normalizedClientPhoneCondition(e164);
  if (!phoneCondition) return;

  if (consent) {
    const clientId =
      matchedClientId === undefined
        ? await findClientIdByPhone(practiceId, e164)
        : matchedClientId;
    if (!clientId) return;

    await withSystem(db, (tx) =>
      tx
        .update(clients)
        .set({
          smsConsent: true,
          smsConsentAt: new Date(),
          smsConsentSource: SMS_INBOUND_OPT_IN.source,
          smsConsentDisclosure: inboundSmsOptInEvidence(
            optInKeyword ?? "START"
          ),
        })
        .where(
          and(
            eq(clients.id, clientId),
            eq(clients.practiceId, practiceId),
            isNull(clients.deletedAt)
          )
        )
    );
    return;
  }

  await withSystem(db, (tx) =>
    tx
      .update(clients)
      .set({
        smsConsent: false,
        smsConsentAt: null,
        smsConsentSource: null,
        smsConsentDisclosure: null,
      })
      .where(
        and(
          eq(clients.practiceId, practiceId),
          isNull(clients.deletedAt),
          phoneCondition
        )
      )
  );
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
                opts.clientId
              ),
            }
          : {}),
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
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
  const clientId = await findClientIdByPhone(loc.practiceId, fromPhone);
  if (classification === "stop") {
    await revokeSmsConsentByPhone({
      practiceId: loc.practiceId,
      locationId: loc.locationId,
      phone: fromPhone,
      reason: "stop",
      detail: `Inbound opt-out: "${text}"`,
    });
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
    await removeSuppression(loc.practiceId, fromPhone);
    // START can remove only a carrier STOP. A manual, complaint, or bounce
    // suppression remains authoritative and must not silently restore consent.
    const remainsSuppressed = await isSuppressed(loc.practiceId, fromPhone);
    if (!remainsSuppressed) {
      await setClientSmsConsentByPhone(
        loc.practiceId,
        fromPhone,
        true,
        clientId,
        keyword
      );
    }
    await logInboundSmsCommunication({
      practiceId: loc.practiceId,
      clientId,
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
