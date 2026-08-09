import { NextResponse } from "next/server";
import Twilio from "twilio";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import { appBaseUrl } from "@/lib/app-url";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookContentLengthTooLarge,
} from "@/lib/messaging-webhook-limits";
import { normalizeE164 } from "@/lib/messaging";
import {
  findMessagingLocationForWebhook,
  handleInboundSmsReply,
} from "@/lib/messaging/inbound";
import { envValue } from "@/lib/messaging/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Messaging webhook payload too large" },
    { status: 413 },
  );
}

type DeliveryStatus = "sent" | "delivered" | "failed";

function deliveryReceiptCurrentStatusCondition(deliveryStatus: DeliveryStatus) {
  if (deliveryStatus === "sent") {
    return eq(communications.status, "pending");
  }

  return or(
    eq(communications.status, "pending"),
    eq(communications.status, "sent"),
  )!;
}

function twilioDeliveryStatus(status: string | null): DeliveryStatus | null {
  const normalized = status?.toLowerCase();
  if (normalized === "sent") return "sent";
  if (normalized === "delivered") return "delivered";
  if (normalized === "failed" || normalized === "undelivered") return "failed";
  return null;
}

function nonBlankParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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

  if (fromPhone && toPhone && text) {
    if (!providerMessageId) {
      return NextResponse.json(
        { error: "missing inbound message id" },
        { status: 400 },
      );
    }
    const result = await handleInboundSmsReply({
      provider: "twilio",
      fromPhone,
      toPhone,
      text,
      providerMessageId,
      messagingProfileId,
    });

    if (result.action === "ignored") {
      console.warn(
        `[twilio-webhook] inbound to unrecognised number ${toPhone}`,
      );
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(result);
  }

  const deliveryStatus = twilioDeliveryStatus(
    params.MessageStatus ?? params.SmsStatus ?? null,
  );
  if (!deliveryStatus || !providerMessageId) {
    return NextResponse.json({ ok: true });
  }

  const loc = await findMessagingLocationForWebhook({
    senderE164: fromPhone,
    messagingProfileId,
    provider: "twilio",
  });
  if (!loc) {
    return NextResponse.json({ ok: true });
  }

  await withTenant(db, loc.practiceId, (tx) =>
    tx
      .update(communications)
      .set({ status: deliveryStatus })
      .where(
        and(
          eq(communications.practiceId, loc.practiceId),
          eq(communications.providerMessageId, providerMessageId),
          eq(communications.channel, "sms"),
          eq(communications.direction, "outbound"),
          isNull(communications.deletedAt),
          deliveryReceiptCurrentStatusCondition(deliveryStatus),
        ),
      )
      .returning({ id: communications.id }),
  );

  // A failed/undelivered DLR is not proof that the recipient is permanently
  // invalid: carrier congestion, filtering, and provider errors share these
  // statuses. Keep STOP/opt-out webhooks as the only automatic SMS suppression
  // until a provider-specific permanent-recipient signal is classified safely.

  return NextResponse.json({ ok: true });
}
