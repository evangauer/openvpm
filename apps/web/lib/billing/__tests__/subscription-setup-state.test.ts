import { describe, expect, it } from "vitest";
import {
  deriveSubscriptionSetupStatus,
  subscriptionSetupPollInterval,
  subscriptionSetupPollingEligible,
  type SubscriptionSetupEvidence,
} from "../subscription-setup-state";

const NOW = "2026-08-26T12:00:00.000Z";

function evidence(
  overrides: Partial<SubscriptionSetupEvidence> = {},
): SubscriptionSetupEvidence {
  return {
    recoveryHold: false,
    billingStatus: "trialing",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    databaseNow: NOW,
    attemptState: null,
    attemptFirstProviderAttemptAt: null,
    attemptLeaseExpiresAt: null,
    attemptProviderExpiresAt: null,
    ...overrides,
  };
}

function derive(overrides: Partial<SubscriptionSetupEvidence> = {}) {
  return deriveSubscriptionSetupStatus({
    billingEnforced: true,
    evidence: evidence(overrides),
  });
}

describe("subscription-authoritative billing setup", () => {
  it("bounds Checkout-return polling to two seconds for less than 30 seconds", () => {
    expect(
      subscriptionSetupPollInterval({
        checkoutReturn: "success",
        pollEligible: true,
        elapsedMs: 0,
      }),
    ).toBe(2_000);
    expect(
      subscriptionSetupPollInterval({
        checkoutReturn: "success",
        pollEligible: true,
        elapsedMs: 29_999,
      }),
    ).toBe(2_000);
    expect(
      subscriptionSetupPollInterval({
        checkoutReturn: "success",
        pollEligible: true,
        elapsedMs: 30_000,
      }),
    ).toBe(false);
    expect(
      subscriptionSetupPollInterval({
        checkoutReturn: null,
        pollEligible: true,
        elapsedMs: 0,
      }),
    ).toBe(false);
    expect(
      subscriptionSetupPollInterval({
        checkoutReturn: "success",
        pollEligible: false,
        elapsedMs: 0,
      }),
    ).toBe(false);
  });

  it("falls back to the full durable read when the narrow poll has no data", () => {
    expect(
      subscriptionSetupPollingEligible({
        checkoutReturn: "success",
        narrowPollEligible: undefined,
        fullPollEligible: true,
      }),
    ).toBe(true);
    expect(
      subscriptionSetupPollingEligible({
        checkoutReturn: "success",
        narrowPollEligible: false,
        fullPollEligible: true,
      }),
    ).toBe(false);
    expect(
      subscriptionSetupPollingEligible({
        checkoutReturn: null,
        narrowPollEligible: undefined,
        fullPollEligible: true,
      }),
    ).toBe(false);
  });

  it("never treats a Stripe customer transport identity as completion", () => {
    expect(derive({ stripeCustomerId: "cus_transport" })).toMatchObject({
      hasStripeCustomer: true,
      hasSubscription: false,
      billingSetupCompleted: false,
      billingSetupState: "not_started",
      checkoutAction: "start",
      canManageBilling: false,
    });
  });

  it("accepts current and legacy subscriptions only with coherent lifecycle evidence", () => {
    expect(
      derive({
        stripeCustomerId: "cus_current",
        stripeSubscriptionId: "sub_current",
        billingStatus: "trialing",
        attemptState: "completed",
      }),
    ).toMatchObject({
      billingSetupCompleted: true,
      billingSetupState: "connected",
      canManageBilling: true,
    });
    expect(
      derive({
        stripeCustomerId: "cus_legacy",
        stripeSubscriptionId: "sub_legacy",
        billingStatus: "active",
      }),
    ).toMatchObject({
      billingSetupCompleted: true,
      billingSetupState: "connected",
    });
    expect(
      derive({
        stripeCustomerId: "cus_reactivated",
        stripeSubscriptionId: "sub_reactivated",
        billingStatus: "canceled",
        attemptState: "completed",
      }),
    ).toMatchObject({
      billingSetupCompleted: true,
      billingSetupState: "connected",
      canManageBilling: true,
    });
  });

  it.each([
    {
      name: "subscription without customer",
      row: { stripeSubscriptionId: "sub_orphan", billingStatus: "active" },
    },
    {
      name: "canceled lifecycle with subscription",
      row: {
        stripeCustomerId: "cus_current",
        stripeSubscriptionId: "sub_stale",
        billingStatus: "canceled",
      },
    },
    {
      name: "active lifecycle without subscription",
      row: { stripeCustomerId: "cus_current", billingStatus: "active" },
    },
    {
      name: "completed attempt without subscription",
      row: {
        stripeCustomerId: "cus_current",
        attemptState: "completed" as const,
      },
    },
    {
      name: "subscription with unresolved attempt",
      row: {
        stripeCustomerId: "cus_current",
        stripeSubscriptionId: "sub_current",
        billingStatus: "trialing",
        attemptState: "open" as const,
      },
    },
    {
      name: "legacy subscription without a valid lifecycle",
      row: {
        stripeCustomerId: "cus_legacy",
        stripeSubscriptionId: "sub_legacy",
        billingStatus: "none",
      },
    },
  ])("fails closed for $name", ({ row }) => {
    expect(derive(row)).toMatchObject({
      billingSetupCompleted: false,
      billingSetupState: "contradiction",
      checkoutAction: null,
      canManageBilling: false,
    });
  });

  it("boundedly polls only evidence that can advance without a new provider POST", () => {
    expect(
      derive({
        attemptState: "creating",
        attemptFirstProviderAttemptAt: "2026-08-26T11:59:00.000Z",
        attemptLeaseExpiresAt: "2026-08-26T12:01:00.000Z",
      }),
    ).toMatchObject({
      billingSetupState: "confirming",
      pollEligible: true,
      checkoutAction: null,
    });
    expect(
      derive({
        attemptState: "open",
        attemptFirstProviderAttemptAt: "2026-08-26T11:59:00.000Z",
        attemptProviderExpiresAt: "2026-08-27T11:59:00.000Z",
      }),
    ).toMatchObject({
      billingSetupState: "retryable",
      pollEligible: true,
      checkoutAction: "resume",
    });
    expect(derive({ attemptState: "reserved" })).toMatchObject({
      billingSetupState: "retryable",
      pollEligible: false,
      checkoutAction: "resume",
    });
  });

  it("moves ambiguous provider ownership from resumable to manual review at 24 hours", () => {
    expect(
      derive({
        attemptState: "outcome_unknown",
        attemptFirstProviderAttemptAt: "2026-08-25T12:00:01.000Z",
      }),
    ).toMatchObject({
      billingSetupState: "retryable",
      checkoutAction: "resume",
    });
    expect(
      derive({
        attemptState: "outcome_unknown",
        attemptFirstProviderAttemptAt: "2026-08-25T12:00:00.000Z",
      }),
    ).toMatchObject({
      billingSetupState: "manual_review",
      checkoutAction: null,
    });
  });

  it("allows a canceled subscription to begin a new exact attempt", () => {
    expect(
      derive({
        stripeCustomerId: "cus_returning",
        billingStatus: "canceled",
        attemptState: "completed",
      }),
    ).toMatchObject({
      billingSetupState: "retryable",
      checkoutAction: "start",
    });
  });

  it("blocks every action during recovery review", () => {
    expect(
      derive({
        recoveryHold: true,
        stripeCustomerId: "cus_current",
        stripeSubscriptionId: "sub_current",
        billingStatus: "active",
      }),
    ).toMatchObject({
      billingSetupCompleted: false,
      billingSetupState: "blocked_recovery",
      checkoutAction: null,
      canManageBilling: false,
    });
  });

  it("does not require or complete hosted billing on self-hosted deployments", () => {
    expect(
      deriveSubscriptionSetupStatus({
        billingEnforced: false,
        evidence: evidence({
          stripeCustomerId: "cus_ignored",
          stripeSubscriptionId: "sub_ignored",
        }),
      }),
    ).toMatchObject({
      billingSetupCompleted: false,
      billingSetupState: "not_applicable",
      checkoutAction: null,
      canManageBilling: false,
    });
  });
});
