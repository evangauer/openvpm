import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, ne } from "drizzle-orm";
import type { WebhookEventPayload } from "resend";
import type { Database } from "@openpims/db/client";
import { authEmailAttempts, authEmailDeliveryEvents } from "@openpims/db";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import {
  sendVerificationEmailWithProviderEvidence,
  verificationEmailProvider,
  type EmailProvider,
  type EmailProviderOutcome,
} from "@/lib/email";

export type AuthEmailSource = "registration" | "authenticated_resend";

export interface TrackedVerificationEmailResult {
  success: boolean;
  attemptId: string;
  provider: EmailProvider;
  outcome: EmailProviderOutcome;
  possiblySent: boolean;
  evidencePersisted: boolean;
  providerMessageId?: string;
  identityConflict?: boolean;
  error?: string;
}

type AttemptState = {
  outcome: EmailProviderOutcome | "reserved";
  provider: EmailProvider;
  providerMessageId: string | null;
  failureCode: string | null;
};

async function safeAuthEmailAlert(subject: string, detail: string) {
  // Both arguments are constants chosen by this module. Never pass provider
  // errors, recipient data, URLs, tokens, or message identifiers here.
  await alertOps(subject, detail).catch(() => undefined);
}

async function readAttemptState(
  database: Database,
  attemptId: string,
): Promise<AttemptState | null> {
  const [state] = await withSystem(database, (tx) =>
    tx
      .select({
        outcome: authEmailAttempts.outcome,
        provider: authEmailAttempts.provider,
        providerMessageId: authEmailAttempts.providerMessageId,
        failureCode: authEmailAttempts.failureCode,
      })
      .from(authEmailAttempts)
      .where(eq(authEmailAttempts.id, attemptId))
      .limit(1),
  );
  return (state as AttemptState | undefined) ?? null;
}

async function persistAttemptOutcome(input: {
  database: Database;
  attemptId: string;
  outcome: EmailProviderOutcome;
  providerMessageId: string | null;
  failureCode: string | null;
}): Promise<{ persisted: boolean; state: AttemptState | null }> {
  // Each iteration is an independent top-level transaction. This safely
  // handles both a transient failure and the ambiguous "commit succeeded but
  // acknowledgement was lost" case without ever replaying the provider call.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const [recorded] = await withSystem(input.database, (tx) =>
        tx
          .update(authEmailAttempts)
          .set({
            outcome: input.outcome,
            resolvedAt: new Date(),
            providerMessageId: input.providerMessageId,
            failureCode: input.failureCode,
          })
          .where(
            and(
              eq(authEmailAttempts.id, input.attemptId),
              eq(authEmailAttempts.outcome, "reserved"),
            ),
          )
          .returning({
            outcome: authEmailAttempts.outcome,
            provider: authEmailAttempts.provider,
            providerMessageId: authEmailAttempts.providerMessageId,
            failureCode: authEmailAttempts.failureCode,
          }),
      );
      if (recorded) {
        return { persisted: true, state: recorded as AttemptState };
      }

      // A signed webhook may have repaired the reservation while the provider
      // result was in flight. Read it rather than attempting to rewrite a
      // resolved, immutable state.
      return {
        persisted: false,
        state: await readAttemptState(input.database, input.attemptId),
      };
    } catch {
      // Retry only the idempotent CAS; the provider call is never repeated.
    }
  }

  try {
    return {
      persisted: false,
      state: await readAttemptState(input.database, input.attemptId),
    };
  } catch {
    return { persisted: false, state: null };
  }
}

function stateMatchesOutcome(
  state: AttemptState | null,
  input: {
    provider: EmailProvider;
    outcome: EmailProviderOutcome;
    providerMessageId: string | null;
    failureCode: string | null;
  },
): boolean {
  return Boolean(
    state &&
    state.provider === input.provider &&
    state.outcome === input.outcome &&
    state.providerMessageId === input.providerMessageId &&
    state.failureCode === input.failureCode,
  );
}

async function hasDeliveryIdentityMismatch(input: {
  database: Database;
  attemptId: string;
  providerMessageId: string;
}): Promise<boolean> {
  try {
    const [mismatch] = await withSystem(input.database, (tx) =>
      tx
        .select({ id: authEmailDeliveryEvents.id })
        .from(authEmailDeliveryEvents)
        .where(
          and(
            eq(authEmailDeliveryEvents.attemptId, input.attemptId),
            eq(authEmailDeliveryEvents.provider, "resend"),
            ne(
              authEmailDeliveryEvents.providerMessageId,
              input.providerMessageId,
            ),
          ),
        )
        .limit(1),
    );
    return Boolean(mismatch);
  } catch {
    await safeAuthEmailAlert(
      "Auth email identity revalidation failed",
      "A verification provider result could not be compared with signed delivery evidence. Review the recovery queue.",
    );
    return false;
  }
}

/**
 * Reserve, dispatch, and record one verification email. Callers must invoke
 * this from a tRPC post-commit effect with the root pool. Reservation and
 * resolution each use their own top-level system transaction; the provider
 * call occurs between them, outside every database transaction. No recipient
 * or auth-link content is copied into the ledger or operational alerts.
 */
export async function sendTrackedVerificationEmail(input: {
  practiceId: string;
  userId: string;
  source: AuthEmailSource;
  to: string;
  name: string;
  verifyUrl: string;
  db: Database;
}): Promise<TrackedVerificationEmailResult> {
  const attemptId = randomUUID();
  const idempotencyKey = `auth-email:${attemptId}`;
  const provider = verificationEmailProvider();

  try {
    await withSystem(input.db, async (tx) => {
      await tx.insert(authEmailAttempts).values({
        id: attemptId,
        practiceId: input.practiceId,
        userId: input.userId,
        source: input.source,
        provider,
        idempotencyKey,
      });
    });
  } catch {
    await safeAuthEmailAlert(
      "Auth email reservation failed",
      "A verification dispatch was not attempted because its durable reservation could not be committed.",
    );
    return {
      success: false,
      attemptId,
      provider,
      outcome: "definite_failure",
      possiblySent: false,
      evidencePersisted: false,
      error:
        "Verification email could not be prepared. Please try again later.",
    };
  }

  const providerResult = await sendVerificationEmailWithProviderEvidence({
    to: input.to,
    name: input.name,
    verifyUrl: input.verifyUrl,
    attemptId,
    idempotencyKey,
  });
  const providerIdentityConflict = providerResult.provider !== provider;
  const recordedOutcome: EmailProviderOutcome =
    providerIdentityConflict ||
    (providerResult.outcome === "accepted" && !providerResult.id)
      ? "outcome_unknown"
      : providerResult.outcome;
  const providerMessageId =
    recordedOutcome === "accepted" ? (providerResult.id ?? null) : null;
  const failureCode =
    recordedOutcome === "accepted"
      ? null
      : (providerResult.failureCode ??
        (providerResult.outcome === "accepted"
          ? "missing_provider_id"
          : "provider_exception"));

  const resolution = await persistAttemptOutcome({
    database: input.db,
    attemptId,
    outcome: recordedOutcome,
    providerMessageId,
    failureCode,
  });
  const consistentState = stateMatchesOutcome(resolution.state, {
    provider,
    outcome: recordedOutcome,
    providerMessageId,
    failureCode,
  });

  let identityConflict = providerIdentityConflict;
  if (
    recordedOutcome === "accepted" &&
    provider === "resend" &&
    providerMessageId
  ) {
    identityConflict =
      identityConflict ||
      (resolution.state?.outcome === "accepted" &&
        resolution.state.providerMessageId !== providerMessageId) ||
      (await hasDeliveryIdentityMismatch({
        database: input.db,
        attemptId,
        providerMessageId,
      }));
  }

  const evidencePersisted = consistentState && !identityConflict;
  if (!evidencePersisted) {
    await safeAuthEmailAlert(
      identityConflict
        ? "Auth email provider identity conflict"
        : "Auth email outcome persistence failed",
      identityConflict
        ? "Provider acceptance disagrees with durable signed verification evidence. Review the recovery queue."
        : "A verification provider outcome could not be confirmed in the durable ledger. Review the recovery queue.",
    );
  }

  // Once the provider is known to have accepted a message, persistence trouble
  // must never encourage an immediate duplicate. The signed tagged webhook can
  // still repair an old reserved attempt to this accepted identity.
  if (
    providerResult.outcome === "accepted" &&
    providerResult.id &&
    !providerIdentityConflict
  ) {
    return {
      success: true,
      attemptId,
      provider,
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted,
      providerMessageId: providerResult.id,
      ...(identityConflict ? { identityConflict: true } : {}),
    };
  }

  if (recordedOutcome === "outcome_unknown") {
    return {
      success: false,
      attemptId,
      provider,
      outcome: "outcome_unknown",
      possiblySent: true,
      evidencePersisted,
      ...(identityConflict ? { identityConflict: true } : {}),
      error:
        "Verification email may have been sent. Check your inbox before requesting another.",
    };
  }

  return {
    success: false,
    attemptId,
    provider,
    outcome: "definite_failure",
    possiblySent: false,
    evidencePersisted,
    error: "Email provider did not accept the verification message.",
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const AUTH_EMAIL_WEBHOOK_REPAIR_MIN_AGE_MS = 15_000;

export function authEmailWebhookFingerprint(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

function providerOccurredAt(event: AuthEmailWebhookEvent): Date {
  const candidates = [event.created_at, event.data.created_at];
  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function isOutboundAuthEmailEvent(type: WebhookEventPayload["type"]): boolean {
  return type.startsWith("email.") && type !== "email.received";
}

export interface AuthEmailDeliveryRecordResult {
  tracked: boolean;
  duplicate: boolean;
  conflict: boolean;
  attribution:
    | "attempt_tag"
    | "provider_message_id"
    | "unmatched"
    | "identity_conflict"
    | null;
}

type ExistingWebhookIdentity = {
  rawBodyFingerprint: string;
  provider: string;
  providerMessageId: string;
  eventType: string;
  attribution:
    | "attempt_tag"
    | "provider_message_id"
    | "unmatched"
    | "identity_conflict";
};

function duplicateResult(
  existing: ExistingWebhookIdentity,
  input: {
    rawBodyFingerprint: string;
    providerMessageId: string;
    eventType: string;
  },
): AuthEmailDeliveryRecordResult {
  const exact =
    existing.rawBodyFingerprint === input.rawBodyFingerprint &&
    existing.provider === "resend" &&
    existing.providerMessageId === input.providerMessageId &&
    existing.eventType === input.eventType;
  return {
    tracked: true,
    duplicate: exact,
    conflict: !exact,
    attribution: exact ? existing.attribution : "identity_conflict",
  };
}

/**
 * Claim a signed Resend delivery event without retaining its recipient,
 * subject, tags, or payload. The SHA-256 fingerprint proves whether a repeated
 * Svix id carried the exact same verified raw body. Early tagged callbacks are
 * linked immediately but repair a reserved attempt only after the API timeout
 * window, preventing an out-of-order callback from racing a different provider
 * result. Opens/clicks are redacted evidence only and never verify a user.
 */
export async function recordAuthEmailDeliveryEvent(input: {
  event: AuthEmailWebhookEvent;
  webhookId: string;
  rawBodyFingerprint: string;
  db: Database;
}): Promise<AuthEmailDeliveryRecordResult> {
  const providerMessageId = input.event.data.email_id.trim();
  const webhookId = input.webhookId.trim();
  const rawBodyFingerprint = input.rawBodyFingerprint.trim();
  if (
    !providerMessageId ||
    providerMessageId.length > 128 ||
    !webhookId ||
    webhookId.length > 128 ||
    !SHA256_PATTERN.test(rawBodyFingerprint)
  ) {
    return {
      tracked: false,
      duplicate: false,
      conflict: false,
      attribution: null,
    };
  }

  const tags =
    (input.event.data as { tags?: Record<string, string> }).tags ?? {};
  const taggedAttemptValue = tags.openvpm_attempt_id?.trim();
  const hasAuthTag =
    tags.openvpm_email_kind === "auth_verification" ||
    Boolean(taggedAttemptValue);

  const result = await withSystem(input.db, async (tx) => {
    const selectExistingWebhook = async () => {
      const [existing] = await tx
        .select({
          rawBodyFingerprint: authEmailDeliveryEvents.rawBodyFingerprint,
          provider: authEmailDeliveryEvents.provider,
          providerMessageId: authEmailDeliveryEvents.providerMessageId,
          eventType: authEmailDeliveryEvents.eventType,
          attribution: authEmailDeliveryEvents.attribution,
        })
        .from(authEmailDeliveryEvents)
        .where(eq(authEmailDeliveryEvents.webhookId, webhookId))
        .limit(1);
      return existing as ExistingWebhookIdentity | undefined;
    };

    const existing = await selectExistingWebhook();
    if (existing) {
      return duplicateResult(existing, {
        rawBodyFingerprint,
        providerMessageId,
        eventType: input.event.type,
      });
    }

    const [taggedAttempt] =
      taggedAttemptValue && UUID_PATTERN.test(taggedAttemptValue)
        ? await tx
            .select({
              id: authEmailAttempts.id,
              createdAt: authEmailAttempts.createdAt,
              outcome: authEmailAttempts.outcome,
              provider: authEmailAttempts.provider,
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
      return {
        tracked: false,
        duplicate: false,
        conflict: false,
        attribution: null,
      } satisfies AuthEmailDeliveryRecordResult;
    }

    let attemptId: string | null = null;
    let attribution: Exclude<
      AuthEmailDeliveryRecordResult["attribution"],
      null
    >;
    const tagProviderMismatch =
      taggedAttempt?.provider !== undefined &&
      (taggedAttempt.provider !== "resend" ||
        (taggedAttempt.providerMessageId !== null &&
          taggedAttempt.providerMessageId !== providerMessageId));
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
        rawBodyFingerprint,
        providerMessageId,
        attemptId,
        eventType: input.event.type,
        classification: authEmailDeliveryClassification(input.event.type),
        attribution,
        occurredAt: providerOccurredAt(input.event),
      })
      .onConflictDoNothing({ target: authEmailDeliveryEvents.webhookId })
      .returning({ id: authEmailDeliveryEvents.id });

    if (!inserted) {
      const racedExisting = await selectExistingWebhook();
      return racedExisting
        ? duplicateResult(racedExisting, {
            rawBodyFingerprint,
            providerMessageId,
            eventType: input.event.type,
          })
        : {
            tracked: true,
            duplicate: false,
            conflict: true,
            attribution: "identity_conflict" as const,
          };
    }

    if (
      taggedAttempt &&
      attribution === "attempt_tag" &&
      taggedAttempt.outcome === "reserved" &&
      taggedAttempt.createdAt.getTime() <=
        Date.now() - AUTH_EMAIL_WEBHOOK_REPAIR_MIN_AGE_MS &&
      isOutboundAuthEmailEvent(input.event.type)
    ) {
      await tx
        .update(authEmailAttempts)
        .set({
          outcome: "accepted",
          resolvedAt: new Date(),
          providerMessageId,
          failureCode: null,
        })
        .where(
          and(
            eq(authEmailAttempts.id, taggedAttempt.id),
            eq(authEmailAttempts.provider, "resend"),
            eq(authEmailAttempts.outcome, "reserved"),
            isNull(authEmailAttempts.providerMessageId),
            lte(
              authEmailAttempts.createdAt,
              new Date(Date.now() - AUTH_EMAIL_WEBHOOK_REPAIR_MIN_AGE_MS),
            ),
          ),
        );
    }

    return {
      tracked: true,
      duplicate: false,
      conflict: attribution === "identity_conflict",
      attribution,
    } satisfies AuthEmailDeliveryRecordResult;
  });

  if (result.conflict) {
    await safeAuthEmailAlert(
      "Auth email webhook identity conflict",
      "A signed verification callback disagreed with immutable provider evidence. Review the recovery queue.",
    );
  }
  return result;
}
