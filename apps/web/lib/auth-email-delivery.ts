import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { WebhookEventPayload } from "resend";
import type { Database } from "@openpims/db/client";
import {
  authEmailAttempts,
  authEmailDeliveryEvents,
  authEmailProviderIdentityConflicts,
  authEmailWebhookConflicts,
} from "@openpims/db";
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

async function hasSignedTaggedAcceptance(input: {
  database: Database;
  attemptId: string;
  providerMessageId: string;
}): Promise<boolean> {
  try {
    const [evidence] = await withSystem(input.database, (tx) =>
      tx
        .select({ id: authEmailDeliveryEvents.id })
        .from(authEmailDeliveryEvents)
        .where(
          and(
            eq(authEmailDeliveryEvents.attemptId, input.attemptId),
            eq(authEmailDeliveryEvents.provider, "resend"),
            eq(
              authEmailDeliveryEvents.providerMessageId,
              input.providerMessageId,
            ),
            eq(authEmailDeliveryEvents.attribution, "attempt_tag"),
          ),
        )
        .limit(1),
    );
    return Boolean(evidence);
  } catch {
    return false;
  }
}

async function persistProviderIdentityConflict(input: {
  database: Database;
  attemptId: string;
  source: AuthEmailSource;
  durableProviderMessageId: string;
  conflictingProviderMessageId: string;
}): Promise<"inserted" | "duplicate" | "failed"> {
  try {
    const [inserted] = await withSystem(input.database, (tx) =>
      tx
        .insert(authEmailProviderIdentityConflicts)
        .values({
          attemptId: input.attemptId,
          provider: "resend",
          source: input.source,
          durableProviderMessageId: input.durableProviderMessageId,
          conflictingProviderMessageId: input.conflictingProviderMessageId,
        })
        .onConflictDoNothing({
          target: [
            authEmailProviderIdentityConflicts.attemptId,
            authEmailProviderIdentityConflicts.provider,
            authEmailProviderIdentityConflicts.durableProviderMessageId,
            authEmailProviderIdentityConflicts.conflictingProviderMessageId,
          ],
        })
        .returning({ id: authEmailProviderIdentityConflicts.id }),
    );
    return inserted ? "inserted" : "duplicate";
  } catch {
    await safeAuthEmailAlert(
      "Auth email provider identity conflict persistence failed",
      "Conflicting verification provider identities could not be written to the durable ledger. Review auth email operations.",
    );
    return "failed";
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
  let consistentState = stateMatchesOutcome(resolution.state, {
    provider,
    outcome: recordedOutcome,
    providerMessageId,
    failureCode,
  });

  // A signed tagged callback can win the race after a provider timeout but
  // before this resolver observes the ledger. Treat that stronger durable
  // evidence as acceptance instead of telling the user the result is unknown.
  const signedAcceptedState =
    provider === "resend" &&
    recordedOutcome === "outcome_unknown" &&
    resolution.state?.outcome === "accepted" &&
    Boolean(resolution.state.providerMessageId) &&
    (await hasSignedTaggedAcceptance({
      database: input.db,
      attemptId,
      providerMessageId: resolution.state?.providerMessageId ?? "",
    }));
  consistentState = consistentState || signedAcceptedState;

  const resolutionIdentityConflict = Boolean(
    recordedOutcome === "accepted" &&
    provider === "resend" &&
    providerMessageId &&
    resolution.state?.outcome === "accepted" &&
    resolution.state.providerMessageId &&
    resolution.state.providerMessageId !== providerMessageId,
  );
  const conflictPersistence = resolutionIdentityConflict
    ? await persistProviderIdentityConflict({
        database: input.db,
        attemptId,
        source: input.source,
        durableProviderMessageId: resolution.state?.providerMessageId ?? "",
        conflictingProviderMessageId: providerMessageId ?? "",
      })
    : null;

  let deliveryIdentityConflict = false;
  if (
    !resolutionIdentityConflict &&
    recordedOutcome === "accepted" &&
    provider === "resend" &&
    providerMessageId
  ) {
    deliveryIdentityConflict = await hasDeliveryIdentityMismatch({
      database: input.db,
      attemptId,
      providerMessageId,
    });
  }

  const identityConflict =
    providerIdentityConflict ||
    resolutionIdentityConflict ||
    deliveryIdentityConflict;
  const shouldAlertIdentityConflict =
    providerIdentityConflict ||
    deliveryIdentityConflict ||
    conflictPersistence === "inserted";

  const evidencePersisted = consistentState && !identityConflict;
  if (!evidencePersisted) {
    if (identityConflict) {
      if (shouldAlertIdentityConflict) {
        await safeAuthEmailAlert(
          "Auth email provider identity conflict",
          "Provider acceptance disagrees with durable signed verification evidence. Review the recovery queue.",
        );
      }
    } else {
      await safeAuthEmailAlert(
        "Auth email outcome persistence failed",
        "A verification provider outcome could not be confirmed in the durable ledger. Review the recovery queue.",
      );
    }
  }

  if (signedAcceptedState && resolution.state?.providerMessageId) {
    return {
      success: true,
      attemptId,
      provider,
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: true,
      providerMessageId: resolution.state.providerMessageId,
    };
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
  attemptId: string | null;
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
 * Svix id carried the exact same verified raw body. Signed callbacks carrying
 * both OpenVPM verification tags may repair a reserved or unknown Resend
 * attempt immediately; a conflicting provider identity is quarantined instead.
 * Opens/clicks are redacted evidence only and never verify a user.
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
  const hasExactAuthAttemptTag =
    tags.openvpm_email_kind === "auth_verification" &&
    Boolean(taggedAttemptValue && UUID_PATTERN.test(taggedAttemptValue));

  const result = await withSystem(input.db, async (tx) => {
    type TaggedAttempt = {
      id: string;
      outcome: AttemptState["outcome"];
      provider: EmailProvider;
      providerMessageId: string | null;
    };
    type InternalResult = AuthEmailDeliveryRecordResult & {
      alertConflict: boolean;
    };

    const selectExistingWebhook = async () => {
      const [existing] = await tx
        .select({
          rawBodyFingerprint: authEmailDeliveryEvents.rawBodyFingerprint,
          provider: authEmailDeliveryEvents.provider,
          providerMessageId: authEmailDeliveryEvents.providerMessageId,
          eventType: authEmailDeliveryEvents.eventType,
          attemptId: authEmailDeliveryEvents.attemptId,
          attribution: authEmailDeliveryEvents.attribution,
        })
        .from(authEmailDeliveryEvents)
        .where(eq(authEmailDeliveryEvents.webhookId, webhookId))
        .limit(1);
      return existing as ExistingWebhookIdentity | undefined;
    };

    const selectTaggedAttempt = async (): Promise<
      TaggedAttempt | undefined
    > => {
      if (!taggedAttemptValue || !UUID_PATTERN.test(taggedAttemptValue)) {
        return undefined;
      }
      const [attempt] = await tx
        .select({
          id: authEmailAttempts.id,
          outcome: authEmailAttempts.outcome,
          provider: authEmailAttempts.provider,
          providerMessageId: authEmailAttempts.providerMessageId,
        })
        .from(authEmailAttempts)
        .where(eq(authEmailAttempts.id, taggedAttemptValue))
        .limit(1);
      return attempt as TaggedAttempt | undefined;
    };

    const repairSignedTaggedAttempt = async (
      attempt: TaggedAttempt | undefined,
      expectedAttemptId?: string | null,
    ) => {
      if (
        !hasExactAuthAttemptTag ||
        !isOutboundAuthEmailEvent(input.event.type) ||
        !attempt ||
        (expectedAttemptId !== undefined &&
          expectedAttemptId !== taggedAttemptValue) ||
        attempt.provider !== "resend" ||
        (attempt.providerMessageId !== null &&
          attempt.providerMessageId !== providerMessageId)
      ) {
        return;
      }
      if (
        attempt.outcome !== "reserved" &&
        attempt.outcome !== "outcome_unknown"
      ) {
        return;
      }
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
            eq(authEmailAttempts.id, attempt.id),
            eq(authEmailAttempts.provider, "resend"),
            isNull(authEmailAttempts.providerMessageId),
            or(
              eq(authEmailAttempts.outcome, "reserved"),
              eq(authEmailAttempts.outcome, "outcome_unknown"),
            ),
          ),
        );
    };

    const quarantineChangedWebhook = async (
      existing: ExistingWebhookIdentity,
    ): Promise<InternalResult> => {
      const conflict = duplicateResult(existing, {
        rawBodyFingerprint,
        providerMessageId,
        eventType: input.event.type,
      });
      const [inserted] = await tx
        .insert(authEmailWebhookConflicts)
        .values({
          originalWebhookId: webhookId,
          incomingRawBodyFingerprint: rawBodyFingerprint,
          provider: "resend",
          incomingProviderMessageId: providerMessageId,
          incomingEventType: input.event.type,
        })
        .onConflictDoNothing({
          target: [
            authEmailWebhookConflicts.originalWebhookId,
            authEmailWebhookConflicts.incomingRawBodyFingerprint,
          ],
        })
        .returning({ id: authEmailWebhookConflicts.id });
      return { ...conflict, alertConflict: Boolean(inserted) };
    };

    const existing = await selectExistingWebhook();
    if (existing) {
      const duplicate = duplicateResult(existing, {
        rawBodyFingerprint,
        providerMessageId,
        eventType: input.event.type,
      });
      if (duplicate.duplicate) {
        if (
          existing.attribution === "attempt_tag" &&
          existing.attemptId === taggedAttemptValue
        ) {
          await repairSignedTaggedAttempt(
            await selectTaggedAttempt(),
            existing.attemptId,
          );
        }
        return { ...duplicate, alertConflict: false };
      }
      return quarantineChangedWebhook(existing);
    }

    const taggedAttempt = await selectTaggedAttempt();
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
        alertConflict: false,
      } satisfies InternalResult;
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
      if (!racedExisting) {
        throw new Error("Webhook identity winner could not be read.");
      }
      const racedDuplicate = duplicateResult(racedExisting, {
        rawBodyFingerprint,
        providerMessageId,
        eventType: input.event.type,
      });
      if (racedDuplicate.duplicate) {
        if (
          racedExisting.attribution === "attempt_tag" &&
          racedExisting.attemptId === taggedAttemptValue
        ) {
          await repairSignedTaggedAttempt(
            taggedAttempt,
            racedExisting.attemptId,
          );
        }
        return { ...racedDuplicate, alertConflict: false };
      }
      return quarantineChangedWebhook(racedExisting);
    }

    if (
      taggedAttempt &&
      attribution === "attempt_tag" &&
      hasExactAuthAttemptTag
    ) {
      await repairSignedTaggedAttempt(taggedAttempt, taggedAttempt.id);
    }

    return {
      tracked: true,
      duplicate: false,
      conflict: attribution === "identity_conflict",
      attribution,
      alertConflict: attribution === "identity_conflict",
    } satisfies InternalResult;
  });

  if (result.alertConflict) {
    await safeAuthEmailAlert(
      "Auth email webhook identity conflict",
      "A signed verification callback disagreed with immutable provider evidence. Review the recovery queue.",
    );
  }
  const { alertConflict: _alertConflict, ...publicResult } = result;
  return publicResult;
}
