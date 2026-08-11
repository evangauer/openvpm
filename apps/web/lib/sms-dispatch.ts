import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import {
  clients,
  communications,
  locationMessaging,
  messagingRegistrations,
  practices,
  smsSendAttemptEvents,
  smsSendAttempts,
  smsSuppressions,
  users,
} from "@openpims/db";
import { recordUsage } from "@/lib/billing/usage";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { envFlagEnabled } from "@/lib/env-bool";
import {
  acquireSmsRecipientLockInTransaction,
  getMessagingProvider,
  normalizeE164,
  resolveMessagingTransport,
} from "@/lib/messaging";
import type {
  MessagingProvider,
  MessagingSender,
  SendMessageResult,
} from "@/lib/messaging/types";
import {
  hostedMessagingLaunchBlockMessage,
  hostedMessagingLaunchDecision,
} from "@/lib/messaging/launch-gate";
import { withSystem } from "@/lib/tenant-db";
import { envValue } from "@/lib/messaging/env";
import { alertOps } from "@/lib/alerts";
import {
  lockSmsDeliveryIdentity,
  processPendingDeliveryEvidenceForAcceptedSend,
} from "@/lib/messaging/sms-delivery-ledger";
import {
  lockPracticeForExternalSideEffects,
  practiceAllowsExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { isQuietHours } from "@/lib/messaging/reminders";

export const SMS_COMPLIANCE_FOOTER = "Reply STOP to opt out or HELP for help.";
export const SMS_MAX_BODY_LENGTH = 1600;
export const SMS_AMBIGUITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const SMS_RECONCILIATION_STALE_MS = 15 * 60 * 1000;

const EMBEDDED_COMPLIANCE_COPY =
  /\breply\s+(?:stop|help)\b|\bstop\s+to\s+opt\s*out\b|\bhelp\s+for\s+help\b/i;

export type SmsDispatchOutcome =
  | "accepted"
  | "definite_failure"
  | "outcome_unknown";

export type SmsDispatchResult =
  | {
      success: true;
      outcome: "accepted";
      sid: string;
      attemptId: string;
      replayed: boolean;
      error?: undefined;
    }
  | {
      success: false;
      outcome: "definite_failure" | "outcome_unknown";
      sid?: undefined;
      attemptId?: string;
      replayed: boolean;
      error: string;
    };

export type SmsSendOptions = {
  to: string;
  /** Message content only. Clinic identity and compliance footer are canonical. */
  body: string;
  practiceId: string;
  locationId?: string;
  clientId?: string;
  communicationId?: string;
  source?: string;
  sourceId?: string;
  idempotencyKey?: string;
};

type AttemptRow = typeof smsSendAttempts.$inferSelect;
type AttemptEventRow = typeof smsSendAttemptEvents.$inferSelect;

type PreparedDispatch = {
  to: string;
  body: string;
  registeredDisplayName: string;
  practiceId: string;
  locationId?: string;
  clientId?: string;
  communicationId?: string;
  source: string;
  sourceId: string;
  idempotencyKey: string;
  resendOfAttemptId?: string;
  expectedProvider: MessagingProvider["name"];
  requestedBy?: {
    actorType: "clinic_user" | "platform_operator";
    actorUserId?: string;
    identity: string;
    name: string;
  };
};

function boundedDetail(detail: string): string {
  return detail.slice(0, 2000);
}

function failure(
  error: string,
  opts: {
    outcome?: "definite_failure" | "outcome_unknown";
    attemptId?: string;
    replayed?: boolean;
  } = {},
): SmsDispatchResult {
  return {
    success: false,
    outcome: opts.outcome ?? "definite_failure",
    attemptId: opts.attemptId,
    replayed: opts.replayed ?? false,
    error,
  };
}

function accepted(
  attemptId: string,
  sid: string,
  replayed: boolean,
): SmsDispatchResult {
  return {
    success: true,
    outcome: "accepted",
    sid,
    attemptId,
    replayed,
  };
}

export function prepareCampaignSmsBody(input: {
  registeredDisplayName: string;
  content: string;
}): { success: true; body: string } | { success: false; error: string } {
  const displayName = input.registeredDisplayName.trim();
  let content = input.content.trim();
  if (!displayName) {
    return {
      success: false,
      error: "Registered clinic display name is blank.",
    };
  }
  if (!content) {
    return { success: false, error: "SMS message content cannot be blank." };
  }
  if (EMBEDDED_COMPLIANCE_COPY.test(content)) {
    return {
      success: false,
      error:
        "Do not add STOP or HELP instructions; OpenVPM adds the registered compliance footer automatically.",
    };
  }
  const repeatedPrefix = `${displayName}:`;
  if (
    content.toLocaleLowerCase().startsWith(repeatedPrefix.toLocaleLowerCase())
  ) {
    content = content.slice(repeatedPrefix.length).trim();
  }
  const body = `${displayName}: ${content} ${SMS_COMPLIANCE_FOOTER}`;
  if (body.length > SMS_MAX_BODY_LENGTH) {
    return {
      success: false,
      error: `Final SMS body exceeds ${SMS_MAX_BODY_LENGTH} characters after clinic identity and compliance copy are added.`,
    };
  }
  return { success: true, body };
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function stableDirectKey(opts: {
  practiceId: string;
  locationId?: string;
  clientId?: string;
  communicationId?: string;
  to: string;
  body: string;
}): string {
  const digest = bodyHash(
    [
      opts.practiceId,
      opts.locationId ?? "",
      opts.clientId ?? "",
      opts.communicationId ?? "",
      opts.to,
      opts.body,
    ].join("\n"),
  );
  return `direct:${digest}`;
}

function validBoundedIdentity(value: string, max: number): boolean {
  const length = value.trim().length;
  return length > 0 && length <= max;
}

async function registeredDisplayName(
  practiceId: string,
  provider: MessagingProvider["name"],
): Promise<string | undefined> {
  const [registration] = await withSystem(db, (tx) =>
    tx
      .select({ displayName: messagingRegistrations.displayName })
      .from(messagingRegistrations)
      .where(
        and(
          eq(messagingRegistrations.practiceId, practiceId),
          eq(messagingRegistrations.provider, provider),
          eq(messagingRegistrations.status, "active"),
          isNull(messagingRegistrations.deletedAt),
        ),
      )
      .limit(1),
  );
  return registration?.displayName?.trim() || undefined;
}

async function campaignDisplayName(options: {
  practiceId: string;
  provider: MessagingProvider["name"];
  hostedExternalSend: boolean;
}): Promise<string | undefined> {
  const registered = await registeredDisplayName(
    options.practiceId,
    options.provider,
  );
  if (registered) return registered;
  if (options.hostedExternalSend) return undefined;

  // A self-hosted real provider may be configured outside OpenVPM. Require the
  // operator to snapshot the exact carrier-registered identity explicitly.
  if (options.provider !== "console") {
    const configured = envValue("MESSAGING_REGISTERED_DISPLAY_NAME")?.trim();
    return configured && configured.length <= 100 ? configured : undefined;
  }

  // Console transport cannot reach a carrier. Practice name is safe for local
  // testing and is still snapshotted in the durable attempt.
  const [practice] = await withSystem(db, (tx) =>
    tx
      .select({ name: practices.name })
      .from(practices)
      .where(
        and(eq(practices.id, options.practiceId), isNull(practices.deletedAt)),
      )
      .limit(1),
  );
  const name = practice?.name.trim();
  return name && name.length <= 100 ? name : undefined;
}

function normalizeProviderResult(result: SendMessageResult): SendMessageResult {
  if (result.status !== "accepted") return result;
  const id = result.id.trim();
  return id
    ? { status: "accepted", id }
    : {
        status: "outcome_unknown",
        error: "Provider returned acceptance without a message id.",
      };
}

function eventToDispatchResult(
  attemptId: string,
  event: Pick<AttemptEventRow, "outcome" | "providerMessageId" | "detail">,
  replayed: boolean,
): SmsDispatchResult {
  if (event.outcome === "accepted" && event.providerMessageId?.trim()) {
    return accepted(attemptId, event.providerMessageId.trim(), replayed);
  }
  return failure(
    event.detail?.trim() ||
      (event.outcome === "outcome_unknown"
        ? "Provider outcome is unknown. Do not resend until an operator reconciles this attempt."
        : "SMS delivery was rejected before provider acceptance."),
    {
      outcome: event.outcome === "accepted" ? "outcome_unknown" : event.outcome,
      attemptId,
      replayed,
    },
  );
}

function effectiveEvent(
  events: Array<
    Pick<AttemptEventRow, "kind" | "outcome" | "providerMessageId" | "detail">
  >,
) {
  return (
    events.find((event) => event.kind === "reconciliation") ??
    events.find((event) => event.kind === "provider_result")
  );
}

export type SmsOpsQueueClassification =
  | "missing_provider_result"
  | "outcome_unknown";

/**
 * Pure mirror of the operator-queue classification. Events must be newest
 * first, matching the durable ledger query order.
 */
export function classifySmsAttemptForOps(input: {
  createdAt: Date;
  events: Array<
    Pick<AttemptEventRow, "kind" | "outcome" | "providerMessageId" | "detail">
  >;
  now?: Date;
}): SmsOpsQueueClassification | null {
  const now = input.now ?? new Date();
  if (input.createdAt.getTime() > now.getTime() - SMS_RECONCILIATION_STALE_MS) {
    return null;
  }
  const event = effectiveEvent(input.events);
  if (!event) return "missing_provider_result";
  return event.outcome === "outcome_unknown" ? "outcome_unknown" : null;
}

async function attemptEvents(
  tx: Database,
  practiceId: string,
  attemptId: string,
) {
  return tx
    .select({
      kind: smsSendAttemptEvents.kind,
      outcome: smsSendAttemptEvents.outcome,
      providerMessageId: smsSendAttemptEvents.providerMessageId,
      detail: smsSendAttemptEvents.detail,
    })
    .from(smsSendAttemptEvents)
    .where(
      and(
        eq(smsSendAttemptEvents.practiceId, practiceId),
        eq(smsSendAttemptEvents.attemptId, attemptId),
      ),
    )
    .orderBy(
      desc(smsSendAttemptEvents.createdAt),
      desc(smsSendAttemptEvents.id),
    );
}

function sameAttempt(
  existing: AttemptRow,
  prepared: PreparedDispatch,
  providerName: MessagingProvider["name"],
  sender: MessagingSender,
): boolean {
  return (
    existing.destinationE164 === prepared.to &&
    existing.body === prepared.body &&
    existing.bodySha256 === bodyHash(prepared.body) &&
    existing.registeredDisplayName === prepared.registeredDisplayName &&
    existing.provider === providerName &&
    existing.locationId === (prepared.locationId ?? null) &&
    existing.clientId === (prepared.clientId ?? null) &&
    existing.communicationId === (prepared.communicationId ?? null) &&
    existing.source === prepared.source &&
    existing.sourceId === prepared.sourceId &&
    existing.resendOfAttemptId === (prepared.resendOfAttemptId ?? null) &&
    existing.senderMessagingServiceId ===
      (sender.messagingServiceId?.trim() || null) &&
    existing.senderE164 === (normalizeE164(sender.from) ?? null) &&
    existing.requestedByActorType ===
      (prepared.requestedBy?.actorType ?? null) &&
    existing.requestedByUserId ===
      (prepared.requestedBy?.actorUserId ?? null) &&
    existing.requestedByIdentity ===
      (prepared.requestedBy?.identity.trim() ?? null) &&
    existing.requestedByName === (prepared.requestedBy?.name.trim() ?? null)
  );
}

async function reserveAttempt(
  prepared: PreparedDispatch,
  provider: MessagingProvider,
  sender: MessagingSender,
): Promise<
  | { winner: true; attempt: AttemptRow }
  | { winner: false; result: SmsDispatchResult }
> {
  return withSystem(db, async (tx) => {
    const [inserted] = await tx
      .insert(smsSendAttempts)
      .values({
        practiceId: prepared.practiceId,
        clientId: prepared.clientId,
        locationId: prepared.locationId,
        communicationId: prepared.communicationId,
        requestedByActorType: prepared.requestedBy?.actorType,
        requestedByUserId: prepared.requestedBy?.actorUserId,
        requestedByIdentity: prepared.requestedBy?.identity.trim(),
        requestedByName: prepared.requestedBy?.name.trim(),
        resendOfAttemptId: prepared.resendOfAttemptId,
        source: prepared.source,
        sourceId: prepared.sourceId,
        idempotencyKey: prepared.idempotencyKey,
        destinationE164: prepared.to,
        registeredDisplayName: prepared.registeredDisplayName,
        body: prepared.body,
        bodySha256: bodyHash(prepared.body),
        provider: provider.name,
        senderMessagingServiceId: sender.messagingServiceId?.trim() || null,
        senderE164: normalizeE164(sender.from) ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { winner: true as const, attempt: inserted };

    const [existing] = await tx
      .select()
      .from(smsSendAttempts)
      .where(
        and(
          eq(smsSendAttempts.practiceId, prepared.practiceId),
          eq(smsSendAttempts.idempotencyKey, prepared.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing && prepared.resendOfAttemptId) {
      const [existingResend] = await tx
        .select()
        .from(smsSendAttempts)
        .where(
          and(
            eq(smsSendAttempts.practiceId, prepared.practiceId),
            eq(smsSendAttempts.resendOfAttemptId, prepared.resendOfAttemptId),
          ),
        )
        .limit(1);
      if (existingResend) {
        const event = effectiveEvent(
          await attemptEvents(
            tx as unknown as Database,
            prepared.practiceId,
            existingResend.id,
          ),
        );
        return {
          winner: false as const,
          result: event
            ? eventToDispatchResult(existingResend.id, event, true)
            : failure(
                "An explicit resend is already in progress and has no confirmed outcome.",
                {
                  outcome: "outcome_unknown",
                  attemptId: existingResend.id,
                  replayed: true,
                },
              ),
        };
      }
    }
    if (!existing || !sameAttempt(existing, prepared, provider.name, sender)) {
      return {
        winner: false as const,
        result: failure(
          "SMS idempotency key was already used for different dispatch data; send blocked.",
          { attemptId: existing?.id, replayed: true },
        ),
      };
    }
    const event = effectiveEvent(
      await attemptEvents(
        tx as unknown as Database,
        prepared.practiceId,
        existing.id,
      ),
    );
    return {
      winner: false as const,
      result: event
        ? eventToDispatchResult(existing.id, event, true)
        : failure(
            "A prior dispatch reserved this SMS but has no confirmed provider outcome. Do not resend until an operator reconciles it.",
            {
              outcome: "outcome_unknown",
              attemptId: existing.id,
              replayed: true,
            },
          ),
    };
  });
}

async function appendProviderResult(
  tx: Database,
  attempt: AttemptRow,
  result: SendMessageResult,
): Promise<void> {
  const normalized = normalizeProviderResult(result);
  if (normalized.status === "accepted") {
    await lockSmsDeliveryIdentity(tx, attempt.provider, normalized.id);
  }
  await tx.insert(smsSendAttemptEvents).values({
    practiceId: attempt.practiceId,
    attemptId: attempt.id,
    kind: "provider_result",
    outcome: normalized.status,
    providerMessageId:
      normalized.status === "accepted" ? normalized.id : undefined,
    detail:
      normalized.status === "accepted"
        ? undefined
        : boundedDetail(normalized.error),
    eventKey: `provider-result:${attempt.id}`,
  });

  // The accepted event and its user-visible communication projection are one
  // durability unit. A crash must never leave an accepted provider result
  // hidden behind a permanently pending dedupe claim.
  if (normalized.status === "accepted" && attempt.communicationId) {
    const [projected] = await tx
      .update(communications)
      .set({ status: "sent", providerMessageId: normalized.id })
      .where(
        and(
          eq(communications.practiceId, attempt.practiceId),
          eq(communications.id, attempt.communicationId),
          sql`${communications.status} in ('pending', 'failed')`,
          isNull(communications.deletedAt),
        ),
      )
      .returning({ id: communications.id });
    if (!projected) {
      throw new Error(
        "Accepted SMS could not be projected to its linked communication",
      );
    }
  }
  if (normalized.status === "accepted") {
    await processPendingDeliveryEvidenceForAcceptedSend(
      tx,
      attempt.provider,
      normalized.id,
      { identityLockHeld: true },
    );
  }
}

async function providerCall(
  provider: MessagingProvider,
  input: { to: string; body: string; sender: MessagingSender },
): Promise<SendMessageResult> {
  try {
    return normalizeProviderResult(await provider.send(input));
  } catch (error) {
    return {
      status: "outcome_unknown",
      error:
        error instanceof Error && error.message
          ? error.message
          : "Provider request ended without a known outcome.",
    };
  }
}

async function alertUnknownSmsAttempt(
  attempt: Pick<AttemptRow, "practiceId" | "id" | "communicationId" | "source">,
): Promise<void> {
  try {
    await alertOps(
      "SMS provider outcome requires reconciliation",
      [
        `practice=${attempt.practiceId}`,
        `attempt=${attempt.id}`,
        `communication=${attempt.communicationId ?? "none"}`,
        `source=${attempt.source}`,
      ].join(" "),
    );
  } catch (error) {
    // Alerting is secondary to the durable unknown result. Never create a
    // retry signal after a potentially accepted provider request.
    console.error("[messaging] SMS unknown-outcome alert failed", error);
  }
}

async function dispatchWinner(
  attempt: AttemptRow,
  provider: MessagingProvider,
  sender: MessagingSender,
  hostedExternalSend: boolean,
): Promise<SmsDispatchResult> {
  let result: SendMessageResult;
  try {
    result = await withSystem(db, async (tx) => {
      let hostedPracticeTimezone: string | null | undefined;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sms-attempt:${attempt.practiceId}:${attempt.id}`}, 0))`,
      );
      if (
        !(await lockPracticeForExternalSideEffects(
          tx as unknown as Database,
          attempt.practiceId,
        ))
      ) {
        const rejected: SendMessageResult = {
          status: "definite_failure",
          error: RECOVERY_HOLD_BLOCK_MESSAGE,
        };
        await appendProviderResult(
          tx as unknown as Database,
          attempt,
          rejected,
        );
        return rejected;
      }
      if (hostedExternalSend) {
        const [practice] = await tx
          .select({
            tier: practices.subscriptionTier,
            billingStatus: practices.billingStatus,
            trialEndsAt: practices.trialEndsAt,
            timezone: practices.timezone,
          })
          .from(practices)
          .where(
            and(
              eq(practices.id, attempt.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .limit(1);
        if (!practice) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error: "Practice not found",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
        hostedPracticeTimezone = practice.timezone;
        if (
          !hasHostedFullAccess(
            practice.tier,
            practice.billingStatus,
            practice.trialEndsAt,
          )
        ) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "OpenVPM Cloud is read-only until your trial or subscription is active.",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
        if (isQuietHours(new Date(), practice.timezone)) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "SMS delivery is blocked during local quiet hours (9 PM–8 AM).",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
      }

      let activeLocationCampaignId: string | null = null;
      let activeLocationBrandId: string | null = null;
      if (attempt.locationId) {
        const [activeSender] = await tx
          .select({
            provider: locationMessaging.provider,
            messagingServiceId: locationMessaging.messagingProfileId,
            senderE164: locationMessaging.senderE164,
            enabled: locationMessaging.enabled,
            registrationStatus: locationMessaging.registrationStatus,
            a2pCampaignId: locationMessaging.a2pCampaignId,
            a2pBrandId: locationMessaging.a2pBrandId,
          })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.practiceId, attempt.practiceId),
              eq(locationMessaging.locationId, attempt.locationId),
              isNull(locationMessaging.deletedAt),
            ),
          )
          .limit(1)
          .for("share");
        if (
          !activeSender?.enabled ||
          activeSender.registrationStatus !== "active" ||
          activeSender.provider !== attempt.provider ||
          (activeSender.messagingServiceId?.trim() || null) !==
            attempt.senderMessagingServiceId ||
          (normalizeE164(activeSender.senderE164) ?? null) !==
            attempt.senderE164
        ) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "The location texting sender changed or became inactive before dispatch; delivery was blocked.",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
        activeLocationCampaignId = activeSender.a2pCampaignId?.trim() || null;
        activeLocationBrandId = activeSender.a2pBrandId?.trim() || null;
      }

      if (hostedExternalSend) {
        const [activeRegistration] = await tx
          .select({
            displayName: messagingRegistrations.displayName,
            providerCampaignId: messagingRegistrations.providerCampaignId,
            providerBrandId: messagingRegistrations.providerBrandId,
          })
          .from(messagingRegistrations)
          .where(
            and(
              eq(messagingRegistrations.practiceId, attempt.practiceId),
              eq(messagingRegistrations.provider, attempt.provider),
              eq(messagingRegistrations.status, "active"),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(1)
          .for("share");
        if (
          activeRegistration?.displayName?.trim() !==
            attempt.registeredDisplayName ||
          !activeRegistration.providerCampaignId?.trim() ||
          activeRegistration.providerCampaignId.trim() !==
            activeLocationCampaignId ||
          !activeRegistration.providerBrandId?.trim() ||
          activeRegistration.providerBrandId.trim() !== activeLocationBrandId
        ) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "The carrier campaign changed or became inactive before dispatch; delivery was blocked.",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
      }

      if (attempt.source === "operator_resend" && attempt.communicationId) {
        const [resendCommunication] = await tx
          .select({ status: communications.status })
          .from(communications)
          .where(
            and(
              eq(communications.practiceId, attempt.practiceId),
              eq(communications.id, attempt.communicationId),
              isNull(communications.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (resendCommunication?.status !== "failed") {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "The linked communication is no longer failed; explicit SMS resend was blocked.",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
      }

      await acquireSmsRecipientLockInTransaction(
        tx,
        attempt.practiceId,
        attempt.destinationE164,
      );

      const ambiguityCutoff = new Date(Date.now() - SMS_AMBIGUITY_LOOKBACK_MS);
      const [ambiguousPrior] = await tx
        .select({ id: smsSendAttempts.id })
        .from(smsSendAttempts)
        .where(
          and(
            eq(smsSendAttempts.practiceId, attempt.practiceId),
            eq(smsSendAttempts.destinationE164, attempt.destinationE164),
            ne(smsSendAttempts.id, attempt.id),
            gte(smsSendAttempts.createdAt, ambiguityCutoff),
            sql`(
              not exists (
                select 1 from sms_send_attempt_events unresolved_event
                where unresolved_event.practice_id = ${smsSendAttempts.practiceId}
                  and unresolved_event.attempt_id = ${smsSendAttempts.id}
              )
              or coalesce(
                (
                  select reconciled.outcome::text
                  from sms_send_attempt_events reconciled
                  where reconciled.practice_id = ${smsSendAttempts.practiceId}
                    and reconciled.attempt_id = ${smsSendAttempts.id}
                    and reconciled.kind = 'reconciliation'
                  order by reconciled.created_at desc, reconciled.id desc
                  limit 1
                ),
                (
                  select provider_result.outcome::text
                  from sms_send_attempt_events provider_result
                  where provider_result.practice_id = ${smsSendAttempts.practiceId}
                    and provider_result.attempt_id = ${smsSendAttempts.id}
                    and provider_result.kind = 'provider_result'
                  order by provider_result.created_at desc, provider_result.id desc
                  limit 1
                )
              ) = 'outcome_unknown'
            )`,
          ),
        )
        .limit(1);
      if (ambiguousPrior) {
        const rejected: SendMessageResult = {
          status: "definite_failure",
          error:
            "A recent SMS to this recipient has an unresolved provider outcome. Reconcile it before sending another message.",
        };
        await appendProviderResult(
          tx as unknown as Database,
          attempt,
          rejected,
        );
        return rejected;
      }

      if (hostedExternalSend) {
        const [client] = await tx
          .select({
            phone: clients.phone,
            smsConsent: clients.smsConsent,
            smsConsentAt: clients.smsConsentAt,
            smsConsentSource: clients.smsConsentSource,
            smsConsentDisclosure: clients.smsConsentDisclosure,
          })
          .from(clients)
          .where(
            and(
              eq(clients.id, attempt.clientId!),
              eq(clients.practiceId, attempt.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .limit(1)
          .for("share");
        if (
          !client?.smsConsent ||
          !client.smsConsentAt ||
          !client.smsConsentSource?.trim() ||
          !client.smsConsentDisclosure?.trim() ||
          normalizeE164(client.phone) !== attempt.destinationE164
        ) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error:
              "Client SMS consent or phone changed before sending; delivery was blocked.",
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
      }

      const [suppression] = await tx
        .select({ id: smsSuppressions.id })
        .from(smsSuppressions)
        .where(
          and(
            eq(smsSuppressions.practiceId, attempt.practiceId),
            eq(smsSuppressions.phone, attempt.destinationE164),
            isNull(smsSuppressions.deletedAt),
          ),
        )
        .limit(1);
      if (suppression) {
        const rejected: SendMessageResult = {
          status: "definite_failure",
          error: "Recipient has opted out of SMS (STOP).",
        };
        await appendProviderResult(
          tx as unknown as Database,
          attempt,
          rejected,
        );
        return rejected;
      }

      if (hostedExternalSend) {
        const launch = hostedMessagingLaunchDecision({
          practiceId: attempt.practiceId,
          locationId: attempt.locationId ?? undefined,
        });
        if (!launch.allowed) {
          const rejected: SendMessageResult = {
            status: "definite_failure",
            error: hostedMessagingLaunchBlockMessage(launch.reason),
          };
          await appendProviderResult(
            tx as unknown as Database,
            attempt,
            rejected,
          );
          return rejected;
        }
      }

      // Locks, sender/consent reads, and operator review can span the quiet-
      // hours boundary. Recheck at the last possible instant before transport.
      if (
        hostedExternalSend &&
        isQuietHours(new Date(), hostedPracticeTimezone)
      ) {
        const rejected: SendMessageResult = {
          status: "definite_failure",
          error:
            "SMS delivery is blocked during local quiet hours (9 PM–8 AM).",
        };
        await appendProviderResult(
          tx as unknown as Database,
          attempt,
          rejected,
        );
        return rejected;
      }

      const providerResult = await providerCall(provider, {
        to: attempt.destinationE164,
        body: attempt.body,
        sender,
      });
      await appendProviderResult(
        tx as unknown as Database,
        attempt,
        providerResult,
      );
      return providerResult;
    });
  } catch (error) {
    console.error("[messaging] SMS outcome persistence failed", error);
    await alertUnknownSmsAttempt(attempt);
    return failure(
      "SMS dispatch was reserved, but its provider outcome could not be persisted. Do not resend until an operator reconciles it.",
      { outcome: "outcome_unknown", attemptId: attempt.id },
    );
  }

  if (result.status === "outcome_unknown") {
    await alertUnknownSmsAttempt(attempt);
  }

  if (result.status === "accepted") {
    if (provider.name !== "console") {
      try {
        await recordUsage({ practiceId: attempt.practiceId, kind: "sms" });
      } catch (error) {
        // Delivery is already accepted and durable. Never turn a metering error
        // into a retry signal that could duplicate the message.
        console.error("[messaging] accepted SMS usage metering failed", error);
      }
    }
    return accepted(attempt.id, result.id, false);
  }
  return failure(result.error, {
    outcome: result.status,
    attemptId: attempt.id,
  });
}

async function dispatchPreparedSms(
  prepared: PreparedDispatch,
): Promise<SmsDispatchResult> {
  const hostedBilling = billingEnforced();
  const demoMode = envFlagEnabled("NEXT_PUBLIC_DEMO_MODE");
  const hostedExternalSend = hostedBilling && !demoMode;

  if (hostedExternalSend) {
    const launch = hostedMessagingLaunchDecision(prepared);
    if (!launch.allowed) {
      return failure(hostedMessagingLaunchBlockMessage(launch.reason));
    }
    if (!prepared.clientId) {
      return failure("Hosted SMS requires an explicit consented client.");
    }
  }

  if (
    !prepared.locationId &&
    getMessagingProvider().name === "console" &&
    hostedExternalSend
  ) {
    return failure("SMS provider is not configured for hosted sending.");
  }

  const transport = await resolveMessagingTransport({
    practiceId: prepared.practiceId,
    locationId: prepared.locationId,
    hosted: hostedExternalSend,
  });
  if (prepared.locationId && !transport) {
    return failure("No active texting sender is configured for this location.");
  }
  if (!transport) return failure("SMS provider is not configured.");

  const { provider, sender } = transport;
  if (provider.name !== prepared.expectedProvider) {
    return failure(
      "Messaging transport changed while preparing the SMS; send blocked.",
    );
  }
  if (hostedExternalSend && provider.name !== "telnyx") {
    return failure(
      "Hosted texting is available only through the approved Telnyx pilot.",
    );
  }
  if (provider.name === "console" && hostedExternalSend) {
    return failure("SMS provider is not configured for hosted sending.");
  }

  const currentDisplayName = await campaignDisplayName({
    practiceId: prepared.practiceId,
    provider: provider.name,
    hostedExternalSend,
  });
  if (currentDisplayName !== prepared.registeredDisplayName) {
    return failure(
      "Active carrier registration changed while preparing the SMS; send blocked.",
    );
  }

  let reservation:
    | { winner: true; attempt: AttemptRow }
    | { winner: false; result: SmsDispatchResult };
  try {
    reservation = await reserveAttempt(prepared, provider, sender);
  } catch (error) {
    console.error("[messaging] SMS attempt reservation failed", error);
    return failure("Could not durably reserve SMS dispatch; send blocked.");
  }
  if (!reservation.winner) return reservation.result;
  return dispatchWinner(
    reservation.attempt,
    provider,
    sender,
    hostedExternalSend,
  );
}

async function sendSmsInternal(
  options: SmsSendOptions,
): Promise<SmsDispatchResult> {
  const recipient = normalizeE164(options.to);
  if (!recipient) {
    return failure(
      "SMS recipient phone number must be a valid E.164 or US/CA number.",
    );
  }

  const source = options.source?.trim() || "direct";
  const provisionalKey =
    options.idempotencyKey?.trim() ||
    stableDirectKey({ ...options, to: recipient });
  const sourceId = options.sourceId?.trim() || provisionalKey;
  if (
    !validBoundedIdentity(source, 64) ||
    !validBoundedIdentity(sourceId, 200) ||
    !validBoundedIdentity(provisionalKey, 200)
  ) {
    return failure(
      "SMS source and idempotency values must be nonblank and bounded.",
    );
  }

  if (!(await practiceAllowsExternalSideEffects(db, options.practiceId))) {
    return failure(RECOVERY_HOLD_BLOCK_MESSAGE);
  }

  const hostedExternalSend =
    billingEnforced() && !envFlagEnabled("NEXT_PUBLIC_DEMO_MODE");
  if (hostedExternalSend) {
    const launch = hostedMessagingLaunchDecision(options);
    if (!launch.allowed) {
      return failure(hostedMessagingLaunchBlockMessage(launch.reason));
    }
    if (!options.clientId) {
      return failure("Hosted SMS requires an explicit consented client.");
    }
  }
  const initialTransport = await resolveMessagingTransport({
    practiceId: options.practiceId,
    locationId: options.locationId,
    hosted: hostedExternalSend,
  });
  if (!initialTransport) {
    return failure(
      options.locationId
        ? "No active texting sender is configured for this location."
        : "SMS provider is not configured.",
    );
  }

  let displayName: string | undefined;
  try {
    displayName = await campaignDisplayName({
      practiceId: options.practiceId,
      provider: initialTransport.provider.name,
      hostedExternalSend,
    });
  } catch (error) {
    console.error("[messaging] registration display name lookup failed", error);
  }
  if (!displayName) {
    return failure(
      hostedExternalSend
        ? "Complete active carrier registration before sending clinic text messages."
        : "Set MESSAGING_REGISTERED_DISPLAY_NAME to the exact carrier-registered clinic name before sending text messages.",
    );
  }
  const preparedBody = prepareCampaignSmsBody({
    registeredDisplayName: displayName,
    content: options.body,
  });
  if (!preparedBody.success) return failure(preparedBody.error);

  const result = await dispatchPreparedSms({
    to: recipient,
    body: preparedBody.body,
    registeredDisplayName: displayName,
    practiceId: options.practiceId,
    locationId: options.locationId,
    clientId: options.clientId,
    communicationId: options.communicationId,
    source,
    sourceId,
    idempotencyKey: provisionalKey,
    expectedProvider: initialTransport.provider.name,
  });
  return result;
}

export async function sendSms(
  options: SmsSendOptions,
): Promise<SmsDispatchResult> {
  try {
    return await sendSmsInternal(options);
  } catch (error) {
    // Every path after reservation/provider invocation is handled inside the
    // dispatch boundary. An escape here is therefore a pre-reservation setup
    // failure and is safe to classify as definite without creating a retry
    // ambiguity or an orphan pending communication.
    console.error("[messaging] SMS preparation failed", error);
    return failure("SMS could not be prepared; send blocked.");
  }
}

/**
 * Append an operator's resolution of an ambiguous attempt. This function never
 * resolves a transport and never calls a provider.
 */
export async function reconcileSmsSendAttempt(options: {
  practiceId: string;
  attemptId: string;
  outcome: "accepted" | "definite_failure";
  providerMessageId?: string;
  detail: string;
  actorUserId: string;
  actorType?: "clinic_user" | "platform_operator";
  actorIdentity?: string;
  actorName: string;
  reconciliationKey: string;
}): Promise<SmsDispatchResult> {
  if (
    !validBoundedIdentity(options.detail, 2000) ||
    !validBoundedIdentity(options.actorName, 255) ||
    !validBoundedIdentity(options.actorIdentity ?? options.actorUserId, 255) ||
    !validBoundedIdentity(options.reconciliationKey, 200)
  ) {
    return failure("Reconciliation evidence is incomplete or too long.");
  }
  const providerMessageId = options.providerMessageId?.trim();
  if (options.outcome === "accepted" && !providerMessageId) {
    return failure("Accepted reconciliation requires a provider message id.");
  }
  if (options.outcome === "definite_failure" && providerMessageId) {
    return failure(
      "A definite-failure reconciliation cannot have a provider id.",
    );
  }

  let projectionMiss:
    | { communicationId: string; attemptId: string; outcome: string }
    | undefined;
  try {
    const result = await withSystem(db, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sms-attempt:${options.practiceId}:${options.attemptId}`}, 0))`,
      );
      const [attempt] = await tx
        .select()
        .from(smsSendAttempts)
        .where(
          and(
            eq(smsSendAttempts.practiceId, options.practiceId),
            eq(smsSendAttempts.id, options.attemptId),
          ),
        )
        .limit(1);
      if (!attempt) return failure("SMS send attempt not found.");

      if (
        new Date(attempt.createdAt).getTime() >
        Date.now() - SMS_RECONCILIATION_STALE_MS
      ) {
        return failure(
          "This SMS attempt is still within the provider in-flight window. Wait before reconciling it.",
          { outcome: "outcome_unknown", attemptId: attempt.id },
        );
      }

      const actorType = options.actorType ?? "clinic_user";
      if (actorType === "clinic_user") {
        const [actor] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.practiceId, options.practiceId),
              eq(users.id, options.actorUserId),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
        if (!actor) return failure("Reconciliation actor not found.");
      }

      const priorEvents = await attemptEvents(
        tx as unknown as Database,
        options.practiceId,
        options.attemptId,
      );
      const prior = effectiveEvent(priorEvents);
      if (prior && prior.outcome !== "outcome_unknown") {
        if (attempt.communicationId) {
          const [projected] = await tx
            .update(communications)
            .set(
              prior.outcome === "accepted"
                ? {
                    status: "sent",
                    providerMessageId: prior.providerMessageId,
                  }
                : { status: "failed" },
            )
            .where(
              and(
                eq(communications.practiceId, options.practiceId),
                eq(communications.id, attempt.communicationId),
                eq(communications.status, "pending"),
                isNull(communications.deletedAt),
              ),
            )
            .returning({ id: communications.id });
          if (!projected) {
            projectionMiss = {
              communicationId: attempt.communicationId,
              attemptId: attempt.id,
              outcome: prior.outcome,
            };
          }
        }
        return eventToDispatchResult(attempt.id, prior, true);
      }

      if (options.outcome === "accepted" && providerMessageId) {
        await lockSmsDeliveryIdentity(
          tx as unknown as Database,
          attempt.provider,
          providerMessageId,
        );
      }
      const [event] = await tx
        .insert(smsSendAttemptEvents)
        .values({
          practiceId: options.practiceId,
          attemptId: attempt.id,
          kind: "reconciliation",
          outcome: options.outcome,
          providerMessageId,
          detail: boundedDetail(options.detail),
          actorType,
          actorUserId:
            actorType === "clinic_user" ? options.actorUserId : undefined,
          actorIdentity: (options.actorIdentity ?? options.actorUserId).trim(),
          actorName: options.actorName.trim(),
          eventKey: options.reconciliationKey.trim(),
        })
        .onConflictDoNothing({
          target: [
            smsSendAttemptEvents.practiceId,
            smsSendAttemptEvents.eventKey,
          ],
        })
        .returning();
      if (!event) {
        const current = effectiveEvent(
          await attemptEvents(
            tx as unknown as Database,
            options.practiceId,
            attempt.id,
          ),
        );
        return current
          ? eventToDispatchResult(attempt.id, current, true)
          : failure("Reconciliation key collision; no outcome was changed.", {
              attemptId: attempt.id,
              replayed: true,
            });
      }

      if (attempt.communicationId) {
        const [projected] = await tx
          .update(communications)
          .set(
            options.outcome === "accepted"
              ? { status: "sent", providerMessageId }
              : { status: "failed" },
          )
          .where(
            and(
              eq(communications.practiceId, options.practiceId),
              eq(communications.id, attempt.communicationId),
              eq(communications.status, "pending"),
              isNull(communications.deletedAt),
            ),
          )
          .returning({ id: communications.id });
        if (!projected) {
          projectionMiss = {
            communicationId: attempt.communicationId,
            attemptId: attempt.id,
            outcome: options.outcome,
          };
        }
      }
      if (options.outcome === "accepted" && providerMessageId) {
        await processPendingDeliveryEvidenceForAcceptedSend(
          tx as unknown as Database,
          attempt.provider,
          providerMessageId,
          { identityLockHeld: true },
        );
      }
      return eventToDispatchResult(attempt.id, event, false);
    });
    if (projectionMiss) {
      await alertOps(
        "SMS reconciliation projection requires review",
        `practice=${options.practiceId} communication=${projectionMiss.communicationId} attempt=${projectionMiss.attemptId} outcome=${projectionMiss.outcome}`,
      ).catch((error) => {
        console.error("[messaging] SMS reconciliation alert failed", error);
      });
    }
    return result;
  } catch (error) {
    console.error("[messaging] SMS reconciliation failed", error);
    return failure("Could not persist SMS reconciliation.");
  }
}

/** Explicit resend is allowed only after a known failure and creates a new row. */
export async function resendSmsAttempt(options: {
  practiceId: string;
  attemptId: string;
  idempotencyKey: string;
  actorUserId: string;
  actorType?: "clinic_user" | "platform_operator";
  actorIdentity?: string;
  actorName?: string;
}): Promise<SmsDispatchResult> {
  if (!validBoundedIdentity(options.idempotencyKey, 200)) {
    return failure(
      "A bounded idempotency key is required for an explicit resend.",
    );
  }
  const loaded = await withSystem(db, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(smsSendAttempts)
      .where(
        and(
          eq(smsSendAttempts.practiceId, options.practiceId),
          eq(smsSendAttempts.id, options.attemptId),
        ),
      )
      .limit(1);
    if (!attempt) return undefined;
    const [linkedCommunication] = attempt.communicationId
      ? await tx
          .select({ status: communications.status })
          .from(communications)
          .where(
            and(
              eq(communications.practiceId, options.practiceId),
              eq(communications.id, attempt.communicationId),
              isNull(communications.deletedAt),
            ),
          )
          .limit(1)
      : [undefined];
    const actorType = options.actorType ?? "clinic_user";
    const [actor] =
      actorType === "clinic_user"
        ? await tx
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(
              and(
                eq(users.practiceId, options.practiceId),
                eq(users.id, options.actorUserId),
                isNull(users.deletedAt),
              ),
            )
            .limit(1)
        : [
            {
              id: options.actorUserId,
              name: options.actorName,
              email: options.actorIdentity,
            },
          ];
    const event = effectiveEvent(
      await attemptEvents(
        tx as unknown as Database,
        options.practiceId,
        options.attemptId,
      ),
    );
    return { attempt, actor, event, linkedCommunication };
  });
  if (!loaded?.attempt) return failure("SMS send attempt not found.");
  if (!loaded.actor) return failure("Resend actor not found.");
  if (
    new Date(loaded.attempt.createdAt).getTime() >
    Date.now() - SMS_RECONCILIATION_STALE_MS
  ) {
    return failure(
      "Wait for the provider and fallback delivery window before resending this SMS attempt.",
      { attemptId: loaded.attempt.id },
    );
  }
  if (
    loaded.attempt.communicationId &&
    loaded.linkedCommunication?.status !== "failed"
  ) {
    return failure(
      loaded.linkedCommunication
        ? "The linked communication must be definitively failed before an SMS can be resent. Finish any email fallback or reconciliation first."
        : "The linked communication could not be verified; SMS resend was blocked.",
      { attemptId: loaded.attempt.id },
    );
  }
  if (loaded.event?.outcome !== "definite_failure") {
    return failure(
      "Only a definitively failed SMS may be resent. Reconcile ambiguous attempts first.",
      { attemptId: loaded.attempt.id },
    );
  }

  const currentDisplayName = await campaignDisplayName({
    practiceId: options.practiceId,
    provider: loaded.attempt.provider as MessagingProvider["name"],
    hostedExternalSend:
      billingEnforced() && !envFlagEnabled("NEXT_PUBLIC_DEMO_MODE"),
  });
  if (currentDisplayName !== loaded.attempt.registeredDisplayName) {
    return failure(
      "Registered clinic identity no longer matches the original attempt; resend blocked.",
      { attemptId: loaded.attempt.id },
    );
  }
  const result = await dispatchPreparedSms({
    to: loaded.attempt.destinationE164,
    body: loaded.attempt.body,
    registeredDisplayName: loaded.attempt.registeredDisplayName,
    practiceId: loaded.attempt.practiceId,
    locationId: loaded.attempt.locationId ?? undefined,
    clientId: loaded.attempt.clientId ?? undefined,
    communicationId: loaded.attempt.communicationId ?? undefined,
    source: "operator_resend",
    sourceId: `${loaded.attempt.id}:${options.actorUserId}`,
    idempotencyKey: options.idempotencyKey.trim(),
    resendOfAttemptId: loaded.attempt.id,
    expectedProvider: loaded.attempt.provider as MessagingProvider["name"],
    requestedBy: {
      actorType: options.actorType ?? "clinic_user",
      actorUserId:
        (options.actorType ?? "clinic_user") === "clinic_user"
          ? options.actorUserId
          : undefined,
      identity:
        options.actorIdentity ?? loaded.actor.email ?? options.actorUserId,
      name: options.actorName ?? loaded.actor.name ?? "Platform operator",
    },
  });
  // Accepted projection is part of dispatchPreparedSms's provider-result
  // transaction, including explicit resends. No second crash-prone projection
  // is permitted here.
  return result;
}
