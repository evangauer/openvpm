import { NextResponse } from "next/server";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookContentLengthTooLarge,
} from "@/lib/messaging-webhook-limits";
import { normalizeE164 } from "@/lib/messaging";
import {
  classifyInboundSms,
  type InboundSmsClassification,
} from "@/lib/messaging/inbound";
import type { RegistrationLifecycleStatus } from "@/lib/messaging/a2p-lifecycle";
import { envValue } from "@/lib/messaging/env";
import { sanitizeProviderDiagnostic } from "@/lib/messaging/provider-diagnostics";
import {
  ingestSmsProviderEvent,
  projectSmsProviderEvent,
} from "@/lib/messaging/sms-provider-events";
import {
  telnyxDeliveryStatus,
  telnyxProviderErrorCode,
  telnyxProviderMessageId,
  telnyxProviderStatus,
} from "@/lib/messaging/telnyx-events";
import { verifyTelnyxSignature } from "@/lib/messaging/telnyx-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const A2P_EVENT_TYPES = new Set([
  "10dlc.brand.update",
  "10dlc.campaign.update",
  "10dlc.phone_number.update",
]);
const PROVIDER_FAILURE_DETAIL_MAX_LENGTH = 1_000;
const PROVIDER_FAILURE_REASON_MAX_LENGTH = 500;

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

function telnyxInboundClassification(
  text: string,
  rawAutoresponseType: unknown,
): InboundSmsClassification {
  const local = classifyInboundSms(text);
  const providerValue = payloadString(rawAutoresponseType)?.toLowerCase();
  const provider = new Set(["start", "stop", "help"]).has(providerValue ?? "")
    ? (providerValue as Exclude<InboundSmsClassification, "other">)
    : null;
  if (local === "stop" || provider === "stop") return "stop";
  if (local === "start") return provider === "start" ? "start" : "other";
  if (provider === "start") return "other";
  if (provider) return provider === local ? provider : "other";
  return local;
}

function providerFailureDetail(payload: {
  description?: unknown;
  reasons?: unknown;
}): string | null {
  const descriptions = [
    sanitizeProviderDiagnostic(
      payload.description,
      PROVIDER_FAILURE_REASON_MAX_LENGTH,
    ),
    ...(Array.isArray(payload.reasons) ? payload.reasons : [])
      .map((reason) => {
        if (typeof reason === "string") return reason;
        if (!reason || typeof reason !== "object" || Array.isArray(reason)) {
          return null;
        }
        return (reason as { description?: unknown }).description;
      })
      .map((reason) =>
        sanitizeProviderDiagnostic(reason, PROVIDER_FAILURE_REASON_MAX_LENGTH),
      )
      .filter((reason): reason is string => Boolean(reason)),
  ].filter((reason): reason is string => Boolean(reason));
  return sanitizeProviderDiagnostic(
    [...new Set(descriptions)].join("; "),
    PROVIDER_FAILURE_DETAIL_MAX_LENGTH,
  );
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

function a2pWebhookStatus(payload: {
  status?: unknown;
  type?: unknown;
  eventType?: unknown;
}): Exclude<RegistrationLifecycleStatus, "not_started" | "active"> {
  const status = payloadString(payload.status)?.toUpperCase();
  const type = payloadString(payload.type)?.toUpperCase();
  const providerEventType = payloadString(payload.eventType)?.toUpperCase();
  const terminalValues = new Set(
    [status, type, providerEventType].filter(Boolean),
  );
  if (
    terminalValues.has("DORMANT") ||
    terminalValues.has("DELETED") ||
    terminalValues.has("SUSPENDED") ||
    terminalValues.has("TCR_SUSPENDED") ||
    terminalValues.has("TCR_EXPIRED") ||
    terminalValues.has("EXPIRED") ||
    Boolean(
      providerEventType && /(EXPIRED|SUSPEND|DELET)/.test(providerEventType),
    ) ||
    (type === "DELETION" && status === "SUCCESS")
  ) {
    return "suspended";
  }
  if (
    [
      "FAILED",
      "REJECTED",
      "REGISTRATION_FAILED",
      "TCR_FAILED",
      "TELNYX_FAILED",
      "MNO_REJECTED",
      "MNO_PROVISIONING_FAILED",
      "FAILED_ASSIGNMENT",
      "FAILED_UNASSIGNMENT",
    ].some((value) => terminalValues.has(value)) ||
    Boolean(providerEventType && /(REJECT|FAIL)/.test(providerEventType))
  ) {
    return "action_required";
  }
  return "pending";
}

export async function POST(request: Request) {
  if (messagingWebhookContentLengthTooLarge(request.headers)) {
    return payloadTooLargeResponse();
  }
  const rawBody = await readRequestTextWithLimit(
    request,
    MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  );
  if (!rawBody.ok) return payloadTooLargeResponse();

  const publicKey = envValue("TELNYX_PUBLIC_KEY");
  const signature = request.headers.get("telnyx-signature-ed25519");
  const timestamp = request.headers.get("telnyx-timestamp");
  if (
    !publicKey ||
    !signature ||
    !timestamp ||
    !verifyTelnyxSignature({
      rawBody: rawBody.text,
      signatureB64: signature,
      timestamp,
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
  const eventType = payloadString(data?.event_type);
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
        autoresponse_type?: string;
        brandId?: string;
        campaignId?: string;
        phoneNumber?: string;
        type?: string;
        eventType?: string;
        description?: string;
        reasons?: unknown;
        errors?: Array<{ code?: unknown }>;
      }
    | undefined;
  if (!eventType) return NextResponse.json({ ok: true });
  if (!payload) {
    return A2P_EVENT_TYPES.has(eventType) || eventType.startsWith("message.")
      ? NextResponse.json(
          { error: "missing provider event payload" },
          { status: 400 },
        )
      : NextResponse.json({ ok: true });
  }

  if (A2P_EVENT_TYPES.has(eventType)) {
    const brandId = payloadString(payload.brandId);
    const campaignId = payloadString(payload.campaignId);
    const rawPhoneNumber = payloadString(payload.phoneNumber);
    const phoneNumber = normalizeE164(rawPhoneNumber);
    if (rawPhoneNumber && !phoneNumber) {
      return NextResponse.json(
        { error: "invalid A2P phone identity" },
        { status: 400 },
      );
    }
    if (!brandId && !campaignId && !phoneNumber) {
      return NextResponse.json(
        { error: "missing A2P identity" },
        { status: 400 },
      );
    }
    const ingested = await ingestSmsProviderEvent({
      provider: "telnyx",
      kind: "a2p",
      providerEventId: payloadString(data?.id),
      providerEventType: eventType,
      rawBody: rawBody.text,
      occurredAt: payloadString(data?.occurred_at),
      a2pBrandId: brandId,
      a2pCampaignId: campaignId,
      a2pPhoneE164: phoneNumber,
      a2pStatus: payloadString(payload.status),
      a2pType: payloadString(payload.type),
      a2pEventType: payloadString(payload.eventType),
      a2pObservedStatus: a2pWebhookStatus(payload),
      providerStatus:
        payloadString(payload.status) ??
        payloadString(payload.eventType) ??
        payloadString(payload.type),
      providerDetail: providerFailureDetail(payload),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return NextResponse.json({ ok: true });
  }

  const providerMessageId = telnyxProviderMessageId(payload);
  if (eventType.startsWith("message.") && eventType !== "message.received") {
    if (!providerMessageId) {
      return NextResponse.json(
        { error: "missing delivery message id" },
        { status: 400 },
      );
    }
    const ingested = await ingestSmsProviderEvent({
      provider: "telnyx",
      kind: "delivery",
      providerEventId: payloadString(data?.id),
      providerMessageId,
      providerEventType: eventType,
      rawBody: rawBody.text,
      providerStatus: telnyxProviderStatus(payload),
      providerErrorCode: telnyxProviderErrorCode(payload),
      deliveryClassification:
        telnyxDeliveryStatus(eventType, payload) ?? "unknown",
      occurredAt: payloadString(data?.occurred_at),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return NextResponse.json({ ok: true });
  }

  if (eventType !== "message.received") {
    return NextResponse.json({ ok: true });
  }
  const toRaw = Array.isArray(payload.to)
    ? payload.to[0]?.phone_number
    : payload.to?.phone_number;
  const fromPhone = normalizeE164(payload.from?.phone_number);
  const toPhone = normalizeE164(toRaw);
  const messagingProfileId = payloadMessagingProfileId(payload);
  const text = (payload.text ?? "").trim();
  if (!fromPhone || (!toPhone && !messagingProfileId) || !text) {
    return NextResponse.json(
      { error: "malformed inbound message" },
      { status: 400 },
    );
  }
  if (!providerMessageId) {
    return NextResponse.json(
      { error: "missing inbound message id" },
      { status: 400 },
    );
  }
  const ingested = await ingestSmsProviderEvent({
    provider: "telnyx",
    kind: "inbound",
    providerEventId: payloadString(data?.id) ?? providerMessageId,
    providerMessageId,
    providerEventType: "message.received",
    rawBody: rawBody.text,
    occurredAt: payloadString(data?.occurred_at),
    fromE164: fromPhone,
    toE164: toPhone,
    messagingProfileId,
    messageBody: text,
    inboundClassification: telnyxInboundClassification(
      text,
      payload.autoresponse_type,
    ),
  });
  if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
  return NextResponse.json({ ok: true });
}
