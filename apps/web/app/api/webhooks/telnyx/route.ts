import { NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  communications,
  locationMessaging,
  messagingRegistrations,
} from "@openpims/db";
import { withSystem, withTenant } from "@/lib/tenant-db";
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
import {
  telnyxDeliveryStatus,
  telnyxProviderMessageId,
  type CommunicationDeliveryStatus,
} from "@/lib/messaging/telnyx-events";
import { verifyTelnyxSignature } from "@/lib/messaging/telnyx-signature";
import {
  mergeRegistrationStatus,
  type RegistrationLifecycleStatus,
} from "@/lib/messaging/a2p-lifecycle";

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
  deliveryStatus: CommunicationDeliveryStatus,
) {
  if (deliveryStatus === "sent") {
    return eq(communications.status, "pending");
  }

  return or(
    eq(communications.status, "pending"),
    eq(communications.status, "sent"),
  )!;
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

  await withSystem(db, async (tx) => {
    let [registration] = await tx
      .select({
        id: messagingRegistrations.id,
        practiceId: messagingRegistrations.practiceId,
        status: messagingRegistrations.status,
      })
      .from(messagingRegistrations)
      .where(
        and(
          isNull(messagingRegistrations.deletedAt),
          opts.eventType === "10dlc.brand.update" && brandId
            ? eq(messagingRegistrations.providerBrandId, brandId)
            : campaignId
              ? eq(messagingRegistrations.providerCampaignId, campaignId)
              : eq(
                  messagingRegistrations.id,
                  "00000000-0000-0000-0000-000000000000",
                ),
        ),
      )
      .limit(1);

    if (!registration && phoneNumber) {
      const [sender] = await tx
        .select({ practiceId: locationMessaging.practiceId })
        .from(locationMessaging)
        .where(
          and(
            eq(locationMessaging.provider, "telnyx"),
            eq(locationMessaging.senderE164, phoneNumber),
            isNull(locationMessaging.deletedAt),
          ),
        )
        .limit(1);
      if (sender) {
        [registration] = await tx
          .select({
            id: messagingRegistrations.id,
            practiceId: messagingRegistrations.practiceId,
            status: messagingRegistrations.status,
          })
          .from(messagingRegistrations)
          .where(
            and(
              eq(messagingRegistrations.practiceId, sender.practiceId),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(1);
      }
    }
    if (!registration) return;

    const next = mergeRegistrationStatus(registration.status, observed);
    const reasons = Array.isArray(opts.payload.reasons)
      ? opts.payload.reasons.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const detail =
      payloadString(opts.payload.description) ?? (reasons.join("; ") || null);
    await tx
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
          next === "action_required" || next === "suspended"
            ? "Carrier registration needs OpenVPM operator review."
            : "Carrier update received; OpenVPM will confirm full registration status.",
        lastError:
          next === "action_required" || next === "suspended" ? detail : null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(messagingRegistrations.id, registration.id));

    await tx
      .update(locationMessaging)
      .set({
        registrationStatus: next,
        registrationDetail:
          next === "action_required" || next === "suspended"
            ? "Carrier registration needs OpenVPM review."
            : "Carrier registration update received; confirmation is pending.",
        ...(next === "action_required" || next === "suspended"
          ? { enabled: false }
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
  });
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
      }
    | undefined;

  if (!payload) {
    return NextResponse.json({ ok: true });
  }

  if (eventType && A2P_EVENT_TYPES.has(eventType)) {
    await handleA2pLifecycleWebhook({ eventType, payload });
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

      // Generic Telnyx failure events do not distinguish a permanently invalid
      // recipient from transient carrier/provider failures. Preserve delivery
      // status, but leave automatic suppression to explicit STOP/opt-out events.
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
