import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@openpims/db/client";
import {
  clients,
  communications,
  locationMessaging,
  locations,
  practices,
  smsConsentEvents,
  smsSuppressions,
} from "@openpims/db";
import { latestAssignedToForClient } from "@/lib/communications/assignment";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { withSystem } from "@/lib/tenant-db";
import { inboundSmsOptInEvidence, SMS_INBOUND_OPT_IN } from "./consent";
import {
  appendSmsConsentEventInTransaction,
  inboundSmsConsentEventKey,
} from "./consent-events";
import { normalizeE164 } from "./phone";
import {
  acquireSmsRecipientLockInTransaction,
  revokeSmsConsentAfterRecipientLockInTransaction,
} from "./suppression";

export type InboundSmsProvider = "telnyx" | "twilio";
export type InboundSmsAction =
  | "ignored"
  | "suppressed"
  | "unsuppressed"
  | "logged";
export type InboundSmsClassification = "stop" | "start" | "help" | "other";

type InboundProjectionResult = { ok: true; action: InboundSmsAction };
type InboundConsentDecision = {
  action: "granted" | "revoked";
  occurredAt: Date;
};

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
    /^(?:please |kindly )?unsubscribe(?: me)?$/,
    /^(?:please |kindly )?(?:revoke|withdraw) (?:my )?(?:sms |text |texting )?consent$/,
    /^(?:please |kindly )?opt me out(?: of (?:texts|text messages|sms messages))?$/,
    /^(?:please |kindly )?i (?:do not|don['’]t) want (?:any )?(?:more|further) (?:texts|text messages|sms messages)$/,
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
  return `${prefix}${createHash("sha256")
    .update(providerMessageId)
    .digest("hex")}`;
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

async function findMessagingLocationsMatching(
  tx: Database,
  provider: InboundSmsProvider,
  matchCondition: SQL,
): Promise<Array<{ practiceId: string; locationId: string }>> {
  return tx
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
      ),
    )
    .limit(100);
}

async function findMessagingLocationMatching(
  tx: Database,
  provider: InboundSmsProvider,
  matchCondition: SQL,
): Promise<{ practiceId: string; locationId: string } | null> {
  const matches = await findMessagingLocationsMatching(
    tx,
    provider,
    matchCondition,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export type MessagingWebhookIdentityCandidates = {
  practiceIds: string[];
  location: { practiceId: string; locationId: string } | null;
};

/** Lock the exact active provider identity after its practice lock is held. */
export async function lockMessagingLocationIdentityInTransaction(
  tx: Database,
  opts: {
    practiceId: string;
    locationId: string;
    senderE164?: string | null;
    messagingProfileId?: string | null;
    provider: InboundSmsProvider;
  },
): Promise<boolean> {
  const rawSender = nonBlank(opts.senderE164);
  const sender = rawSender ? normalizeE164(rawSender) : null;
  const messagingProfileId = nonBlank(opts.messagingProfileId);
  if ((rawSender && !sender) || (!sender && !messagingProfileId)) return false;
  const [locked] = await tx
    .select({ id: locationMessaging.id })
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
        eq(locationMessaging.practiceId, opts.practiceId),
        eq(locationMessaging.locationId, opts.locationId),
        eq(locationMessaging.provider, opts.provider),
        isNull(locationMessaging.deletedAt),
        sender
          ? sql`trim(${locationMessaging.senderE164}) = ${sender}`
          : sql`true`,
        messagingProfileId
          ? sql`trim(${locationMessaging.messagingProfileId}) = ${messagingProfileId}`
          : sql`true`,
      ),
    )
    .limit(1)
    .for("share");
  return Boolean(locked);
}

/**
 * Preserve every exact sender/profile candidate for locking and STOP safety,
 * while attributing only when all supplied identities uniquely agree.
 */
export async function findMessagingLocationCandidatesForWebhookInTransaction(
  tx: Database,
  opts: {
    senderE164?: string | null;
    messagingProfileId?: string | null;
    provider: InboundSmsProvider;
  },
): Promise<MessagingWebhookIdentityCandidates> {
  const rawSender = nonBlank(opts.senderE164);
  const sender = rawSender ? normalizeE164(rawSender) : null;
  const messagingProfileId = nonBlank(opts.messagingProfileId);
  const senderMatches = sender
    ? await findMessagingLocationsMatching(
        tx,
        opts.provider,
        sql`trim(${locationMessaging.senderE164}) = ${sender}`,
      )
    : [];
  const profileMatches = messagingProfileId
    ? await findMessagingLocationsMatching(
        tx,
        opts.provider,
        sql`trim(${locationMessaging.messagingProfileId}) = ${messagingProfileId}`,
      )
    : [];
  const practiceIds = [
    ...new Set(
      [...senderMatches, ...profileMatches].map((match) => match.practiceId),
    ),
  ].sort();

  if (rawSender && messagingProfileId) {
    const senderMatch = senderMatches.length === 1 ? senderMatches[0]! : null;
    const profileMatch =
      profileMatches.length === 1 ? profileMatches[0]! : null;
    return {
      practiceIds,
      location:
        senderMatch &&
        profileMatch &&
        senderMatch.practiceId === profileMatch.practiceId &&
        senderMatch.locationId === profileMatch.locationId
          ? senderMatch
          : null,
    };
  }
  const matches = rawSender ? senderMatches : profileMatches;
  return {
    practiceIds,
    location: matches.length === 1 ? matches[0]! : null,
  };
}

/** Resolve sender and messaging profile as one exact, active identity. */
export async function findMessagingLocationForWebhookInTransaction(
  tx: Database,
  opts: {
    senderE164?: string | null;
    messagingProfileId?: string | null;
    provider: InboundSmsProvider;
  },
): Promise<{ practiceId: string; locationId: string } | null> {
  return (
    await findMessagingLocationCandidatesForWebhookInTransaction(tx, opts)
  ).location;
}

export async function findMessagingLocationBySender(
  senderE164: string,
  provider: InboundSmsProvider,
): Promise<{ practiceId: string; locationId: string } | null> {
  const sender = normalizeE164(senderE164);
  if (!sender) return null;
  return withSystem(db, (tx) =>
    findMessagingLocationMatching(
      tx,
      provider,
      sql`trim(${locationMessaging.senderE164}) = ${sender}`,
    ),
  );
}

export async function findMessagingLocationForWebhook(opts: {
  senderE164?: string | null;
  messagingProfileId?: string | null;
  provider: InboundSmsProvider;
}): Promise<{ practiceId: string; locationId: string } | null> {
  return withSystem(db, (tx) =>
    findMessagingLocationForWebhookInTransaction(tx, opts),
  );
}

export async function findClientIdByPhoneInTransaction(
  tx: Database,
  practiceId: string,
  e164: string,
): Promise<string | null> {
  const phoneCondition = normalizedClientPhoneCondition(e164);
  if (!phoneCondition) return null;
  const matches = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.practiceId, practiceId),
        isNull(clients.deletedAt),
        phoneCondition,
      ),
    )
    .limit(2);
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/** Best-effort: find the only active client in the practice matching this phone. */
export async function findClientIdByPhone(
  practiceId: string,
  e164: string,
): Promise<string | null> {
  return withSystem(db, (tx) =>
    findClientIdByPhoneInTransaction(tx, practiceId, e164),
  );
}

async function latestInboundConsentDecisionInTransaction(
  tx: Database,
  practiceId: string,
  destinationE164: string,
): Promise<InboundConsentDecision | null> {
  const [latest] = await tx
    .select({
      action: smsConsentEvents.action,
      occurredAt: smsConsentEvents.occurredAt,
    })
    .from(smsConsentEvents)
    .where(
      and(
        eq(smsConsentEvents.practiceId, practiceId),
        eq(smsConsentEvents.destinationE164, destinationE164),
        eq(smsConsentEvents.actorType, "client"),
      ),
    )
    .orderBy(
      desc(smsConsentEvents.occurredAt),
      desc(smsConsentEvents.createdAt),
      desc(smsConsentEvents.id),
    )
    .limit(1);
  return latest ?? null;
}

function isStaleInboundConsentDecision(
  latest: InboundConsentDecision | null,
  incomingAction: "granted" | "revoked",
  incomingOccurredAt: Date,
): boolean {
  if (!latest) return false;
  const delta = incomingOccurredAt.getTime() - latest.occurredAt.getTime();
  if (delta < 0) return true;
  return (
    delta === 0 && latest.action === "revoked" && incomingAction === "granted"
  );
}

async function applyInboundSmsOptInInTransaction(
  tx: Database,
  opts: {
    practiceId: string;
    locationId: string;
    provider: InboundSmsProvider;
    providerMessageId: string;
    phone: string;
    keyword: string;
    occurredAt: Date;
    latestDecision: InboundConsentDecision | null;
  },
): Promise<{
  clientId: string | null;
  remainsSuppressed: boolean;
  stale: boolean;
}> {
  const destination = normalizeE164(opts.phone);
  const phoneCondition = normalizedClientPhoneCondition(opts.phone);
  if (!destination || !phoneCondition) {
    return { clientId: null, remainsSuppressed: true, stale: false };
  }

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
    .limit(1)
    .for("update");

  const disclosure = inboundSmsOptInEvidence(opts.keyword);
  const stale = isStaleInboundConsentDecision(
    opts.latestDecision,
    "granted",
    opts.occurredAt,
  );
  const eventInserted = await appendSmsConsentEventInTransaction(tx, {
    practiceId: opts.practiceId,
    clientId,
    locationId: opts.locationId,
    destinationE164: destination,
    action: "granted",
    source: SMS_INBOUND_OPT_IN.source,
    disclosureVersion: SMS_INBOUND_OPT_IN.version,
    disclosure,
    detail: "Inbound SMS opt-in received.",
    actorType: "client",
    provider: opts.provider,
    providerMessageId: opts.providerMessageId,
    eventKey: inboundSmsConsentEventKey(
      opts.provider,
      opts.providerMessageId,
      "granted",
    ),
    occurredAt: opts.occurredAt,
  });

  if (
    !eventInserted ||
    stale ||
    (suppression && suppression.reason !== "stop")
  ) {
    return { clientId, remainsSuppressed: Boolean(suppression), stale };
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
        smsConsentAt: opts.occurredAt,
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
  return { clientId, remainsSuppressed: false, stale: false };
}

export async function logInboundSmsCommunicationInTransaction(
  tx: Database,
  opts: {
    practiceId: string;
    clientId: string | null;
    provider: InboundSmsProvider;
    fromPhone: string;
    text: string;
    providerMessageId: string | null;
    occurredAt: Date;
    subject?: string;
  },
): Promise<void> {
  await tx
    .insert(communications)
    .values({
      practiceId: opts.practiceId,
      clientId: opts.clientId ?? undefined,
      channel: "sms",
      direction: "inbound",
      subject: opts.subject ?? `SMS from ${opts.fromPhone}`,
      content: opts.text,
      status: "delivered",
      createdAt: opts.occurredAt,
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
    .onConflictDoNothing({ target: communications.dedupeKey });
}

/**
 * Project an already-attributed inbound message inside the durable provider
 * event transaction. The caller must hold the practice row before calling;
 * this function then takes the recipient advisory lock before target rows.
 */
export async function projectInboundSmsReplyInTransaction(
  tx: Database,
  opts: {
    provider: InboundSmsProvider;
    practiceId: string;
    locationId: string;
    fromPhone: string;
    text: string;
    providerMessageId: string | null;
    classification: InboundSmsClassification;
    occurredAt: Date;
  },
): Promise<InboundProjectionResult> {
  const fromPhone = normalizeE164(opts.fromPhone);
  const text = opts.text.trim();
  if (!fromPhone || !text) return { ok: true, action: "ignored" };

  await acquireSmsRecipientLockInTransaction(tx, opts.practiceId, fromPhone);
  const latestDecision =
    opts.classification === "stop" || opts.classification === "start"
      ? await latestInboundConsentDecisionInTransaction(
          tx,
          opts.practiceId,
          fromPhone,
        )
      : null;
  const keyword = normalizedKeyword(text);

  if (opts.classification === "stop") {
    const providerMessageId = opts.providerMessageId;
    if (!providerMessageId) return { ok: true, action: "ignored" };

    const stale = isStaleInboundConsentDecision(
      latestDecision,
      "revoked",
      opts.occurredAt,
    );
    if (stale) {
      await appendSmsConsentEventInTransaction(tx, {
        practiceId: opts.practiceId,
        locationId: opts.locationId,
        destinationE164: fromPhone,
        action: "revoked",
        source: "inbound_opt_out:v1",
        detail: "Inbound SMS opt-out received; current state was newer.",
        actorType: "client",
        provider: opts.provider,
        providerMessageId,
        eventKey: inboundSmsConsentEventKey(
          opts.provider,
          providerMessageId,
          "revoked",
        ),
        occurredAt: opts.occurredAt,
      });
    } else {
      await revokeSmsConsentAfterRecipientLockInTransaction(tx, {
        practiceId: opts.practiceId,
        locationId: opts.locationId,
        phone: fromPhone,
        reason: "stop",
        detail: "Inbound SMS opt-out received.",
        evidence: {
          clientId: null,
          locationId: opts.locationId,
          source: "inbound_opt_out:v1",
          detail: "Inbound SMS opt-out received.",
          actorType: "client",
          provider: opts.provider,
          providerMessageId,
          eventKey: inboundSmsConsentEventKey(
            opts.provider,
            providerMessageId,
            "revoked",
          ),
          occurredAt: opts.occurredAt,
        },
      });
    }
    const clientId = await findClientIdByPhoneInTransaction(
      tx,
      opts.practiceId,
      fromPhone,
    );
    await logInboundSmsCommunicationInTransaction(tx, {
      practiceId: opts.practiceId,
      clientId,
      provider: opts.provider,
      fromPhone,
      text,
      providerMessageId,
      occurredAt: opts.occurredAt,
      subject: `SMS opt-out from ${fromPhone}`,
    });
    return { ok: true, action: stale ? "logged" : "suppressed" };
  }

  if (opts.classification === "start") {
    const providerMessageId = opts.providerMessageId;
    if (!providerMessageId) return { ok: true, action: "ignored" };
    const optIn = await applyInboundSmsOptInInTransaction(tx, {
      practiceId: opts.practiceId,
      locationId: opts.locationId,
      provider: opts.provider,
      providerMessageId,
      phone: fromPhone,
      keyword,
      occurredAt: opts.occurredAt,
      latestDecision,
    });
    await logInboundSmsCommunicationInTransaction(tx, {
      practiceId: opts.practiceId,
      clientId: optIn.clientId,
      provider: opts.provider,
      fromPhone,
      text,
      providerMessageId,
      occurredAt: opts.occurredAt,
      subject: optIn.remainsSuppressed
        ? `SMS opt-in blocked for ${fromPhone}`
        : `SMS opt-in from ${fromPhone}`,
    });
    return {
      ok: true,
      action: optIn.remainsSuppressed ? "suppressed" : "unsuppressed",
    };
  }

  const clientId = await findClientIdByPhoneInTransaction(
    tx,
    opts.practiceId,
    fromPhone,
  );
  await logInboundSmsCommunicationInTransaction(tx, {
    practiceId: opts.practiceId,
    clientId,
    provider: opts.provider,
    fromPhone,
    text,
    providerMessageId: opts.providerMessageId,
    occurredAt: opts.occurredAt,
    ...(opts.classification === "help"
      ? { subject: `SMS help request from ${fromPhone}` }
      : {}),
  });
  return { ok: true, action: "logged" };
}

/** Compatibility entry point. Webhook routes use the durable event inbox. */
export async function handleInboundSmsReply(opts: {
  provider: InboundSmsProvider;
  fromPhone: string;
  toPhone?: string | null;
  text: string;
  providerMessageId: string | null;
  messagingProfileId?: string | null;
  classification?: InboundSmsClassification;
  occurredAt?: Date;
}): Promise<InboundProjectionResult> {
  const fromPhone = normalizeE164(opts.fromPhone);
  const toPhone = opts.toPhone ? normalizeE164(opts.toPhone) : null;
  const text = opts.text.trim();
  if (!fromPhone || !text || (!toPhone && !nonBlank(opts.messagingProfileId))) {
    return { ok: true, action: "ignored" };
  }

  return withSystem(db, async (tx) => {
    const identity = {
      senderE164: toPhone,
      messagingProfileId: opts.messagingProfileId,
      provider: opts.provider,
    } as const;
    const candidate = await findMessagingLocationForWebhookInTransaction(
      tx,
      identity,
    );
    if (!candidate) return { ok: true, action: "ignored" };
    if (!(await lockPracticeForExternalSideEffects(tx, candidate.practiceId))) {
      return { ok: true, action: "ignored" };
    }
    if (
      !(await lockMessagingLocationIdentityInTransaction(tx, {
        ...identity,
        practiceId: candidate.practiceId,
        locationId: candidate.locationId,
      }))
    ) {
      return { ok: true, action: "ignored" };
    }
    const revalidated = await findMessagingLocationForWebhookInTransaction(
      tx,
      identity,
    );
    if (
      !revalidated ||
      revalidated.practiceId !== candidate.practiceId ||
      revalidated.locationId !== candidate.locationId
    ) {
      return { ok: true, action: "ignored" };
    }
    return projectInboundSmsReplyInTransaction(tx, {
      provider: opts.provider,
      practiceId: revalidated.practiceId,
      locationId: revalidated.locationId,
      fromPhone,
      text,
      providerMessageId: opts.providerMessageId,
      classification: opts.classification ?? classifyInboundSms(text),
      occurredAt: opts.occurredAt ?? new Date(),
    });
  });
}
