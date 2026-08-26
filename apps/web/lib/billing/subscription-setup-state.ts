const PROVIDER_IDEMPOTENCY_RETRY_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIPTION_SETUP_POLL_INTERVAL_MS = 2_000;
export const SUBSCRIPTION_SETUP_POLL_WINDOW_MS = 30_000;

export function subscriptionCheckoutAttemptRetryRegime(input: {
  firstProviderAttemptAt: Date;
  now: Date;
}): "retry_same_identity" | "manual_review" {
  return input.now.getTime() - input.firstProviderAttemptAt.getTime() <
    PROVIDER_IDEMPOTENCY_RETRY_MS
    ? "retry_same_identity"
    : "manual_review";
}

export const SUBSCRIPTION_SETUP_STATES = [
  "not_applicable",
  "not_started",
  "confirming",
  "retryable",
  "manual_review",
  "blocked_recovery",
  "contradiction",
  "connected",
] as const;

export type SubscriptionSetupState = (typeof SUBSCRIPTION_SETUP_STATES)[number];

export type SubscriptionCheckoutAttemptState =
  | "reserved"
  | "creating"
  | "outcome_unknown"
  | "manual_review"
  | "open"
  | "completed"
  | "expired"
  | "failed";

export type SubscriptionSetupEvidence = {
  recoveryHold: boolean;
  billingStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  databaseNow: Date | string;
  attemptState: SubscriptionCheckoutAttemptState | null;
  attemptFirstProviderAttemptAt: Date | string | null;
  attemptLeaseExpiresAt: Date | string | null;
  attemptProviderExpiresAt: Date | string | null;
};

export type SubscriptionSetupStatus = {
  hasStripeCustomer: boolean;
  hasSubscription: boolean;
  billingSetupCompleted: boolean;
  billingSetupState: SubscriptionSetupState;
  pollEligible: boolean;
  checkoutAction: "start" | "resume" | null;
  canManageBilling: boolean;
};

export function subscriptionSetupPollingEligible(input: {
  checkoutReturn: string | null;
  narrowPollEligible: boolean | undefined;
  fullPollEligible: boolean | undefined;
}): boolean {
  return (
    input.checkoutReturn === "success" &&
    (input.narrowPollEligible ?? input.fullPollEligible) === true
  );
}

export function subscriptionSetupPollInterval(input: {
  checkoutReturn: string | null;
  pollEligible: boolean | undefined;
  elapsedMs: number;
}): number | false {
  return input.checkoutReturn === "success" &&
    input.pollEligible === true &&
    input.elapsedMs < SUBSCRIPTION_SETUP_POLL_WINDOW_MS
    ? SUBSCRIPTION_SETUP_POLL_INTERVAL_MS
    : false;
}

function timestamp(value: Date | string | null): number | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function status(
  evidence: SubscriptionSetupEvidence,
  billingSetupState: SubscriptionSetupState,
  options: {
    pollEligible?: boolean;
    checkoutAction?: "start" | "resume" | null;
  } = {},
): SubscriptionSetupStatus {
  const connected = billingSetupState === "connected";
  return {
    hasStripeCustomer: Boolean(evidence.stripeCustomerId),
    hasSubscription: Boolean(evidence.stripeSubscriptionId),
    billingSetupCompleted: connected,
    billingSetupState,
    pollEligible: options.pollEligible ?? false,
    checkoutAction: options.checkoutAction ?? null,
    canManageBilling: connected,
  };
}

function withinProviderRetryWindow(
  evidence: SubscriptionSetupEvidence,
): boolean {
  const now = timestamp(evidence.databaseNow);
  const firstAttempt = timestamp(evidence.attemptFirstProviderAttemptAt);
  return now !== null && firstAttempt !== null && now >= firstAttempt
    ? subscriptionCheckoutAttemptRetryRegime({
        firstProviderAttemptAt: new Date(firstAttempt),
        now: new Date(now),
      }) === "retry_same_identity"
    : false;
}

function hasLiveProviderLease(evidence: SubscriptionSetupEvidence): boolean {
  const now = timestamp(evidence.databaseNow);
  const leaseExpiresAt = timestamp(evidence.attemptLeaseExpiresAt);
  return now !== null && leaseExpiresAt !== null && leaseExpiresAt > now;
}

function hasLiveProviderSession(evidence: SubscriptionSetupEvidence): boolean {
  const now = timestamp(evidence.databaseNow);
  const providerExpiresAt = timestamp(evidence.attemptProviderExpiresAt);
  return now !== null && providerExpiresAt !== null && providerExpiresAt > now;
}

const CONNECTED_BILLING_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
]);

const BILLING_STATUSES_ALLOWED_WITHOUT_SUBSCRIPTION = new Set([
  "none",
  "trialing",
  "canceled",
]);

const UNRESOLVED_ATTEMPT_STATES = new Set<SubscriptionCheckoutAttemptState>([
  "reserved",
  "creating",
  "outcome_unknown",
  "manual_review",
  "open",
]);

/**
 * Derive one fail-closed setup truth from durable database evidence. Provider
 * transport identity and browser query parameters are deliberately absent.
 */
export function deriveSubscriptionSetupStatus(input: {
  billingEnforced: boolean;
  evidence: SubscriptionSetupEvidence;
}): SubscriptionSetupStatus {
  const { billingEnforced, evidence } = input;
  if (!billingEnforced) return status(evidence, "not_applicable");
  if (evidence.recoveryHold) return status(evidence, "blocked_recovery");

  const hasCustomer = Boolean(evidence.stripeCustomerId);
  const hasSubscription = Boolean(evidence.stripeSubscriptionId);

  if (hasSubscription) {
    if (
      !hasCustomer ||
      (evidence.attemptState !== null &&
        UNRESOLVED_ATTEMPT_STATES.has(evidence.attemptState))
    ) {
      return status(evidence, "contradiction");
    }
    if (
      CONNECTED_BILLING_STATUSES.has(evidence.billingStatus) ||
      evidence.attemptState === "completed"
    ) {
      return status(evidence, "connected");
    }
    return status(evidence, "contradiction");
  }

  if (
    !BILLING_STATUSES_ALLOWED_WITHOUT_SUBSCRIPTION.has(evidence.billingStatus)
  ) {
    return status(evidence, "contradiction");
  }

  switch (evidence.attemptState) {
    case null:
      return status(evidence, "not_started", { checkoutAction: "start" });
    case "reserved":
      return status(evidence, "retryable", { checkoutAction: "resume" });
    case "creating":
      if (
        timestamp(evidence.attemptFirstProviderAttemptAt) === null ||
        timestamp(evidence.attemptLeaseExpiresAt) === null
      ) {
        return status(evidence, "contradiction");
      }
      if (hasLiveProviderLease(evidence)) {
        return status(evidence, "confirming", { pollEligible: true });
      }
      return withinProviderRetryWindow(evidence)
        ? status(evidence, "retryable", {
            pollEligible: true,
            checkoutAction: "resume",
          })
        : status(evidence, "manual_review");
    case "outcome_unknown":
      if (timestamp(evidence.attemptFirstProviderAttemptAt) === null) {
        return status(evidence, "contradiction");
      }
      return withinProviderRetryWindow(evidence)
        ? status(evidence, "retryable", {
            pollEligible: true,
            checkoutAction: "resume",
          })
        : status(evidence, "manual_review");
    case "manual_review":
      return status(evidence, "manual_review");
    case "open":
      if (timestamp(evidence.attemptProviderExpiresAt) === null) {
        return status(evidence, "contradiction");
      }
      return status(evidence, "retryable", {
        pollEligible: hasLiveProviderSession(evidence),
        checkoutAction: "resume",
      });
    case "completed":
      return evidence.billingStatus === "canceled"
        ? status(evidence, "retryable", { checkoutAction: "start" })
        : status(evidence, "contradiction");
    case "expired":
    case "failed":
      return status(evidence, "retryable", { checkoutAction: "start" });
    default:
      return status(evidence, "contradiction");
  }
}
