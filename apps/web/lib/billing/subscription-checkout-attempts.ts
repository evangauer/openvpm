import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { practices, subscriptionCheckoutAttempts, users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { BillingCadence } from "@/lib/billing/catalog";
import { TRIAL_DAYS } from "@/lib/billing/plans";
import {
  createSubscriptionCheckoutSession,
  retrieveDurableSubscriptionCheckoutSession,
  type DurableSubscriptionCheckoutSession,
} from "@/lib/stripe";
import { withSystem } from "@/lib/tenant-db";

const HOUR_MS = 60 * 60 * 1000;
const STRIPE_TRIAL_END_MIN_LEAD_MS = 48 * HOUR_MS;
const STRIPE_TRIAL_END_PROCESSING_BUFFER_MS = 5 * 60 * 1000;
const NEAR_EXPIRY_TRIAL_PERIOD_DAYS = 3;
const PROVIDER_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_IDEMPOTENCY_RETRY_MS = 24 * HOUR_MS;
const PROVIDER_IDENTITY_CONFLICT_HOLD_REASON =
  "Subscription Checkout provider identity conflict requires billing reconciliation.";

const ACTIVE_STATES = [
  "reserved",
  "creating",
  "outcome_unknown",
  "manual_review",
  "open",
] as const;

type AttemptRow = typeof subscriptionCheckoutAttempts.$inferSelect;

export type SubscriptionCheckoutRequest = {
  practiceId: string;
  source: "signup" | "settings";
  billingCadence: BillingCadence;
  returnTarget: "login" | "settings" | "setup";
  locationPriceId: string;
  locationQuantity: number;
  customerId?: string | null;
  customerEmail?: string | null;
  customerIdentitySource: "stripe_customer" | "practice_email" | "user_email";
  customerIdentityUserId?: string | null;
  trialEnd?: Date | string | null;
  trialPeriodDays?: number;
  successUrl: string;
  cancelUrl: string;
};

export type SubscriptionCheckoutReservation = {
  attemptId: string;
};

export type SubscriptionCheckoutDispatchResult = {
  url: string | null;
  status: "open" | "completed" | "expired" | "pending" | "failed";
  attemptId: string;
  reused: boolean;
};

export type SubscriptionCheckoutTrialTerms = {
  trialEnd: Date | string | null;
  trialPeriodDays: number | undefined;
};

export function subscriptionCheckoutAttemptRetryRegime(input: {
  firstProviderAttemptAt: Date;
  now: Date;
}): "retry_same_identity" | "manual_review" {
  return input.now.getTime() - input.firstProviderAttemptAt.getTime() <
    PROVIDER_IDEMPOTENCY_RETRY_MS
    ? "retry_same_identity"
    : "manual_review";
}

export function subscriptionCheckoutProviderIdentityConflict(input: {
  practice: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  } | null;
  customerId: string | null;
  subscriptionId: string | null;
}): boolean {
  const { practice, customerId, subscriptionId } = input;
  return (
    !practice ||
    !customerId ||
    !subscriptionId ||
    (practice.stripeCustomerId !== null &&
      practice.stripeCustomerId !== customerId) ||
    (practice.stripeSubscriptionId !== null &&
      practice.stripeSubscriptionId !== subscriptionId)
  );
}

export function subscriptionCheckoutTrialTerms(input: {
  billingStatus: string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
  now: Date;
}): SubscriptionCheckoutTrialTerms {
  const { billingStatus, trialEndsAt, now } = input;
  if (billingStatus === "trialing" && trialEndsAt) {
    const remainingMs = new Date(trialEndsAt).getTime() - now.getTime();
    if (
      Number.isFinite(remainingMs) &&
      remainingMs >=
        STRIPE_TRIAL_END_MIN_LEAD_MS + STRIPE_TRIAL_END_PROCESSING_BUFFER_MS
    ) {
      return { trialEnd: trialEndsAt, trialPeriodDays: undefined };
    }
    if (Number.isFinite(remainingMs) && remainingMs > 0) {
      return {
        trialEnd: null,
        trialPeriodDays: NEAR_EXPIRY_TRIAL_PERIOD_DAYS,
      };
    }
  }
  if (trialEndsAt) return { trialEnd: null, trialPeriodDays: undefined };
  return { trialEnd: null, trialPeriodDays: TRIAL_DAYS };
}

function canonicalRequest(input: SubscriptionCheckoutRequest) {
  const customerId = input.customerId?.trim() || null;
  const customerEmail = input.customerEmail?.trim().toLowerCase() || null;
  const customerIdentityUserId = input.customerIdentityUserId?.trim() || null;
  if (
    (input.customerIdentitySource === "stripe_customer" &&
      (!customerId || customerEmail || customerIdentityUserId)) ||
    (input.customerIdentitySource === "practice_email" &&
      (customerId || !customerEmail || customerIdentityUserId)) ||
    (input.customerIdentitySource === "user_email" &&
      (customerId || !customerEmail || !customerIdentityUserId))
  ) {
    throw new Error(
      "Subscription Checkout customer identity snapshot is invalid.",
    );
  }
  const trialEnd = input.trialEnd ? new Date(input.trialEnd) : null;
  if (trialEnd && Number.isNaN(trialEnd.getTime())) {
    throw new Error("Subscription Checkout trial end is invalid.");
  }
  if (trialEnd && input.trialPeriodDays !== undefined) {
    throw new Error("Subscription Checkout trial terms must be exclusive.");
  }
  if (
    input.trialPeriodDays !== undefined &&
    (!Number.isInteger(input.trialPeriodDays) || input.trialPeriodDays < 1)
  ) {
    throw new Error("Subscription Checkout trial days are invalid.");
  }
  if (!Number.isInteger(input.locationQuantity) || input.locationQuantity < 1) {
    throw new Error("Subscription Checkout location quantity is invalid.");
  }
  return {
    ...input,
    locationPriceId: input.locationPriceId.trim(),
    customerId,
    customerEmail,
    customerIdentityUserId,
    trialEnd,
    trialPeriodDays: input.trialPeriodDays ?? null,
  };
}

function requestFingerprint(
  attemptId: string,
  input: ReturnType<typeof canonicalRequest>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attemptId,
        practiceId: input.practiceId,
        source: input.source,
        billingCadence: input.billingCadence,
        returnTarget: input.returnTarget,
        locationPriceId: input.locationPriceId,
        locationQuantity: input.locationQuantity,
        customerId: input.customerId,
        customerEmail: input.customerEmail,
        customerIdentitySource: input.customerIdentitySource,
        customerIdentityUserId: input.customerIdentityUserId,
        trialEnd: input.trialEnd?.toISOString() ?? null,
        trialPeriodDays: input.trialPeriodDays,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      }),
    )
    .digest("hex");
}

/** Must run inside the caller's tenant/system transaction. */
export async function reserveSubscriptionCheckoutAttempt(
  tx: Database,
  request: SubscriptionCheckoutRequest,
  now = new Date(),
): Promise<SubscriptionCheckoutReservation> {
  const input = canonicalRequest(request);
  const [practice] = await tx
    .select({
      id: practices.id,
      stripeSubscriptionId: practices.stripeSubscriptionId,
      recoveryHold: practices.recoveryHold,
    })
    .from(practices)
    .where(and(eq(practices.id, input.practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("update", { of: practices });
  if (!practice) throw new Error("Subscription Checkout practice is inactive.");
  if (practice.recoveryHold) {
    throw new Error("Subscription Checkout is blocked during recovery review.");
  }
  if (practice.stripeSubscriptionId) {
    throw new Error(
      "Subscription Checkout is blocked by an existing subscription.",
    );
  }

  const [existing] = await tx
    .select()
    .from(subscriptionCheckoutAttempts)
    .where(
      and(
        eq(subscriptionCheckoutAttempts.practiceId, input.practiceId),
        inArray(subscriptionCheckoutAttempts.state, [...ACTIVE_STATES]),
      ),
    )
    .orderBy(subscriptionCheckoutAttempts.createdAt)
    .limit(1)
    .for("update", { of: subscriptionCheckoutAttempts });

  if (existing) {
    // An identity-only provider timeout cannot be proven safe merely by
    // waiting: after Stripe may prune the idempotency key, another POST could
    // create a second Session. Keep ownership fail-closed until the same
    // identity is retried inside its safe window or operators reconcile it.
    return { attemptId: existing.id };
  }

  const attemptId = randomUUID();
  const providerIdempotencyKey = `openvpm:subscription-checkout-attempt:${attemptId}`;
  await tx.insert(subscriptionCheckoutAttempts).values({
    id: attemptId,
    practiceId: input.practiceId,
    source: input.source,
    billingCadence: input.billingCadence,
    returnTarget: input.returnTarget,
    locationPriceId: input.locationPriceId,
    locationQuantity: input.locationQuantity,
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    customerIdentitySource: input.customerIdentitySource,
    customerIdentityUserId: input.customerIdentityUserId,
    trialEnd: input.trialEnd,
    trialPeriodDays: input.trialPeriodDays,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    providerIdempotencyKey,
    requestFingerprintSha256: requestFingerprint(attemptId, input),
  });
  return { attemptId };
}

type DispatchClaim =
  | { kind: "create"; attempt: AttemptRow; leaseToken: string }
  | { kind: "reconcile"; attempt: AttemptRow }
  | { kind: "pending"; attempt: AttemptRow }
  | { kind: "terminal"; attempt: AttemptRow };

type ClaimPractice = {
  id: string;
  deletedAt: Date | null;
  recoveryHold: boolean;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  email: string | null;
};

function normalizedBillingEmail(
  value: string | null | undefined,
): string | null {
  return value?.trim().toLowerCase() || null;
}

async function stalePracticeReason(
  tx: Database,
  practice: ClaimPractice | undefined,
  attempt: AttemptRow,
): Promise<string | null> {
  if (!practice || practice.deletedAt) return "practice_inactive";
  if (practice.recoveryHold) return "practice_recovery_hold";
  if (practice.stripeSubscriptionId) return "subscription_already_present";
  if (attempt.customerIdentitySource === "stripe_customer") {
    return practice.stripeCustomerId === attempt.customerId
      ? null
      : "stripe_customer_changed";
  }
  if (practice.stripeCustomerId) return "stripe_customer_changed";
  if (attempt.customerIdentitySource === "practice_email") {
    return normalizedBillingEmail(practice.email) === attempt.customerEmail
      ? null
      : "billing_email_changed";
  }
  if (normalizedBillingEmail(practice.email)) return "billing_email_changed";
  const [identityUser] = await tx
    .select({
      email: users.email,
      practiceId: users.practiceId,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, attempt.customerIdentityUserId!))
    .limit(1)
    .for("share", { of: users });
  return identityUser &&
    !identityUser.deletedAt &&
    identityUser.practiceId === attempt.practiceId &&
    normalizedBillingEmail(identityUser.email) === attempt.customerEmail
    ? null
    : "billing_email_changed";
}

async function persistStaleClaim(
  tx: Database,
  attempt: AttemptRow,
  reason: string,
  now: Date,
): Promise<DispatchClaim> {
  const uncertain = attempt.firstProviderAttemptAt !== null;
  const [blocked] = await tx
    .update(subscriptionCheckoutAttempts)
    .set(
      uncertain
        ? {
            state: "manual_review",
            updatedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: reason,
          }
        : {
            state: "failed",
            updatedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            failedAt: now,
            lastErrorCode: reason,
          },
    )
    .where(
      and(
        eq(subscriptionCheckoutAttempts.id, attempt.id),
        inArray(subscriptionCheckoutAttempts.state, [
          "reserved",
          "creating",
          "outcome_unknown",
        ]),
      ),
    )
    .returning();
  if (!blocked) {
    throw new Error("Subscription Checkout stale-practice CAS was lost.");
  }
  return uncertain
    ? { kind: "pending", attempt: blocked }
    : { kind: "terminal", attempt: blocked };
}

async function claimDispatch(
  rootDb: Database,
  attemptId: string,
  now: Date,
): Promise<DispatchClaim> {
  return withSystem(rootDb, async (tx) => {
    const [identity] = await tx
      .select({ practiceId: subscriptionCheckoutAttempts.practiceId })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, attemptId))
      .limit(1);
    if (!identity) throw new Error("Subscription Checkout attempt is missing.");
    const [practice] = await tx
      .select({
        id: practices.id,
        deletedAt: practices.deletedAt,
        recoveryHold: practices.recoveryHold,
        stripeSubscriptionId: practices.stripeSubscriptionId,
        stripeCustomerId: practices.stripeCustomerId,
        email: practices.email,
      })
      .from(practices)
      .where(eq(practices.id, identity.practiceId))
      .limit(1)
      .for("update", { of: practices });
    const [attempt] = await tx
      .select()
      .from(subscriptionCheckoutAttempts)
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attemptId),
          eq(subscriptionCheckoutAttempts.practiceId, identity.practiceId),
        ),
      )
      .limit(1)
      .for("update", { of: subscriptionCheckoutAttempts });
    if (!attempt) throw new Error("Subscription Checkout attempt is missing.");
    if (attempt.state === "open") return { kind: "reconcile", attempt };
    if (
      attempt.state === "completed" ||
      attempt.state === "expired" ||
      attempt.state === "failed"
    ) {
      return { kind: "terminal", attempt };
    }
    if (attempt.state === "manual_review") {
      return { kind: "pending", attempt };
    }
    if (
      attempt.state === "creating" &&
      attempt.leaseExpiresAt &&
      attempt.leaseExpiresAt.getTime() > now.getTime()
    ) {
      return { kind: "pending", attempt };
    }
    const staleReason = await stalePracticeReason(tx, practice, attempt);
    if (staleReason) {
      return persistStaleClaim(tx, attempt, staleReason, now);
    }
    if (
      (attempt.state === "creating" || attempt.state === "outcome_unknown") &&
      attempt.firstProviderAttemptAt &&
      subscriptionCheckoutAttemptRetryRegime({
        firstProviderAttemptAt: attempt.firstProviderAttemptAt,
        now,
      }) === "manual_review"
    ) {
      // A timeout can happen after Stripe accepted the POST but before the
      // Session identity was persisted. Once key retention is no longer
      // guaranteed there is no authoritative GET target, so make the blocked
      // ownership explicit for operators and never POST again.
      const [blocked] = await tx
        .update(subscriptionCheckoutAttempts)
        .set({
          state: "manual_review",
          updatedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: "idempotency_window_elapsed",
        })
        .where(eq(subscriptionCheckoutAttempts.id, attempt.id))
        .returning();
      if (!blocked) {
        throw new Error(
          "Subscription Checkout manual-review transition CAS was lost.",
        );
      }
      return { kind: "pending", attempt: blocked };
    }
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(subscriptionCheckoutAttempts)
      .set({
        state: "creating",
        updatedAt: now,
        attemptCount: attempt.attemptCount + 1,
        firstProviderAttemptAt: attempt.firstProviderAttemptAt ?? now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS),
        lastAttemptAt: now,
        lastErrorCode: null,
      })
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attempt.id),
          inArray(subscriptionCheckoutAttempts.state, [
            "reserved",
            "creating",
            "outcome_unknown",
          ]),
        ),
      )
      .returning();
    if (!claimed) throw new Error("Subscription Checkout claim was lost.");
    return { kind: "create", attempt: claimed, leaseToken };
  });
}

function providerInput(attempt: AttemptRow) {
  return {
    lineItems: [
      {
        priceId: attempt.locationPriceId,
        quantity: attempt.locationQuantity,
      },
    ],
    practiceId: attempt.practiceId,
    customerId: attempt.customerId,
    customerEmail: attempt.customerEmail,
    successUrl: attempt.successUrl,
    cancelUrl: attempt.cancelUrl,
    trialEnd: attempt.trialEnd,
    trialPeriodDays: attempt.trialPeriodDays ?? undefined,
    billingCadence: attempt.billingCadence as BillingCadence,
    source: attempt.source as "signup" | "settings",
    checkoutAttemptId: attempt.id,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
  };
}

async function persistProviderState(
  rootDb: Database,
  attempt: AttemptRow,
  session: DurableSubscriptionCheckoutSession,
  now: Date,
  leaseToken?: string,
): Promise<"open" | "completed" | "expired" | "manual_review"> {
  if (
    session.practiceId !== attempt.practiceId ||
    session.checkoutAttemptId !== attempt.id ||
    (attempt.providerSessionId !== null &&
      session.sessionId !== attempt.providerSessionId)
  ) {
    throw new Error("Subscription Checkout provider identity mismatch.");
  }
  return withSystem(rootDb, async (tx) => {
    const [practice] = await tx
      .select({
        stripeCustomerId: practices.stripeCustomerId,
        stripeSubscriptionId: practices.stripeSubscriptionId,
      })
      .from(practices)
      .where(
        and(eq(practices.id, attempt.practiceId), isNull(practices.deletedAt)),
      )
      .limit(1)
      .for("update", { of: practices });
    const providerIdentityConflict =
      session.status === "complete" &&
      subscriptionCheckoutProviderIdentityConflict({
        practice: practice ?? null,
        customerId: session.customerId,
        subscriptionId: session.subscriptionId,
      });
    const state: "open" | "completed" | "expired" | "manual_review" =
      providerIdentityConflict
        ? "manual_review"
        : session.status === "open"
          ? "open"
          : session.status === "complete"
            ? "completed"
            : "expired";
    const [updated] = await tx
      .update(subscriptionCheckoutAttempts)
      .set({
        state,
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        providerSessionId: session.sessionId,
        providerExpiresAt: session.expiresAt,
        lastReconciledAt: now,
        completedAt: state === "completed" ? now : null,
        expiredAt: state === "expired" ? now : null,
        lastErrorCode: providerIdentityConflict
          ? "provider_identity_conflict"
          : null,
      })
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attempt.id),
          leaseToken
            ? eq(subscriptionCheckoutAttempts.leaseToken, leaseToken)
            : or(
                eq(subscriptionCheckoutAttempts.state, "open"),
                eq(subscriptionCheckoutAttempts.state, "creating"),
                eq(subscriptionCheckoutAttempts.state, "outcome_unknown"),
              ),
        ),
      )
      .returning({ id: subscriptionCheckoutAttempts.id });
    if (!updated) {
      const [current] = await tx
        .select({
          providerSessionId: subscriptionCheckoutAttempts.providerSessionId,
          state: subscriptionCheckoutAttempts.state,
        })
        .from(subscriptionCheckoutAttempts)
        .where(eq(subscriptionCheckoutAttempts.id, attempt.id))
        .limit(1);
      if (
        current?.providerSessionId !== session.sessionId ||
        current.state !== state
      ) {
        throw new Error("Subscription Checkout persistence CAS was lost.");
      }
    }
    if (providerIdentityConflict) {
      if (practice) {
        await tx
          .update(practices)
          .set({
            recoveryHold: true,
            recoveryHoldSetAt: now,
            recoveryHoldReason: PROVIDER_IDENTITY_CONFLICT_HOLD_REASON,
          })
          .where(eq(practices.id, attempt.practiceId));
      }
    } else if (state === "completed") {
      const [appliedPractice] = await tx
        .update(practices)
        .set({
          ...(session.customerId
            ? { stripeCustomerId: session.customerId }
            : {}),
          ...(session.subscriptionId
            ? { stripeSubscriptionId: session.subscriptionId }
            : {}),
        })
        .where(
          and(
            eq(practices.id, attempt.practiceId),
            isNull(practices.deletedAt),
            session.customerId
              ? or(
                  isNull(practices.stripeCustomerId),
                  eq(practices.stripeCustomerId, session.customerId),
                )
              : undefined,
            session.subscriptionId
              ? or(
                  isNull(practices.stripeSubscriptionId),
                  eq(practices.stripeSubscriptionId, session.subscriptionId),
                )
              : undefined,
          ),
        )
        .returning({ id: practices.id });
      if (!appliedPractice) {
        throw new Error(
          "Subscription Checkout completed identity persistence was refused.",
        );
      }
    }
    return state;
  });
}

async function persistUnknown(
  rootDb: Database,
  attemptId: string,
  leaseToken: string,
  now: Date,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCheckoutAttempts)
      .set({
        state: "outcome_unknown",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: "provider_outcome_unknown",
      })
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attemptId),
          eq(subscriptionCheckoutAttempts.state, "creating"),
          eq(subscriptionCheckoutAttempts.leaseToken, leaseToken),
        ),
      )
      .returning({ id: subscriptionCheckoutAttempts.id });
    if (updated) return;
    const [current] = await tx
      .select({
        state: subscriptionCheckoutAttempts.state,
        leaseToken: subscriptionCheckoutAttempts.leaseToken,
        lastErrorCode: subscriptionCheckoutAttempts.lastErrorCode,
      })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, attemptId))
      .limit(1);
    if (
      current?.state !== "outcome_unknown" ||
      current.leaseToken !== null ||
      current.lastErrorCode !== "provider_outcome_unknown"
    ) {
      throw new Error(
        "Subscription Checkout unknown-outcome lease CAS was lost.",
      );
    }
  });
}

async function persistUnconfigured(
  rootDb: Database,
  attemptId: string,
  leaseToken: string,
  now: Date,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCheckoutAttempts)
      .set({
        state: "failed",
        updatedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        failedAt: now,
        lastErrorCode: "provider_unconfigured",
      })
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attemptId),
          eq(subscriptionCheckoutAttempts.state, "creating"),
          eq(subscriptionCheckoutAttempts.leaseToken, leaseToken),
        ),
      )
      .returning({ id: subscriptionCheckoutAttempts.id });
    if (updated) return;
    const [current] = await tx
      .select({
        state: subscriptionCheckoutAttempts.state,
        leaseToken: subscriptionCheckoutAttempts.leaseToken,
        lastErrorCode: subscriptionCheckoutAttempts.lastErrorCode,
      })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, attemptId))
      .limit(1);
    if (
      current?.state !== "failed" ||
      current.leaseToken !== null ||
      current.lastErrorCode !== "provider_unconfigured"
    ) {
      throw new Error("Subscription Checkout unconfigured lease CAS was lost.");
    }
  });
}

async function persistReconciliationError(
  rootDb: Database,
  attemptId: string,
  providerSessionId: string,
  now: Date,
  code:
    | "provider_reconciliation_failed"
    | "provider_reconciliation_unavailable",
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCheckoutAttempts)
      .set({ updatedAt: now, lastReconciledAt: now, lastErrorCode: code })
      .where(
        and(
          eq(subscriptionCheckoutAttempts.id, attemptId),
          eq(subscriptionCheckoutAttempts.state, "open"),
          eq(subscriptionCheckoutAttempts.providerSessionId, providerSessionId),
        ),
      )
      .returning({ id: subscriptionCheckoutAttempts.id });
    if (updated) return;
    const [current] = await tx
      .select({
        state: subscriptionCheckoutAttempts.state,
        providerSessionId: subscriptionCheckoutAttempts.providerSessionId,
        lastErrorCode: subscriptionCheckoutAttempts.lastErrorCode,
      })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, attemptId))
      .limit(1);
    if (
      current?.state !== "open" ||
      current.providerSessionId !== providerSessionId ||
      current.lastErrorCode !== code
    ) {
      throw new Error(
        "Subscription Checkout reconciliation-error CAS was lost.",
      );
    }
  });
}

/** Provider calls occur only between the short claim and persistence txs. */
export async function dispatchSubscriptionCheckoutAttempt(
  rootDb: Database,
  reservation: SubscriptionCheckoutReservation,
  now = new Date(),
): Promise<SubscriptionCheckoutDispatchResult> {
  const claim = await claimDispatch(rootDb, reservation.attemptId, now);
  if (claim.kind === "pending") {
    return {
      url: null,
      status: "pending",
      attemptId: claim.attempt.id,
      reused: true,
    };
  }
  if (claim.kind === "terminal") {
    return {
      url: null,
      status:
        claim.attempt.state === "completed"
          ? "completed"
          : claim.attempt.state === "expired"
            ? "expired"
            : "failed",
      attemptId: claim.attempt.id,
      reused: true,
    };
  }

  if (claim.kind === "reconcile") {
    let session: DurableSubscriptionCheckoutSession | null;
    try {
      session = await retrieveDurableSubscriptionCheckoutSession(
        claim.attempt.providerSessionId!,
      );
    } catch {
      await persistReconciliationError(
        rootDb,
        claim.attempt.id,
        claim.attempt.providerSessionId!,
        now,
        "provider_reconciliation_failed",
      );
      return {
        url: null,
        status: "pending",
        attemptId: claim.attempt.id,
        reused: true,
      };
    }
    if (!session) {
      await persistReconciliationError(
        rootDb,
        claim.attempt.id,
        claim.attempt.providerSessionId!,
        now,
        "provider_reconciliation_unavailable",
      );
      return {
        url: null,
        status: "pending",
        attemptId: claim.attempt.id,
        reused: true,
      };
    }
    let persistedState: "open" | "completed" | "expired" | "manual_review";
    try {
      persistedState = await persistProviderState(
        rootDb,
        claim.attempt,
        session,
        now,
      );
    } catch {
      await persistReconciliationError(
        rootDb,
        claim.attempt.id,
        claim.attempt.providerSessionId!,
        now,
        "provider_reconciliation_failed",
      );
      return {
        url: null,
        status: "pending",
        attemptId: claim.attempt.id,
        reused: true,
      };
    }
    return {
      url: persistedState === "open" ? session.url : null,
      status:
        persistedState === "manual_review"
          ? "pending"
          : persistedState === "open"
            ? "open"
            : persistedState === "completed"
              ? "completed"
              : "expired",
      attemptId: claim.attempt.id,
      reused: true,
    };
  }

  try {
    const result = await createSubscriptionCheckoutSession(
      providerInput(claim.attempt),
    );
    if (!result || !("sessionId" in result)) {
      await persistUnconfigured(
        rootDb,
        claim.attempt.id,
        claim.leaseToken,
        now,
      );
      return {
        url: null,
        status: "failed",
        attemptId: claim.attempt.id,
        reused: claim.attempt.attemptCount > 1,
      };
    }
    const persistedState = await persistProviderState(
      rootDb,
      claim.attempt,
      result,
      now,
      claim.leaseToken,
    );
    return {
      url: persistedState === "open" ? result.url : null,
      status:
        persistedState === "manual_review"
          ? "pending"
          : persistedState === "open"
            ? "open"
            : persistedState === "completed"
              ? "completed"
              : "expired",
      attemptId: claim.attempt.id,
      reused: claim.attempt.attemptCount > 1,
    };
  } catch {
    await persistUnknown(rootDb, claim.attempt.id, claim.leaseToken, now);
    return {
      url: null,
      status: "pending",
      attemptId: claim.attempt.id,
      reused: claim.attempt.attemptCount > 1,
    };
  }
}

export type SubscriptionCheckoutWebhookReconciliation =
  | { outcome: "reconciled" | "exact_replay" }
  | {
      outcome: "conflict" | "mismatch";
      reason:
        | "invalid_identity"
        | "completed_identity_missing"
        | "practice_missing"
        | "attempt_practice_mismatch"
        | "provider_session_mismatch"
        | "provider_identity_conflict"
        | "terminal_state_conflict"
        | "transition_cas_lost";
    };

export async function reconcileSubscriptionCheckoutWebhook(
  tx: Database,
  input: {
    attemptId: string | null | undefined;
    practiceId: string | null | undefined;
    providerSessionId: string;
    providerExpiresAt: Date;
    status: "completed" | "expired";
    customerId?: string | null;
    subscriptionId?: string | null;
    occurredAt: Date;
  },
): Promise<SubscriptionCheckoutWebhookReconciliation> {
  const attemptId = input.attemptId?.trim();
  const practiceId = input.practiceId?.trim();
  if (!attemptId || !practiceId || !input.providerSessionId) {
    return { outcome: "mismatch", reason: "invalid_identity" };
  }
  if (
    input.status === "completed" &&
    (!input.customerId || !input.subscriptionId)
  ) {
    return { outcome: "conflict", reason: "completed_identity_missing" };
  }
  const [practice] = await tx
    .select({
      id: practices.id,
      stripeCustomerId: practices.stripeCustomerId,
      stripeSubscriptionId: practices.stripeSubscriptionId,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("update", { of: practices });
  if (!practice) return { outcome: "mismatch", reason: "practice_missing" };
  const [attempt] = await tx
    .select({
      state: subscriptionCheckoutAttempts.state,
      providerSessionId: subscriptionCheckoutAttempts.providerSessionId,
    })
    .from(subscriptionCheckoutAttempts)
    .where(
      and(
        eq(subscriptionCheckoutAttempts.id, attemptId),
        eq(subscriptionCheckoutAttempts.practiceId, practiceId),
      ),
    )
    .limit(1)
    .for("update", { of: subscriptionCheckoutAttempts });
  if (!attempt) {
    return { outcome: "mismatch", reason: "attempt_practice_mismatch" };
  }
  if (
    attempt.providerSessionId !== null &&
    attempt.providerSessionId !== input.providerSessionId
  ) {
    return { outcome: "mismatch", reason: "provider_session_mismatch" };
  }
  if (input.status === "completed") {
    if (
      subscriptionCheckoutProviderIdentityConflict({
        practice,
        customerId: input.customerId ?? null,
        subscriptionId: input.subscriptionId ?? null,
      })
    ) {
      return { outcome: "conflict", reason: "provider_identity_conflict" };
    }
  }
  if (attempt.state === input.status) {
    return attempt.providerSessionId === input.providerSessionId
      ? { outcome: "exact_replay" }
      : { outcome: "mismatch", reason: "provider_session_mismatch" };
  }
  if (
    attempt.state === "completed" ||
    attempt.state === "expired" ||
    attempt.state === "failed"
  ) {
    return { outcome: "conflict", reason: "terminal_state_conflict" };
  }
  const [updated] = await tx
    .update(subscriptionCheckoutAttempts)
    .set({
      state: input.status,
      updatedAt: input.occurredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      providerSessionId: input.providerSessionId,
      providerExpiresAt: input.providerExpiresAt,
      lastReconciledAt: input.occurredAt,
      completedAt: input.status === "completed" ? input.occurredAt : null,
      expiredAt: input.status === "expired" ? input.occurredAt : null,
      lastErrorCode: null,
    })
    .where(
      and(
        eq(subscriptionCheckoutAttempts.id, attemptId),
        eq(subscriptionCheckoutAttempts.practiceId, practiceId),
        eq(subscriptionCheckoutAttempts.state, attempt.state),
        or(
          isNull(subscriptionCheckoutAttempts.providerSessionId),
          eq(
            subscriptionCheckoutAttempts.providerSessionId,
            input.providerSessionId,
          ),
        ),
      ),
    )
    .returning({ id: subscriptionCheckoutAttempts.id });
  return updated
    ? { outcome: "reconciled" }
    : { outcome: "mismatch", reason: "transition_cas_lost" };
}
