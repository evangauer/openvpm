import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  communications,
  lifecycleEmailAttempts,
  lifecycleEmailJobs,
  practices,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingContactEmail } from "@/lib/billing/contact";
import { emailPreferenceRecipientHash } from "@/lib/email-preferences";
import {
  dispatchPreparedEmailWithProviderEvidence,
  emailProviderForDispatch,
  prepareSubscriptionCanceledEmail,
  prepareSubscriptionConfirmedEmail,
  type EmailDispatchOptions,
  type EmailProviderEvidence,
} from "@/lib/email";
import { withSystem } from "@/lib/tenant-db";

export type SubscriptionLifecycleEmailKind =
  | "subscription_confirmed"
  | "subscription_canceled";

const LEASE_MS = 5 * 60 * 1000;
const RECOVERY_RECHECK_MS = 15 * 60 * 1000;
const UNKNOWN_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_DEFINITE_ATTEMPTS = 5;
const MAX_UNKNOWN_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000];

export type LifecycleEmailBatchMetrics = {
  claimed: number;
  errors: number;
  delivered: number;
  retried: number;
  blocked: number;
  suppressed: number;
  failed: number;
  outcomeUnknown: number;
};

type LifecycleEmailProcessResult = Exclude<
  keyof LifecycleEmailBatchMetrics,
  "claimed" | "errors"
>;

type ClaimedJob = {
  id: string;
  leaseToken: string;
};

type EligibleJob = {
  id: string;
  practiceId: string;
  kind: string;
  providerIdempotencyKey: string;
  recipientHashSha256: string;
  practiceName: string;
  subscriptionId: string;
};

type Reservation =
  | { action: "send"; attemptId: string; attemptNumber: number }
  | { action: "blocked" | "suppressed" | "unknown" };

/**
 * Insert the communication and provider job in the caller's Stripe transaction.
 * The job intentionally contains no recipient address or rendered email body.
 */
export async function enqueueSubscriptionLifecycleEmail(
  tx: Database,
  input: {
    practiceId: string;
    practiceName: string;
    recipient: string;
    kind: SubscriptionLifecycleEmailKind;
    subscriptionId: string;
    subscriptionGeneration: number;
    dedupeKey: string;
  },
): Promise<boolean> {
  const recipient = billingContactEmail(input.recipient);
  if (!recipient) return false;

  const [communication] = await tx
    .insert(communications)
    .values({
      practiceId: input.practiceId,
      clientId: null,
      channel: "email",
      direction: "outbound",
      subject: input.kind,
      content: input.kind,
      status: "pending",
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({ id: communications.id });
  if (!communication) return false;

  await tx.insert(lifecycleEmailJobs).values({
    practiceId: input.practiceId,
    communicationId: communication.id,
    kind: input.kind,
    dedupeKey: input.dedupeKey,
    providerIdempotencyKey: input.dedupeKey,
    recipientHashSha256: recipientHash(input.practiceId, recipient),
    practiceName: input.practiceName.trim() || "your practice",
    subscriptionId: input.subscriptionId,
    subscriptionGeneration: input.subscriptionGeneration,
  });
  return true;
}

export async function runLifecycleEmailBatch(
  limit = 25,
  now?: Date,
): Promise<LifecycleEmailBatchMetrics> {
  const metrics: LifecycleEmailBatchMetrics = {
    claimed: 0,
    errors: 0,
    delivered: 0,
    retried: 0,
    blocked: 0,
    suppressed: 0,
    failed: 0,
    outcomeUnknown: 0,
  };

  for (let index = 0; index < limit; index++) {
    const iterationNow = now ?? new Date();
    const claimed = await claimNextJob(iterationNow);
    if (!claimed) break;
    metrics.claimed++;
    try {
      const result = await processClaimedJob(claimed, iterationNow);
      metrics[result]++;
    } catch {
      metrics.errors++;
      try {
        await recoverClaimedJobAfterError(claimed, iterationNow);
      } catch {
        console.error(
          "[lifecycle-emails] failed to recover claimed job; details redacted",
        );
      }
      try {
        await alertOps(
          "Lifecycle email worker error",
          `job=${claimed.id} outcome=worker_error`,
        );
      } catch {
        // The durable lease/backoff state and cron heartbeat remain authoritative.
      }
    }
  }
  return metrics;
}

async function recoverClaimedJobAfterError(
  claimed: ClaimedJob,
  now: Date,
): Promise<void> {
  await withSystem(db, async (tx) => {
    const [job] = await tx
      .select({
        id: lifecycleEmailJobs.id,
        attemptCount: lifecycleEmailJobs.attemptCount,
      })
      .from(lifecycleEmailJobs)
      .where(
        and(
          eq(lifecycleEmailJobs.id, claimed.id),
          eq(lifecycleEmailJobs.state, "delivering"),
          eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken),
        ),
      )
      .limit(1)
      .for("update");
    if (!job) return;

    const [unresolvedAttempt] = await tx
      .select({ id: lifecycleEmailAttempts.id })
      .from(lifecycleEmailAttempts)
      .where(
        and(
          eq(lifecycleEmailAttempts.jobId, job.id),
          isNull(lifecycleEmailAttempts.resolvedAt),
        ),
      )
      .limit(1);
    const ambiguous = Boolean(unresolvedAttempt);
    await tx
      .update(lifecycleEmailJobs)
      .set({
        state: ambiguous ? "retry" : "pending",
        nextAttemptAt: new Date(
          now.getTime() +
            (ambiguous
              ? retryDelayMs(Math.max(job.attemptCount, 1))
              : RECOVERY_RECHECK_MS),
        ),
        leaseToken: null,
        leaseExpiresAt: null,
        ...(ambiguous ? { lastOutcome: "outcome_unknown" as const } : {}),
        lastErrorCode: ambiguous
          ? "worker_error_after_reservation"
          : "worker_error_before_reservation",
        lastErrorDetail: null,
        updatedAt: now,
      })
      .where(eq(lifecycleEmailJobs.id, job.id));
  });
}

async function claimNextJob(now: Date): Promise<ClaimedJob | null> {
  return withSystem(db, async (tx) => {
    const [candidate] = await tx
      .select({ id: lifecycleEmailJobs.id })
      .from(lifecycleEmailJobs)
      .where(
        or(
          and(
            inArray(lifecycleEmailJobs.state, [
              "pending",
              "retry",
              "blocked_recovery",
            ]),
            lte(lifecycleEmailJobs.nextAttemptAt, now),
          ),
          and(
            eq(lifecycleEmailJobs.state, "delivering"),
            lte(lifecycleEmailJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(lifecycleEmailJobs.createdAt, lifecycleEmailJobs.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(lifecycleEmailJobs)
      .set({
        state: "delivering",
        nextAttemptAt: null,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      })
      .where(eq(lifecycleEmailJobs.id, candidate.id))
      .returning({ id: lifecycleEmailJobs.id });
    return claimed ? { id: claimed.id, leaseToken } : null;
  });
}

export function isSupportedLifecycleEmailKind(
  kind: string,
): kind is SubscriptionLifecycleEmailKind {
  return (
    kind === "subscription_confirmed" || kind === "subscription_canceled"
  );
}

async function deferUnsupportedJob(
  claimed: ClaimedJob,
  now: Date,
): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx
      .update(lifecycleEmailJobs)
      .set({
        state: "pending",
        nextAttemptAt: new Date(now.getTime() + RECOVERY_RECHECK_MS),
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: "unsupported_job_kind",
        lastErrorDetail: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(lifecycleEmailJobs.id, claimed.id),
          eq(lifecycleEmailJobs.state, "delivering"),
          eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken),
        ),
      );
  });
}

async function processClaimedJob(
  claimed: ClaimedJob,
  now: Date,
): Promise<LifecycleEmailProcessResult> {
  const loaded = await loadClaimedJob(claimed);
  if (!loaded) return "suppressed";
  if (!isSupportedLifecycleEmailKind(loaded.kind)) {
    await deferUnsupportedJob(claimed, now);
    return "blocked";
  }

  const prepared = await prepareRequest(loaded);
  const fingerprint = requestFingerprint(prepared);
  const reservation = await reserveAttempt(
    claimed,
    fingerprint,
    recipientHash(loaded.practiceId, prepared.to),
    now,
  );
  if (reservation.action !== "send") {
    return reservation.action === "unknown"
      ? "outcomeUnknown"
      : reservation.action;
  }

  const dispatch = await dispatchWithEligibilityFence(
    claimed,
    loaded,
    prepared,
    fingerprint,
    recipientHash(loaded.practiceId, prepared.to),
    reservation.attemptId,
    now,
  );
  if (dispatch.action !== "evidence") return dispatch.action;
  return persistProviderOutcome(
    claimed,
    reservation.attemptId,
    reservation.attemptNumber,
    dispatch.evidence,
    now,
  );
}

/**
 * Hold the practice row lock across the bounded provider call. Every relevant
 * contact, recovery, deletion, and subscription mutation updates this row, so
 * PostgreSQL orders that mutation either before this final check or after the
 * send. The durable reservation and stable provider key make a crash after the
 * external side effect safely retryable.
 */
async function dispatchWithEligibilityFence(
  claimed: ClaimedJob,
  loaded: EligibleJob,
  prepared: EmailDispatchOptions,
  fingerprint: string,
  preparedRecipientHash: string,
  attemptId: string,
  now: Date,
): Promise<
  | { action: "evidence"; evidence: EmailProviderEvidence }
  | { action: "blocked" | "suppressed" | "outcomeUnknown" }
> {
  return withSystem(db, async (tx) => {
    const [job] = await tx
      .select({
        id: lifecycleEmailJobs.id,
        communicationId: lifecycleEmailJobs.communicationId,
        requestFingerprintSha256:
          lifecycleEmailJobs.requestFingerprintSha256,
        subscriptionGeneration: lifecycleEmailJobs.subscriptionGeneration,
      })
      .from(lifecycleEmailJobs)
      .where(
        and(
          eq(lifecycleEmailJobs.id, claimed.id),
          eq(lifecycleEmailJobs.state, "delivering"),
          eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken),
        ),
      )
      .limit(1)
      .for("update");
    if (!job) return { action: "outcomeUnknown" } as const;

    const [practice] = await tx
      .select({
        email: practices.email,
        deletedAt: practices.deletedAt,
        recoveryHold: practices.recoveryHold,
        billingStatus: practices.billingStatus,
        stripeSubscriptionId: practices.stripeSubscriptionId,
        subscriptionGeneration: practices.subscriptionGeneration,
      })
      .from(practices)
      .where(eq(practices.id, loaded.practiceId))
      .limit(1)
      .for("update");

    if (practice?.recoveryHold) {
      await resolveReservedWithoutDispatch(
        tx,
        attemptId,
        now,
        "recovery_hold_before_dispatch",
      );
      await tx
        .update(lifecycleEmailJobs)
        .set({
          state: "blocked_recovery",
          nextAttemptAt: new Date(now.getTime() + RECOVERY_RECHECK_MS),
          leaseToken: null,
          leaseExpiresAt: null,
          lastOutcome: "definite_failure",
          lastErrorCode: "recovery_hold_before_dispatch",
          lastErrorDetail: null,
          updatedAt: now,
        })
        .where(eq(lifecycleEmailJobs.id, job.id));
      return { action: "blocked" } as const;
    }

    const recipient = billingContactEmail(practice?.email);
    const recipientCurrent =
      recipient !== null &&
      recipientHash(loaded.practiceId, recipient) ===
        loaded.recipientHashSha256 &&
      preparedRecipientHash === loaded.recipientHashSha256;
    const identityCurrent =
      practice?.deletedAt === null &&
      practice.subscriptionGeneration === job.subscriptionGeneration &&
      (loaded.kind === "subscription_confirmed"
        ? practice.billingStatus === "active" &&
          practice.stripeSubscriptionId === loaded.subscriptionId
        : practice.billingStatus === "canceled" &&
          practice.stripeSubscriptionId === null);
    if (!recipientCurrent || !identityCurrent) {
      await resolveReservedWithoutDispatch(
        tx,
        attemptId,
        now,
        "stale_before_dispatch",
      );
      await suppressStale(tx, job.id, job.communicationId, now);
      return { action: "suppressed" } as const;
    }

    if (job.requestFingerprintSha256 !== fingerprint) {
      await resolveReservedWithoutDispatch(
        tx,
        attemptId,
        now,
        "request_fingerprint_changed_before_dispatch",
      );
      await completeUnknown(
        tx,
        job.id,
        job.communicationId,
        now,
        "request_fingerprint_changed_before_dispatch",
      );
      return { action: "outcomeUnknown" } as const;
    }

    const evidence = await dispatchPreparedEmailWithProviderEvidence(prepared);
    return { action: "evidence", evidence } as const;
  });
}

async function resolveReservedWithoutDispatch(
  tx: Database,
  attemptId: string,
  now: Date,
  code: string,
) {
  await tx
    .update(lifecycleEmailAttempts)
    .set({
      resolvedAt: now,
      outcome: "definite_failure",
      failureCode: code,
      failureDetail: null,
    })
    .where(
      and(
        eq(lifecycleEmailAttempts.id, attemptId),
        isNull(lifecycleEmailAttempts.resolvedAt),
      ),
    );
}

async function loadClaimedJob(claimed: ClaimedJob): Promise<EligibleJob | null> {
  return withSystem(db, async (tx) => {
    const [job] = await tx
      .select({
        id: lifecycleEmailJobs.id,
        practiceId: lifecycleEmailJobs.practiceId,
        kind: lifecycleEmailJobs.kind,
        providerIdempotencyKey: lifecycleEmailJobs.providerIdempotencyKey,
        recipientHashSha256: lifecycleEmailJobs.recipientHashSha256,
        practiceName: lifecycleEmailJobs.practiceName,
        subscriptionId: lifecycleEmailJobs.subscriptionId,
      })
      .from(lifecycleEmailJobs)
      .where(
        and(
          eq(lifecycleEmailJobs.id, claimed.id),
          eq(lifecycleEmailJobs.state, "delivering"),
          eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken),
        ),
      )
      .limit(1);
    return job ?? null;
  });
}

async function prepareRequest(job: EligibleJob): Promise<EmailDispatchOptions> {
  const practice = await withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ email: practices.email })
      .from(practices)
      .where(eq(practices.id, job.practiceId))
      .limit(1);
    return row ?? null;
  });
  const to = billingContactEmail(practice?.email);
  // The reservation transaction performs the authoritative revalidation. This
  // placeholder can never be sent because its hash will not match the job.
  const recipient = to ?? "invalid-recipient@invalid.openvpm.local";
  const input = {
    to: recipient,
    practiceName: job.practiceName,
    idempotencyKey: job.providerIdempotencyKey,
  };
  const request =
    job.kind === "subscription_confirmed"
      ? await prepareSubscriptionConfirmedEmail(input)
      : await prepareSubscriptionCanceledEmail(input);
  return {
    ...request,
    redactRecipientInLogs: true,
    tags: [
      { name: "openvpm_lifecycle_job", value: job.id },
      { name: "openvpm_email_kind", value: job.kind },
    ],
  };
}

async function reserveAttempt(
  claimed: ClaimedJob,
  fingerprint: string,
  preparedRecipientHash: string,
  now: Date,
): Promise<Reservation> {
  return withSystem(db, async (tx) => {
    const [job] = await tx
      .select()
      .from(lifecycleEmailJobs)
      .where(
        and(
          eq(lifecycleEmailJobs.id, claimed.id),
          eq(lifecycleEmailJobs.state, "delivering"),
          eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken),
        ),
      )
      .limit(1)
      .for("update");
    if (!job) return { action: "suppressed" };

    const [practice] = await tx
      .select({
        email: practices.email,
        deletedAt: practices.deletedAt,
        recoveryHold: practices.recoveryHold,
        billingStatus: practices.billingStatus,
        stripeSubscriptionId: practices.stripeSubscriptionId,
        subscriptionGeneration: practices.subscriptionGeneration,
      })
      .from(practices)
      .where(eq(practices.id, job.practiceId))
      .limit(1)
      .for("update");

    if (practice?.recoveryHold) {
      await tx
        .update(lifecycleEmailJobs)
        .set({
          state: "blocked_recovery",
          nextAttemptAt: new Date(now.getTime() + RECOVERY_RECHECK_MS),
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
          lastErrorCode: "recovery_hold",
          lastErrorDetail: null,
        })
        .where(eq(lifecycleEmailJobs.id, job.id));
      return { action: "blocked" };
    }

    const recipient = billingContactEmail(practice?.email);
    const recipientCurrent =
      recipient !== null &&
      recipientHash(job.practiceId, recipient) === job.recipientHashSha256 &&
      preparedRecipientHash === job.recipientHashSha256;
    const identityCurrent =
      practice?.deletedAt === null &&
      practice.subscriptionGeneration === job.subscriptionGeneration &&
      (job.kind === "subscription_confirmed"
        ? practice.billingStatus === "active" &&
          practice.stripeSubscriptionId === job.subscriptionId
        : practice.billingStatus === "canceled" &&
          practice.stripeSubscriptionId === null);
    if (!recipientCurrent || !identityCurrent) {
      await suppressStale(tx, job.id, job.communicationId, now);
      return { action: "suppressed" };
    }

    if (
      job.requestFingerprintSha256 &&
      job.requestFingerprintSha256 !== fingerprint
    ) {
      await completeUnknown(
        tx,
        job.id,
        job.communicationId,
        now,
        "request_fingerprint_changed",
      );
      return { action: "unknown" };
    }

    const provider = emailProviderForDispatch();
    if (job.attemptCount > 0 && job.firstAttemptAt) {
      const [ambiguousAttempt] = await tx
        .select({
          id: lifecycleEmailAttempts.id,
          provider: lifecycleEmailAttempts.provider,
        })
        .from(lifecycleEmailAttempts)
        .where(
          and(
            eq(lifecycleEmailAttempts.jobId, job.id),
            or(
              isNull(lifecycleEmailAttempts.resolvedAt),
              eq(lifecycleEmailAttempts.outcome, "outcome_unknown"),
            ),
          ),
        )
        .limit(1);
      if (ambiguousAttempt) {
        if (ambiguousAttempt.provider !== provider) {
          await completeUnknown(
            tx,
            job.id,
            job.communicationId,
            now,
            "provider_changed_after_unknown",
          );
          return { action: "unknown" };
        }
        if (
          now.getTime() - new Date(job.firstAttemptAt).getTime() >=
          UNKNOWN_RETRY_WINDOW_MS
        ) {
          await completeUnknown(
            tx,
            job.id,
            job.communicationId,
            now,
            "idempotency_window_expired",
          );
          return { action: "unknown" };
        }
      }
    }

    const attemptNumber = job.attemptCount + 1;
    const attemptId = randomUUID();
    await tx.insert(lifecycleEmailAttempts).values({
      id: attemptId,
      practiceId: job.practiceId,
      jobId: job.id,
      attemptNumber,
      provider,
      requestFingerprintSha256: fingerprint,
    });
    await tx
      .update(lifecycleEmailJobs)
      .set({
        attemptCount: attemptNumber,
        firstAttemptAt: job.firstAttemptAt ?? now,
        requestFingerprintSha256: job.requestFingerprintSha256 ?? fingerprint,
        updatedAt: now,
      })
      .where(eq(lifecycleEmailJobs.id, job.id));
    return { action: "send", attemptId, attemptNumber };
  });
}

async function persistProviderOutcome(
  claimed: ClaimedJob,
  attemptId: string,
  attemptNumber: number,
  evidence: EmailProviderEvidence,
  now: Date,
): Promise<LifecycleEmailProcessResult> {
  const result = await withSystem(db, async (tx) => {
    const [job] = await tx
      .select({
        id: lifecycleEmailJobs.id,
        communicationId: lifecycleEmailJobs.communicationId,
        practiceId: lifecycleEmailJobs.practiceId,
        state: lifecycleEmailJobs.state,
        leaseToken: lifecycleEmailJobs.leaseToken,
        firstAttemptAt: lifecycleEmailJobs.firstAttemptAt,
      })
      .from(lifecycleEmailJobs)
      .where(eq(lifecycleEmailJobs.id, claimed.id))
      .limit(1)
      .for("update");
    if (
      !job ||
      job.state !== "delivering" ||
      job.leaseToken !== claimed.leaseToken
    ) {
      return "outcomeUnknown" as const;
    }

    const normalizedOutcome =
      evidence.outcome === "accepted" && !evidence.id
        ? "outcome_unknown"
        : evidence.outcome;
    const errorCode =
      evidence.failureCode ??
      (normalizedOutcome === "outcome_unknown"
        ? "missing_provider_id"
        : "provider_failure");
    const resolvedAttempts = await tx
      .update(lifecycleEmailAttempts)
      .set({
        resolvedAt: now,
        outcome: normalizedOutcome,
        providerMessageId:
          normalizedOutcome === "accepted" ? (evidence.id ?? null) : null,
        failureCode: normalizedOutcome === "accepted" ? null : errorCode,
        failureDetail: null,
      })
      .where(
        and(
          eq(lifecycleEmailAttempts.id, attemptId),
          isNull(lifecycleEmailAttempts.resolvedAt),
        ),
      )
      .returning({ id: lifecycleEmailAttempts.id });
    if (resolvedAttempts.length !== 1) {
      throw new Error("Lifecycle email attempt resolution lost its CAS");
    }

    if (normalizedOutcome === "accepted") {
      const providerMessageId = evidence.id!;
      await tx
        .update(lifecycleEmailJobs)
        .set({
          state: "delivered",
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          providerMessageId,
          completedAt: now,
          lastOutcome: "accepted",
          lastErrorCode: null,
          lastErrorDetail: null,
          updatedAt: now,
        })
        .where(eq(lifecycleEmailJobs.id, job.id));
      await tx
        .update(communications)
        .set({ status: "sent", providerMessageId })
        .where(eq(communications.id, job.communicationId));
      return "delivered" as const;
    }

    const failureAction = lifecycleEmailFailureAction({
      outcome: normalizedOutcome,
      attemptNumber,
      firstAttemptAt: job.firstAttemptAt
        ? new Date(job.firstAttemptAt)
        : now,
      now,
    });
    if (failureAction !== "retry") {
      if (failureAction === "outcome_unknown") {
        await completeUnknown(
          tx,
          job.id,
          job.communicationId,
          now,
          errorCode,
        );
        return "outcomeUnknown" as const;
      }
      await tx
        .update(lifecycleEmailJobs)
        .set({
          state: "failed",
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastOutcome: "definite_failure",
          lastErrorCode: errorCode,
          lastErrorDetail: null,
          updatedAt: now,
        })
        .where(eq(lifecycleEmailJobs.id, job.id));
      await tx
        .update(communications)
        .set({ status: "failed" })
        .where(eq(communications.id, job.communicationId));
      return "failed" as const;
    }

    await tx
      .update(lifecycleEmailJobs)
      .set({
        state: "retry",
        nextAttemptAt: new Date(
          now.getTime() + retryDelayMs(attemptNumber),
        ),
        leaseToken: null,
        leaseExpiresAt: null,
        lastOutcome: normalizedOutcome,
        lastErrorCode: errorCode,
        lastErrorDetail: null,
        updatedAt: now,
      })
      .where(eq(lifecycleEmailJobs.id, job.id));
    return "retried" as const;
  });

  if (result === "failed" || result === "outcomeUnknown") {
    try {
      await alertOps(
        result === "failed"
          ? "Lifecycle email delivery exhausted"
          : "Lifecycle email outcome unresolved",
        `job=${claimed.id} outcome=${result}`,
      );
    } catch {
      // Durable terminal state and the cron heartbeat remain authoritative.
    }
  }
  return result;
}

async function suppressStale(
  tx: Database,
  jobId: string,
  communicationId: string,
  now: Date,
) {
  await tx
    .update(lifecycleEmailJobs)
    .set({
      state: "suppressed_stale",
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: now,
      lastErrorCode: "stale_contact_or_subscription",
      lastErrorDetail: null,
      updatedAt: now,
    })
    .where(eq(lifecycleEmailJobs.id, jobId));
  await tx
    .update(communications)
    .set({ status: "failed" })
    .where(eq(communications.id, communicationId));
}

async function completeUnknown(
  tx: Database,
  jobId: string,
  communicationId: string,
  now: Date,
  code: string,
) {
  await tx
    .update(lifecycleEmailJobs)
    .set({
      state: "outcome_unknown",
      nextAttemptAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: now,
      lastOutcome: "outcome_unknown",
      lastErrorCode: code,
      lastErrorDetail: null,
      updatedAt: now,
    })
    .where(eq(lifecycleEmailJobs.id, jobId));
  // The generic communication ledger has no "unknown" status. Mark the
  // terminal, unconfirmed outcome as failed so it cannot masquerade as queued;
  // lifecycle_email_jobs remains the authoritative manual-review record.
  await tx
    .update(communications)
    .set({ status: "failed" })
    .where(eq(communications.id, communicationId));
}

export function recipientHash(practiceId: string, recipient: string): string {
  const hash = emailPreferenceRecipientHash(
    `openvpm-lifecycle-recipient:v1:${practiceId}:${recipient.trim().toLowerCase()}`,
  );
  if (!hash) {
    throw new Error("Lifecycle email recipient identity key is not configured");
  }
  return hash;
}

export function requestFingerprint(request: EmailDispatchOptions): string {
  const canonical = JSON.stringify({
    from: request.from ?? "",
    headers: request.headers ?? {},
    html: request.html,
    idempotencyKey: request.idempotencyKey ?? "",
    replyTo: request.replyTo ?? "",
    subject: request.subject,
    tags: request.tags ?? [],
    to: request.to.trim().toLowerCase(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function retryDelayMs(attemptNumber: number): number {
  return RETRY_DELAYS_MS[
    Math.min(Math.max(attemptNumber - 1, 0), RETRY_DELAYS_MS.length - 1)
  ]!;
}

export function lifecycleEmailFailureAction(input: {
  outcome: "definite_failure" | "outcome_unknown";
  attemptNumber: number;
  firstAttemptAt: Date;
  now: Date;
}): "retry" | "failed" | "outcome_unknown" {
  if (input.outcome === "definite_failure") {
    return input.attemptNumber >= MAX_DEFINITE_ATTEMPTS ? "failed" : "retry";
  }
  const windowExpired =
    input.now.getTime() - input.firstAttemptAt.getTime() >=
    UNKNOWN_RETRY_WINDOW_MS;
  return input.attemptNumber >= MAX_UNKNOWN_ATTEMPTS || windowExpired
    ? "outcome_unknown"
    : "retry";
}
