import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { WebhookEventPayload } from "resend";
import { db as defaultDb } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { authEmailAttempts, authEmailDeliveryEvents } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import {
  sendVerificationEmailWithProviderEvidence,
  type EmailProviderOutcome,
} from "@/lib/email";

export type AuthEmailSource = "registration" | "authenticated_resend";

export interface TrackedVerificationEmailResult {
  success: boolean;
  attemptId: string;
  outcome: EmailProviderOutcome;
  providerMessageId?: string;
  error?: string;
}

/**
 * Reserve, dispatch, and record one verification email. The provider call is
 * intentionally outside every database transaction. No recipient or auth-link
 * content is copied into the operational ledger.
 */
export async function sendTrackedVerificationEmail(input: {
  practiceId: string;
  userId: string;
  source: AuthEmailSource;
  to: string;
  name: string;
  verifyUrl: string;
  db?: Database;
}): Promise<TrackedVerificationEmailResult> {
  const database = input.db ?? defaultDb;
  const attemptId = randomUUID();
  const idempotencyKey = `auth-email:${attemptId}`;

  await withSystem(database, async (tx) => {
    await tx.insert(authEmailAttempts).values({
      id: attemptId,
      practiceId: input.practiceId,
      userId: input.userId,
      source: input.source,
      idempotencyKey,
    });
  });

  const providerResult = await sendVerificationEmailWithProviderEvidence({
    to: input.to,
    name: input.name,
    verifyUrl: input.verifyUrl,
    attemptId,
    idempotencyKey,
  });
  const recordedOutcome: EmailProviderOutcome =
    providerResult.outcome === "accepted" && !providerResult.id
      ? "outcome_unknown"
      : providerResult.outcome;
  const resolvedAt = new Date();
  const [recorded] = await withSystem(database, (tx) =>
    tx
      .update(authEmailAttempts)
      .set({
        outcome: recordedOutcome,
        resolvedAt,
        providerMessageId:
          recordedOutcome === "accepted" ? providerResult.id : null,
        failureCode:
          recordedOutcome === "accepted"
            ? null
            : (providerResult.failureCode ??
              (providerResult.outcome === "accepted"
                ? "missing_provider_id"
                : "provider_exception")),
      })
      .where(
        and(
          eq(authEmailAttempts.id, attemptId),
          eq(authEmailAttempts.outcome, "reserved"),
        ),
      )
      .returning({ id: authEmailAttempts.id }),
  );

  if (!recorded) {
    throw new Error(
      "Verification email provider outcome could not be recorded safely.",
    );
  }

  return {
    success: providerResult.success && recordedOutcome === "accepted",
    attemptId,
    outcome: recordedOutcome,
    ...(recordedOutcome === "accepted" && providerResult.id
      ? { providerMessageId: providerResult.id }
      : {}),
    ...(recordedOutcome === "definite_failure"
      ? { error: "Email provider did not accept the verification message." }
      : recordedOutcome === "outcome_unknown"
        ? {
            error:
              "Email provider outcome is unknown; do not retry automatically.",
          }
        : {}),
  };
}

export type AuthEmailWebhookEvent = Extract<
  WebhookEventPayload,
  { data: { email_id: string; to: string[] } }
>;

type AuthEmailDeliveryClassification =
  | "sent"
  | "delivered"
  | "delayed"
  | "failed"
  | "complained"
  | "opened"
  | "clicked"
  | "unknown";

export function authEmailDeliveryClassification(
  eventType: WebhookEventPayload["type"],
): AuthEmailDeliveryClassification {
  switch (eventType) {
    case "email.sent":
    case "email.scheduled":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delayed";
    case "email.bounced":
    case "email.failed":
    case "email.suppressed":
      return "failed";
    case "email.complained":
      return "complained";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    default:
      return "unknown";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function providerOccurredAt(event: AuthEmailWebhookEvent): Date {
  const candidates = [event.created_at, event.data.created_at];
  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export interface AuthEmailDeliveryRecordResult {
  tracked: boolean;
  duplicate: boolean;
  attribution:
    | "attempt_tag"
    | "provider_message_id"
    | "unmatched"
    | "identity_conflict"
    | null;
}

/**
 * Claim a signed Resend delivery event without retaining its recipient,
 * subject, tags, or payload. Attempt tags are authoritative when consistent;
 * provider-message identity is the exact fallback. Every event is append-only.
 */
export async function recordAuthEmailDeliveryEvent(input: {
  event: AuthEmailWebhookEvent;
  webhookId: string;
  db?: Database;
}): Promise<AuthEmailDeliveryRecordResult> {
  const database = input.db ?? defaultDb;
  const providerMessageId = input.event.data.email_id.trim();
  const webhookId = input.webhookId.trim();
  if (
    !providerMessageId ||
    providerMessageId.length > 128 ||
    !webhookId ||
    webhookId.length > 128
  ) {
    return { tracked: false, duplicate: false, attribution: null };
  }

  const tags =
    (input.event.data as { tags?: Record<string, string> }).tags ?? {};
  const taggedAttemptValue = tags.openvpm_attempt_id?.trim();
  const hasAuthTag =
    tags.openvpm_email_kind === "auth_verification" ||
    Boolean(taggedAttemptValue);

  return withSystem(database, async (tx) => {
    const [taggedAttempt] =
      taggedAttemptValue && UUID_PATTERN.test(taggedAttemptValue)
        ? await tx
            .select({
              id: authEmailAttempts.id,
              providerMessageId: authEmailAttempts.providerMessageId,
            })
            .from(authEmailAttempts)
            .where(eq(authEmailAttempts.id, taggedAttemptValue))
            .limit(1)
        : [];
    const [providerAttempt] = await tx
      .select({ id: authEmailAttempts.id })
      .from(authEmailAttempts)
      .where(
        and(
          eq(authEmailAttempts.provider, "resend"),
          eq(authEmailAttempts.providerMessageId, providerMessageId),
        ),
      )
      .limit(1);

    if (!hasAuthTag && !providerAttempt) {
      return { tracked: false, duplicate: false, attribution: null };
    }

    let attemptId: string | null = null;
    let attribution: Exclude<
      AuthEmailDeliveryRecordResult["attribution"],
      null
    >;
    const tagProviderMismatch =
      taggedAttempt?.providerMessageId !== null &&
      taggedAttempt?.providerMessageId !== undefined &&
      taggedAttempt.providerMessageId !== providerMessageId;
    if (
      taggedAttempt &&
      (tagProviderMismatch ||
        (providerAttempt && providerAttempt.id !== taggedAttempt.id))
    ) {
      attribution = "identity_conflict";
    } else if (taggedAttempt) {
      attemptId = taggedAttempt.id;
      attribution = "attempt_tag";
    } else if (providerAttempt) {
      attemptId = providerAttempt.id;
      attribution = "provider_message_id";
    } else {
      attribution = "unmatched";
    }

    const [inserted] = await tx
      .insert(authEmailDeliveryEvents)
      .values({
        webhookId,
        providerMessageId,
        attemptId,
        eventType: input.event.type,
        classification: authEmailDeliveryClassification(input.event.type),
        attribution,
        occurredAt: providerOccurredAt(input.event),
      })
      .onConflictDoNothing({ target: authEmailDeliveryEvents.webhookId })
      .returning({ id: authEmailDeliveryEvents.id });

    return { tracked: true, duplicate: !inserted, attribution };
  });
}
