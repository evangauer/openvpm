import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canSafelyReprovisionStripeConnectAccount,
  stripeConnectAccountState,
  stripeConnectApplicationFeeAmount,
} from "../payment-accounts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe Connect payment accounts", () => {
  it("maps an active Accounts v2 merchant without relying on v1 flags", () => {
    expect(
      stripeConnectAccountState({
        object: "v2.core.account",
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { status: "active" },
              stripe_balance: { payouts: { status: "active" } },
            },
          },
        },
        identity: { entity_type: "company" },
        requirements: { entries: [] },
      }),
    ).toMatchObject({
      onboardingStatus: "active",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
      requirementsDisabledReason: null,
    });
  });

  it("fails closed for past-due Accounts v2 requirements", () => {
    expect(
      stripeConnectAccountState({
        object: "v2.core.account",
        configuration: {
          merchant: {
            capabilities: {
              card_payments: { status: "restricted" },
              stripe_balance: { payouts: { status: "restricted" } },
            },
          },
        },
        requirements: {
          entries: [
            {
              awaiting_action_from: "user",
              description: "identity.verification_document",
              minimum_deadline: { status: "past_due" },
            },
          ],
        },
      }),
    ).toMatchObject({
      onboardingStatus: "disabled",
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsCurrentlyDue: ["identity.verification_document"],
      requirementsDisabledReason: "requirements.past_due",
    });
  });

  it("marks accounts active only when charges and payouts are enabled", () => {
    expect(
      stripeConnectAccountState({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      }),
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
      }),
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
      }),
    ).toMatchObject({
      onboardingStatus: "disabled",
      requirementsDisabledReason: "rejected.fraud",
    });
  });

  it("reprovisions only accounts that never became operational", () => {
    const dormant = {
      onboardingStatus: "disabled",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDisabledReason: "requirements.past_due",
    };

    expect(canSafelyReprovisionStripeConnectAccount(dormant)).toBe(true);
    expect(
      canSafelyReprovisionStripeConnectAccount({
        ...dormant,
        detailsSubmitted: true,
      }),
    ).toBe(false);
    expect(
      canSafelyReprovisionStripeConnectAccount({
        ...dormant,
        chargesEnabled: true,
      }),
    ).toBe(false);
    expect(
      canSafelyReprovisionStripeConnectAccount({
        ...dormant,
        requirementsDisabledReason: "rejected.fraud",
      }),
    ).toBe(false);
  });

  it("defaults platform fees to zero and calculates configured basis points", () => {
    expect(stripeConnectApplicationFeeAmount(10_000)).toBeUndefined();

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "250");
    expect(stripeConnectApplicationFeeAmount(10_000)).toBe(250);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "10000");
    expect(stripeConnectApplicationFeeAmount(1)).toBeUndefined();
    expect(stripeConnectApplicationFeeAmount(2)).toBeUndefined();
  });
});
