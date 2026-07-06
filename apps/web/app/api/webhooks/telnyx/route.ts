import { NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookContentLengthTooLarge,
} from "@/lib/messaging-webhook-limits";
import { addSuppression, normalizeE164 } from "@/lib/messaging";
import {
  findMessagingLocationForWebhook,
  handleInboundSmsReply,
} from "@/lib/messaging/inbound";
import { envValue } from "@/lib/messaging/env";
import {
  telnyxDeliveryStatus,
  telnyxProviderMessageId,
  type CommunicationDeliveryStatus,
} from "@/lib/messaging/telnyx-events";
import { verifyTelnyxSignature } from "@/lib/messaging/telnyx-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Messaging webhook payload too large" },
    { status: 413 }
  );
}

function firstPayloadToPhone(payload: {
  to?:
    | Array<{ phone_number?: string; status?: string }>
    | { phone_number?: string; status?: string };
}): string | null {
  const raw = Array.isArray(payload.to)
    ? payload.to[0]?.phone_number
    : payload.to?.phone_number;
  return normalizeE164(raw);
}

function payloadString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
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

function deliveryReceiptCurrentStatusCondition(
  deliveryStatus: CommunicationDeliveryStatus
) {
  if (deliveryStatus === "sent") {
    return eq(communications.status, "pending");
  }

  return or(
    eq(communications.status, "pending"),
    eq(communications.status, "sent")
  )!;
}

export async function POST(request: Request) {
  if (messagingWebhookContentLengthTooLarge(request.headers)) {
    return payloadTooLargeResponse();
  }

  const rawBody = await readRequestTextWithLimit(
    request,
    MESSAGING_WEBHOOK_BODY_MAX_BYTES
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
      }
    | undefined;

  if (!payload) {
    return NextResponse.json({ ok: true });
  }

  const deliveryStatus = telnyxDeliveryStatus(eventType, payload);
  const providerMessageId = telnyxProviderMessageId(payload);
  const messagingProfileId = payloadMessagingProfileId(payload);
  if (deliveryStatus && providerMessageId) {
    const fromPhone = normalizeE164(payload.from?.phone_number);
    const loc = await findMessagingLocationForWebhook({
      senderE164: fromPhone,
      messagingProfileId,
      provider: "telnyx",
    });

    if (loc) {
      const updatedCommunications = await withTenant(db, loc.practiceId, (tx) =>
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
              deliveryReceiptCurrentStatusCondition(deliveryStatus)
            )
          )
          .returning({ id: communications.id })
      );

      if (deliveryStatus === "failed" && updatedCommunications.length > 0) {
        const failedRecipient = firstPayloadToPhone(payload);
        if (failedRecipient) {
          await addSuppression({
            practiceId: loc.practiceId,
            locationId: loc.locationId,
            phone: failedRecipient,
            reason: "bounce",
            detail: `Delivery failed for provider message ${providerMessageId}`,
          });
        }
      }
    }

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
      }`
    );
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json(result);
}
