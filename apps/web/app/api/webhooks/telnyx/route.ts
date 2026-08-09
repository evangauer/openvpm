import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  locationMessaging,
  messagingRegistrationEvents,
  messagingRegistrations,
} from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookContentLengthTooLarge,
} from "@/lib/messaging-webhook-limits";
import { normalizeE164 } from "@/lib/messaging";
import { handleInboundSmsReply } from "@/lib/messaging/inbound";
import { envValue } from "@/lib/messaging/env";
import {
  telnyxDeliveryStatus,
  telnyxProviderErrorCode,
  telnyxProviderMessageId,
  telnyxProviderStatus,
} from "@/lib/messaging/telnyx-events";
import { recordSmsDeliveryCallback } from "@/lib/messaging/sms-delivery-ledger";
import { verifyTelnyxSignature } from "@/lib/messaging/telnyx-signature";
import { alertOps } from "@/lib/alerts";
import {
  mergeRegistrationStatus,
  type RegistrationLifecycleStatus,
} from "@/lib/messaging/a2p-lifecycle";
import {
  recordMessagingRegistrationEvent,
  systemMessagingRegistrationActor,
} from "@/lib/messaging/registration-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Messaging webhook payload too large" },
    { status: 413 },
  );
}

function payloadString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function providerEventOperationId(value: unknown): string {
  const providerEventId = payloadString(value);
  if (!providerEventId) return randomUUID();
  const bytes = createHash("sha256")
    .update(`telnyx-a2p-event:${providerEventId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function payloadMessagingProfileId(payload: {
  messaging_profile_id?: unknown;
  messagingProfileId?: unknown;
  messaging_profile?: { id?: unknown };
}): string | null {
  return (
    payloadString(payload.messaging_profile_id) ??
    payloadString(payload.messagingProfileId) ??
    payloadString(payload.messaging_profile?.id)
  );
}

const A2P_EVENT_TYPES = new Set([
  "10dlc.brand.update",
  "10dlc.campaign.update",
  "10dlc.phone_number.update",
]);

function a2pWebhookStatus(payload: {
  status?: unknown;
  type?: unknown;
}): RegistrationLifecycleStatus {
  const status = payloadString(payload.status)?.toUpperCase();
  const type = payloadString(payload.type)?.toUpperCase();
  if (status === "DORMANT" || type === "SUSPENDED") return "suspended";
  if (
    status === "FAILED" ||
    status === "REJECTED" ||
    type === "FAILED" ||
    type === "REJECTED"
  ) {
    return "action_required";
  }
  // A positive webhook is not enough to open sending: a subsequent provider
  // reconciliation must confirm the brand, campaign, and every number.
  return "pending";
}

async function handleA2pLifecycleWebhook(opts: {
  eventType: string;
  providerEventId?: unknown;
  payload: {
    brandId?: unknown;
    campaignId?: unknown;
    phoneNumber?: unknown;
    status?: unknown;
    type?: unknown;
    description?: unknown;
    reasons?: unknown;
  };
}) {
  const brandId = payloadString(opts.payload.brandId);
  const campaignId = payloadString(opts.payload.campaignId);
  const phoneNumber = normalizeE164(payloadString(opts.payload.phoneNumber));
  const providerStatus =
    payloadString(opts.payload.status) ?? payloadString(opts.payload.type);
  const observed = a2pWebhookStatus(opts.payload);
  const operationId = providerEventOperationId(opts.providerEventId);

  const outcome = await withSystem(db, async (tx) => {
    // Telnyx retries signed webhooks. Serialize the provider event before any
    // projection write, then use a one-way deterministic UUID so concurrent
    // deliveries acknowledge cleanly instead of duplicating lifecycle evidence.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`telnyx-a2p-event:${operationId}`}, 0))`,
    );
    const brandMatches = brandId
      ? await tx
          .select()
          .from(messagingRegistrations)
          .where(
            and(
              eq(messagingRegistrations.providerBrandId, brandId),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(2)
      : [];
    const campaignMatches = campaignId
      ? await tx
          .select()
          .from(messagingRegistrations)
          .where(
            and(
              eq(messagingRegistrations.providerCampaignId, campaignId),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(2)
      : [];
    const senderMatches = phoneNumber
      ? await tx
          .select({
            practiceId: locationMessaging.practiceId,
            locationId: locationMessaging.locationId,
          })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.provider, "telnyx"),
              eq(locationMessaging.senderE164, phoneNumber),
              isNull(locationMessaging.deletedAt),
            ),
          )
          .limit(2)
      : [];
    const phoneRegistrationMatches =
      senderMatches.length === 1
        ? await tx
            .select()
            .from(messagingRegistrations)
            .where(
              and(
                eq(
                  messagingRegistrations.practiceId,
                  senderMatches[0]!.practiceId,
                ),
                isNull(messagingRegistrations.deletedAt),
              ),
            )
            .limit(2)
        : [];

    const resolvedRegistrations = [
      ...brandMatches,
      ...campaignMatches,
      ...phoneRegistrationMatches,
    ];
    const affectedPracticeIds = [
      ...new Set([
        ...resolvedRegistrations.map((row) => row.practiceId),
        ...senderMatches.map((row) => row.practiceId),
      ]),
    ];
    const affectedLocationIds = [
      ...new Set(senderMatches.map((row) => row.locationId)),
    ];
    const resolutionCounts = [
      ...(brandId ? [brandMatches.length] : []),
      ...(campaignId ? [campaignMatches.length] : []),
      ...(phoneNumber
        ? [senderMatches.length, phoneRegistrationMatches.length]
        : []),
    ];
    const identityConflict =
      resolutionCounts.some((count) => count !== 1) ||
      affectedPracticeIds.length > 1;

    if (identityConflict && affectedPracticeIds.length > 0) {
      const quarantineScope =
        affectedPracticeIds.length > 0 && affectedLocationIds.length > 0
          ? or(
              inArray(locationMessaging.practiceId, affectedPracticeIds),
              inArray(locationMessaging.locationId, affectedLocationIds),
            )
          : affectedPracticeIds.length > 0
            ? inArray(locationMessaging.practiceId, affectedPracticeIds)
            : inArray(locationMessaging.locationId, affectedLocationIds);
      await tx
        .update(locationMessaging)
        .set({
          enabled: false,
          registrationStatus: "action_required",
          registrationDetail:
            "Carrier webhook identities conflict. OpenVPM must reconcile the exact brand, campaign, and number before sending can resume.",
          providerProfileReady: false,
          providerProfileSyncedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(locationMessaging.provider, "telnyx"),
            quarantineScope,
            isNull(locationMessaging.deletedAt),
          ),
        );
      return "identity_conflict" as const;
    }

    const registration =
      brandMatches[0] ??
      campaignMatches[0] ??
      phoneRegistrationMatches[0] ??
      null;
    if (!registration) return "ignored" as const;

    const [existingEvent] = await tx
      .select({ id: messagingRegistrationEvents.id })
      .from(messagingRegistrationEvents)
      .where(
        and(
          eq(messagingRegistrationEvents.practiceId, registration.practiceId),
          eq(messagingRegistrationEvents.operationId, operationId),
          eq(messagingRegistrationEvents.eventType, "provider_state_observed"),
        ),
      )
      .limit(1);
    if (existingEvent) return "duplicate" as const;

    const next = mergeRegistrationStatus(registration.status, observed);
    const reasons = Array.isArray(opts.payload.reasons)
      ? opts.payload.reasons.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const detail =
      payloadString(opts.payload.description) ?? (reasons.join("; ") || null);
    const [updated] = await tx
      .update(messagingRegistrations)
      .set({
        ...(opts.eventType === "10dlc.brand.update"
          ? { providerBrandStatus: providerStatus }
          : {}),
        ...(opts.eventType !== "10dlc.brand.update"
          ? { providerCampaignStatus: providerStatus }
          : {}),
        status: next,
        statusDetail:
          next === "action_required" ||
          next === "failed" ||
          next === "suspended"
            ? "Carrier registration needs OpenVPM operator review."
            : "Carrier update received; OpenVPM will confirm full registration status.",
        lastError:
          next === "action_required" ||
          next === "failed" ||
          next === "suspended"
            ? detail
            : null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messagingRegistrations.id, registration.id),
          eq(messagingRegistrations.status, registration.status),
          brandId
            ? eq(messagingRegistrations.providerBrandId, brandId)
            : sql`true`,
          campaignId
            ? eq(messagingRegistrations.providerCampaignId, campaignId)
            : sql`true`,
          phoneNumber
            ? sql`exists (
                select 1
                from ${locationMessaging} as sender
                where sender.practice_id = ${registration.practiceId}
                  and sender.provider = 'telnyx'
                  and sender.sender_e164 = ${phoneNumber}
                  and sender.deleted_at is null
              )`
            : sql`true`,
          isNull(messagingRegistrations.deletedAt),
        ),
      )
      .returning();
    if (!updated) return "stale" as const;

    await recordMessagingRegistrationEvent(tx, {
      registration: updated,
      eventType: "provider_state_observed",
      operation: "registration_reconciliation",
      statusBefore: registration.status,
      operationId,
      reasonCode: "carrier_webhook_observed",
      actor: systemMessagingRegistrationActor(),
    });

    await tx
      .update(locationMessaging)
      .set({
        registrationStatus: next,
        registrationDetail:
          next === "action_required" ||
          next === "failed" ||
          next === "suspended"
            ? "Carrier registration needs OpenVPM review."
            : "Carrier registration update received; confirmation is pending.",
        ...(next !== "active"
          ? {
              enabled: false,
              providerProfileReady: false,
              providerProfileSyncedAt: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.practiceId, registration.practiceId),
          eq(locationMessaging.provider, "telnyx"),
          isNull(locationMessaging.deletedAt),
        ),
      );
    return "applied" as const;
  });
  if (outcome === "identity_conflict") {
    await alertOps(
      "Telnyx A2P identity conflict",
      "A signed carrier lifecycle event supplied contradictory brand, campaign, or phone identities. Matching senders were disabled; reconcile the carrier portal before re-enabling texting.",
    );
  }
}

export async function POST(request: Request) {
  if (messagingWebhookContentLengthTooLarge(request.headers)) {
    return payloadTooLargeResponse();
  }

  const rawBody = await readRequestTextWithLimit(
    request,
    MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  );
  if (!rawBody.ok) {
    return payloadTooLargeResponse();
  }

  // Fail closed: this public route mutates tenant data (suppression, consent,
  // inbox), so a missing key, missing headers, or a bad signature all reject —
  // matching the codebase's fail-closed auth elsewhere (cron-auth, Stripe webhook).
  const publicKey = envValue("TELNYX_PUBLIC_KEY");
  const sig = request.headers.get("telnyx-signature-ed25519");
  const ts = request.headers.get("telnyx-timestamp");
  if (
    !publicKey ||
    !sig ||
    !ts ||
    !verifyTelnyxSignature({
      rawBody: rawBody.text,
      signatureB64: sig,
      timestamp: ts,
      publicKeyB64: publicKey,
    })
  ) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody.text);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const data = (event as { data?: Record<string, unknown> })?.data;
  const eventType = data?.event_type as string | undefined;
  const payload = data?.payload as
    | {
        from?: { phone_number?: string };
        to?:
          | Array<{ phone_number?: string; status?: string }>
          | { phone_number?: string; status?: string };
        text?: string;
        id?: string;
        message_id?: string;
        status?: string;
        delivery_status?: string;
        messaging_profile_id?: string;
        messagingProfileId?: string;
        messaging_profile?: { id?: string };
        brandId?: string;
        campaignId?: string;
        phoneNumber?: string;
        type?: string;
        description?: string;
        reasons?: unknown;
        errors?: Array<{ code?: unknown }>;
      }
    | undefined;

  if (!payload) {
    return NextResponse.json({ ok: true });
  }

  if (eventType && A2P_EVENT_TYPES.has(eventType)) {
    await handleA2pLifecycleWebhook({
      eventType,
      providerEventId: data?.id,
      payload,
    });
    return NextResponse.json({ ok: true });
  }

  const providerMessageId = telnyxProviderMessageId(payload);
  const messagingProfileId = payloadMessagingProfileId(payload);
  if (eventType?.startsWith("message.") && eventType !== "message.received") {
    const occurredAtRaw = payloadString(data?.occurred_at);
    const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
    await recordSmsDeliveryCallback({
      provider: "telnyx",
      providerEventId: payloadString(data?.id),
      providerMessageId,
      providerEventType: eventType,
      providerStatus: telnyxProviderStatus(payload),
      providerErrorCode: telnyxProviderErrorCode(payload),
      classification: telnyxDeliveryStatus(eventType, payload) ?? "unknown",
      occurredAt:
        occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
    });

    // Generic carrier failures are operational delivery evidence, not proof of
    // a permanent invalid recipient. STOP remains the suppression authority.
    return NextResponse.json({ ok: true });
  }

  // We only log inbound messages. Other events are acked after DLR handling.
  if (eventType !== "message.received") {
    return NextResponse.json({ ok: true });
  }

  const toRaw = Array.isArray(payload.to)
    ? payload.to[0]?.phone_number
    : payload.to?.phone_number;
  const fromPhone = normalizeE164(payload.from?.phone_number);
  const toPhone = normalizeE164(toRaw);
  const text = (payload.text ?? "").trim();
  if (!fromPhone || (!toPhone && !messagingProfileId)) {
    return NextResponse.json({ ok: true });
  }
  if (!text) {
    return NextResponse.json({ ok: true });
  }
  if (!providerMessageId) {
    return NextResponse.json(
      { error: "missing inbound message id" },
      { status: 400 },
    );
  }

  const result = await handleInboundSmsReply({
    provider: "telnyx",
    fromPhone,
    toPhone,
    text,
    providerMessageId,
    messagingProfileId,
  });

  if (result.action === "ignored") {
    console.warn(
      `[telnyx-webhook] inbound to unrecognised sender ${
        toPhone ?? messagingProfileId
      }`,
    );
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(result);
}
