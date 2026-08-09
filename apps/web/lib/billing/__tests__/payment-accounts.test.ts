import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stripeConnectAccountState,
  stripeConnectApplicationFeeAmount,
} from "../payment-accounts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe Connect payment accounts", () => {
  it("marks accounts active only when charges and payouts are enabled", () => {
    expect(
      stripeConnectAccountState({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      })
    ).toMatchObject({
      onboardingStatus: "active",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
    });
  });

  it("surfaces requirements and disabled reasons from Stripe", () => {
    expect(
      stripeConnectAccountState({
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: ["company.tax_id"],
          disabled_reason: null,
        },
      })
    ).toMatchObject({
      onboardingStatus: "action_required",
      requirementsCurrentlyDue: ["company.tax_id"],
    });

    expect(
      stripeConnectAccountState({
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: {
          currently_due: [],
          disabled_reason: "rejected.fraud",
        },
      })
    ).toMatchObject({
      onboardingStatus: "disabled",
      requirementsDisabledReason: "rejected.fraud",
    });
  });

  it("defaults platform fees to zero and calculates configured basis points", () => {
    expect(stripeConnectApplicationFeeAmount(10_000)).toBeUndefined();

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "250");
    expect(stripeConnectApplicationFeeAmount(10_000)).toBe(250);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "10000");
    expect(stripeConnectApplicationFeeAmount(1)).toBeUndefined();
    expect(stripeConnectApplicationFeeAmount(2)).toBe(1);
  });
});
