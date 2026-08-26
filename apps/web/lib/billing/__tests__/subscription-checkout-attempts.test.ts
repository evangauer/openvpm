import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  subscriptionCheckoutAttemptRetryRegime,
  subscriptionCheckoutProviderIdentityConflict,
  subscriptionCheckoutTrialTerms,
} from "../subscription-checkout-attempts";

const HOUR_MS = 60 * 60 * 1000;
const SOURCE = readFileSync(
  new URL("../subscription-checkout-attempts.ts", import.meta.url),
  "utf8",
);

describe("subscription Checkout attempt timing", () => {
  const firstProviderAttemptAt = new Date("2026-08-25T12:00:00.000Z");

  for (const [label, elapsedMs, expected] of [
    ["24h minus 1ms", 24 * HOUR_MS - 1, "retry_same_identity"],
    ["exactly 24h", 24 * HOUR_MS, "manual_review"],
    ["24h plus 1ms", 24 * HOUR_MS + 1, "manual_review"],
    ["25h minus 1ms", 25 * HOUR_MS - 1, "manual_review"],
    ["exactly 25h", 25 * HOUR_MS, "manual_review"],
  ] as const) {
    it(`uses the fail-closed regime at ${label}`, () => {
      expect(
        subscriptionCheckoutAttemptRetryRegime({
          firstProviderAttemptAt,
          now: new Date(firstProviderAttemptAt.getTime() + elapsedMs),
        }),
      ).toBe(expected);
    });
  }

  it("fails closed when the exact-24h manual-review CAS is lost", () => {
    expect(SOURCE).not.toContain("blocked ?? attempt");
    expect(SOURCE).toContain(
      "Subscription Checkout manual-review transition CAS was lost.",
    );
  });
});

describe("subscription Checkout provider identity races", () => {
  it("detects a subscription that appeared after reservation", () => {
    expect(
      subscriptionCheckoutProviderIdentityConflict({
        practice: {
          stripeCustomerId: "cus_expected",
          stripeSubscriptionId: "sub_won_race",
        },
        customerId: "cus_expected",
        subscriptionId: "sub_checkout",
      }),
    ).toBe(true);
  });

  it("accepts an exact replay of the already-persisted provider identity", () => {
    expect(
      subscriptionCheckoutProviderIdentityConflict({
        practice: {
          stripeCustomerId: "cus_expected",
          stripeSubscriptionId: "sub_checkout",
        },
        customerId: "cus_expected",
        subscriptionId: "sub_checkout",
      }),
    ).toBe(false);
  });
});

describe("subscription Checkout trial boundaries", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const terms = (offsetMs: number) =>
    subscriptionCheckoutTrialTerms({
      billingStatus: "trialing",
      trialEndsAt: new Date(now.getTime() + offsetMs),
      now,
    });

  it("does not restart past or exactly-expired historical trials", () => {
    expect(terms(-1)).toEqual({ trialEnd: null, trialPeriodDays: undefined });
    expect(terms(0)).toEqual({ trialEnd: null, trialPeriodDays: undefined });
  });

  it("grants deterministic three-day terms just inside the safe boundary", () => {
    expect(terms(48 * HOUR_MS)).toEqual({
      trialEnd: null,
      trialPeriodDays: 3,
    });
    expect(terms(48 * HOUR_MS + 5 * 60 * 1000 - 1)).toEqual({
      trialEnd: null,
      trialPeriodDays: 3,
    });
  });

  it("preserves the exact 48h plus 5m boundary and well-outside ends", () => {
    const exact = new Date(now.getTime() + 48 * HOUR_MS + 5 * 60 * 1000);
    expect(terms(exact.getTime() - now.getTime())).toEqual({
      trialEnd: exact,
      trialPeriodDays: undefined,
    });
    const outside = new Date(now.getTime() + 7 * 24 * HOUR_MS);
    expect(terms(outside.getTime() - now.getTime())).toEqual({
      trialEnd: outside,
      trialPeriodDays: undefined,
    });
  });
});
