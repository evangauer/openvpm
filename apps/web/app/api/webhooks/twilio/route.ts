import { NextResponse } from "next/server";
import Twilio from "twilio";
import { appBaseUrl } from "@/lib/app-url";
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
import { envValue } from "@/lib/messaging/env";
import {
  ingestSmsProviderEvent,
  projectSmsProviderEvent,
} from "@/lib/messaging/sms-provider-events";
import {
  twilioDeliveryClassification,
  twilioProviderStatus,
} from "@/lib/messaging/twilio-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Messaging webhook payload too large" },
    { status: 413 },
  );
}

function nonBlankParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function twilioInboundClassification(
  text: string,
  rawOptOutType: string | undefined,
): InboundSmsClassification {
  const local = classifyInboundSms(text);
  const providerValue = nonBlankParam(rawOptOutType)?.toLowerCase();
  const provider = new Set(["start", "stop", "help"]).has(providerValue ?? "")
    ? (providerValue as Exclude<InboundSmsClassification, "other">)
    : null;
  if (local === "stop" || provider === "stop") return "stop";
  if (local === "start")
    return provider && provider !== "start" ? "other" : "start";
  if (provider === "start") return "other";
  if (provider) return provider === local ? provider : "other";
  return local;
}

function requestValidationUrls(request: Request): string[] {
  const url = new URL(request.url);
  const canonical = new URL(`${url.pathname}${url.search}`, appBaseUrl());
  return Array.from(new Set([url.toString(), canonical.toString()]));
}

function verifyTwilioRequest(
  request: Request,
  params: Record<string, string>,
): boolean {
  const authToken = envValue("TWILIO_AUTH_TOKEN");
  const signature = request.headers.get("x-twilio-signature");
  if (!authToken || !signature) return false;

  return requestValidationUrls(request).some((url) =>
    Twilio.validateRequest(authToken, signature, url, params),
  );
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

  const form = new URLSearchParams(rawBody.text);
  const params = Object.fromEntries(form.entries());

  if (!verifyTwilioRequest(request, params)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const fromPhone = normalizeE164(params.From);
  const toPhone = normalizeE164(params.To);
  const text = (params.Body ?? "").trim();
  const providerMessageId =
    params.MessageSid || params.SmsMessageSid || params.SmsSid || null;
  const messagingProfileId = nonBlankParam(params.MessagingServiceSid);
  const rawDeliveryStatus = params.MessageStatus ?? params.SmsStatus ?? null;
  const normalizedDeliveryStatus = rawDeliveryStatus?.trim().toLowerCase();
  const isDeliveryCallback = Boolean(
    rawDeliveryStatus && normalizedDeliveryStatus !== "received",
  );

  if (isDeliveryCallback) {
    if (!providerMessageId) {
      return NextResponse.json(
        { error: "missing delivery message id" },
        { status: 400 },
      );
    }
    const ingested = await ingestSmsProviderEvent({
      provider: "twilio",
      kind: "delivery",
      providerEventId: nonBlankParam(params.EventSid),
      providerMessageId,
      providerEventType: "message.status",
      rawBody: rawBody.text,
      providerStatus: twilioProviderStatus(rawDeliveryStatus!),
      providerErrorCode: nonBlankParam(params.ErrorCode),
      deliveryClassification: twilioDeliveryClassification(rawDeliveryStatus!),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return NextResponse.json({ ok: true });
  }

  if (fromPhone && toPhone && text) {
    if (!providerMessageId) {
      return NextResponse.json(
        { error: "missing inbound message id" },
        { status: 400 },
      );
    }
    const ingested = await ingestSmsProviderEvent({
      provider: "twilio",
      kind: "inbound",
      providerEventId: nonBlankParam(params.EventSid) ?? providerMessageId,
      providerMessageId,
      providerEventType: "message.received",
      rawBody: rawBody.text,
      fromE164: fromPhone,
      toE164: toPhone,
      messagingProfileId,
      messageBody: text,
      inboundClassification: twilioInboundClassification(
        text,
        params.OptOutType,
      ),
    });
    if (!ingested.conflict) await projectSmsProviderEvent(ingested.eventId);
    return NextResponse.json({ ok: true });
  }

  if (
    providerMessageId ||
    rawDeliveryStatus ||
    params.From ||
    params.To ||
    params.Body
  ) {
    return NextResponse.json(
      { error: "malformed messaging callback" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
