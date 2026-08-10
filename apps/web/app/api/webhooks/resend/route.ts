import { NextResponse } from "next/server";
import { Resend, type WebhookEventPayload } from "resend";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { communications, emailSuppressions, practices } from "@openpims/db";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  EMAIL_WEBHOOK_BODY_MAX_BYTES,
  emailWebhookContentLengthTooLarge,
} from "@/lib/email-webhook-limits";
import {
  normalizeEmailSuppressionAddress,
  type EmailSuppressionReason,
} from "@/lib/email-suppression";
import { emailEnv } from "@/lib/email-env";
import {
  authEmailWebhookFingerprint,
  recordAuthEmailDeliveryEvent,
  type AuthEmailWebhookEvent,
} from "@/lib/auth-email-delivery";
import {
  recordPlatformEmailDeliverySuppression,
  type DeliverySuppressionReason,
} from "@/lib/platform-email-preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmailWebhookEvent = AuthEmailWebhookEvent;

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Email webhook payload too large" },
    { status: 413 },
  );
}

function verifiedEvent(
  rawBody: string,
  headers: Headers,
): WebhookEventPayload | null {
  const webhookSecret = emailEnv("RESEND_WEBHOOK_SECRET");
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");

  if (!webhookSecret || !id || !timestamp || !signature) return null;

  try {
    const resend = new Resend(
      emailEnv("RESEND_API_KEY") ?? "re_webhook_verify",
    );
    return resend.webhooks.verify({
      payload: rawBody,
      webhookSecret,
      headers: { id, timestamp, signature },
    });
  } catch {
    return null;
  }
}

function isEmailWebhookEvent(
  event: WebhookEventPayload,
): event is EmailWebhookEvent {
  const data = (event as { data?: { email_id?: unknown; to?: unknown } }).data;
  return typeof data?.email_id === "string" && Array.isArray(data.to);
}

function communicationStatusForEvent(
  type: WebhookEventPayload["type"],
): "delivered" | "failed" | null {
  if (type === "email.delivered") return "delivered";
  if (
    type === "email.bounced" ||
    type === "email.complained" ||
    type === "email.failed" ||
    type === "email.suppressed"
  ) {
    return "failed";
  }
  return null;
}

function suppressionReasonForEvent(
  type: WebhookEventPayload["type"],
): EmailSuppressionReason | null {
  if (type === "email.bounced") return "bounce";
  if (type === "email.complained") return "complaint";
  if (type === "email.suppressed") return "suppressed";
  return null;
}

function platformSuppressionReasonForEvent(
  type: WebhookEventPayload["type"],
): DeliverySuppressionReason | null {
  if (type === "email.bounced") return "bounce";
  if (type === "email.complained") return "complaint";
  if (type === "email.suppressed") return "provider_suppressed";
  return null;
}

function eventDetail(event: EmailWebhookEvent): string {
  if (event.type === "email.bounced") {
    return event.data.bounce?.message || "Resend reported a hard bounce.";
  }
  if (event.type === "email.failed") {
    return (
      event.data.failed?.reason || "Resend reported email delivery failed."
    );
  }
  if (event.type === "email.suppressed") {
    return (
      event.data.suppressed?.message || "Resend reported recipient suppression."
    );
  }
  if (event.type === "email.complained") {
    return "Resend reported a recipient spam complaint.";
  }
  return `Resend event ${event.type}`;
}

function groupByPractice(
  rows: Array<{ id: string; practiceId: string }>,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    grouped.set(row.practiceId, [
      ...(grouped.get(row.practiceId) ?? []),
      row.id,
    ]);
  }
  return grouped;
}

function isPlatformLifecycleCommunication(row: {
  clientId: string | null;
  dedupeKey: string | null;
}): boolean {
  return row.clientId === null && row.dedupeKey?.startsWith("lc:") === true;
}

function normalizedRecipients(event: EmailWebhookEvent): string[] {
  return Array.from(
    new Set(
      event.data.to
        .map((email) => normalizeEmailSuppressionAddress(email))
        .filter((email): email is string => Boolean(email)),
    ),
  );
}

export async function POST(request: Request) {
  if (emailWebhookContentLengthTooLarge(request.headers)) {
    return payloadTooLargeResponse();
  }

  const rawBody = await readRequestTextWithLimit(
    request,
    EMAIL_WEBHOOK_BODY_MAX_BYTES,
  );
  if (!rawBody.ok) {
    return payloadTooLargeResponse();
  }

  const event = verifiedEvent(rawBody.text, request.headers);
  if (!event) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (!isEmailWebhookEvent(event)) {
    return NextResponse.json({ ok: true });
  }

  // Account-verification mail is system auth traffic, not a clinic-to-client
  // communication. Claim its redacted evidence first and never turn its
  // recipient into a clinic email suppression.
  const authDelivery = await recordAuthEmailDeliveryEvent({
    event,
    webhookId: request.headers.get("svix-id")!,
    rawBodyFingerprint: authEmailWebhookFingerprint(rawBody.text),
    db,
  });
  if (authDelivery.tracked) {
    const platformSuppressionReason = platformSuppressionReasonForEvent(
      event.type,
    );
    if (platformSuppressionReason) {
      for (const email of normalizedRecipients(event)) {
        await recordPlatformEmailDeliverySuppression({
          email,
          reason: platformSuppressionReason,
          providerMessageId: event.data.email_id,
          webhookId: request.headers.get("svix-id")!,
        });
      }
    }
    // Identity conflicts are acknowledged only after the recorder durably
    // quarantines safe fingerprint/provider evidence. A database failure
    // throws above and remains retryable; a committed conflict must not cause
    // an infinite provider retry loop.
    return NextResponse.json({ ok: true });
  }

  const status = communicationStatusForEvent(event.type);
  const suppressionReason = suppressionReasonForEvent(event.type);
  const platformSuppressionReason = platformSuppressionReasonForEvent(
    event.type,
  );
  if (!status && !suppressionReason) {
    return NextResponse.json({ ok: true });
  }

  const matches = await withSystem(db, (tx) =>
    tx
      .select({
        id: communications.id,
        practiceId: communications.practiceId,
        clientId: communications.clientId,
        dedupeKey: communications.dedupeKey,
      })
      .from(communications)
      .innerJoin(
        practices,
        and(
          eq(practices.id, communications.practiceId),
          isNull(practices.deletedAt),
        ),
      )
      .where(
        and(
          eq(communications.providerMessageId, event.data.email_id),
          eq(communications.channel, "email"),
          eq(communications.direction, "outbound"),
          isNull(communications.deletedAt),
        ),
      )
      .limit(20),
  );

  const recipients = normalizedRecipients(event);
  const detail = eventDetail(event);
  const platformLifecycleMatched = matches.some(
    isPlatformLifecycleCommunication,
  );
  const clinicSuppressionPracticeIds = new Set(
    matches
      .filter((match) => !isPlatformLifecycleCommunication(match))
      .map((match) => match.practiceId),
  );

  if (
    platformSuppressionReason &&
    platformLifecycleMatched &&
    recipients.length > 0
  ) {
    for (const email of recipients) {
      await recordPlatformEmailDeliverySuppression({
        email,
        reason: platformSuppressionReason,
        providerMessageId: event.data.email_id,
        webhookId: request.headers.get("svix-id")!,
      });
    }
  }

  for (const [practiceId, communicationIds] of groupByPractice(matches)) {
    await withTenant(db, practiceId, async (tx) => {
      if (status && communicationIds.length > 0) {
        await tx
          .update(communications)
          .set({ status })
          .where(
            and(
              eq(communications.practiceId, practiceId),
              inArray(communications.id, communicationIds),
              eq(communications.channel, "email"),
              eq(communications.direction, "outbound"),
              inArray(
                communications.status,
                status === "delivered"
                  ? ["pending", "sent"]
                  : ["pending", "sent", "delivered"],
              ),
              isNull(communications.deletedAt),
            ),
          );
      }

      if (
        suppressionReason &&
        recipients.length > 0 &&
        clinicSuppressionPracticeIds.has(practiceId)
      ) {
        await tx
          .insert(emailSuppressions)
          .values(
            recipients.map((email) => ({
              practiceId,
              email,
              reason: suppressionReason,
              detail,
            })),
          )
          .onConflictDoNothing({
            target: [emailSuppressions.practiceId, emailSuppressions.email],
          });
      }
    });
  }

  return NextResponse.json({ ok: true });
}
