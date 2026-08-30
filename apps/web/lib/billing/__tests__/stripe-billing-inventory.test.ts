import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  assertStripeInventoryCredential,
  summarizeStripeBillingSubscriptions,
  validateStripeBillingPrices,
  type StripeBillingPriceSpec,
} from "../stripe-billing-inventory";

function price(
  id: string,
  interval: "month" | "year",
  usageType: "licensed" | "metered",
): Stripe.Price {
  return {
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: 1,
    currency: "usd",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    product: "prod_openvpm",
    recurring: {
      interval,
      interval_count: 1,
      meter: usageType === "metered" ? "mtr_1" : null,
      trial_period_days: null,
      usage_type: usageType,
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: 7900,
    unit_amount_decimal: "7900",
  } as unknown as Stripe.Price;
}

function subscription(input: {
  id: string;
  billingMode: "classic" | "flexible";
  prices: string[];
  schedule?: string | null;
}): Stripe.Subscription {
  return {
    id: input.id,
    billing_mode: { type: input.billingMode },
    schedule: input.schedule ?? null,
    items: {
      data: input.prices.map((priceId, index) => ({
        id: `si_${index}`,
        price: { id: priceId },
      })),
    },
  } as Stripe.Subscription;
}

describe("Stripe billing inventory", () => {
  it("accepts the intended licensed and metered price intervals", () => {
    const specs: StripeBillingPriceSpec[] = [
      {
        role: "location_monthly",
        priceId: "price_monthly",
        interval: "month",
        usageType: "licensed",
      },
      {
        role: "location_annual",
        priceId: "price_annual",
        interval: "year",
        usageType: "licensed",
      },
      {
        role: "ai_metered_monthly",
        priceId: "price_ai",
        interval: "month",
        usageType: "metered",
      },
    ];
    expect(
      validateStripeBillingPrices(
        specs.map((spec) => ({
          spec,
          price: price(spec.priceId, spec.interval, spec.usageType),
        })),
      ),
    ).toEqual([]);
  });

  it("reports interval, usage, active-state, and currency mismatches", () => {
    const annual = price("price_annual", "month", "metered");
    annual.active = false;
    annual.currency = "cad";
    const findings = validateStripeBillingPrices([
      {
        spec: {
          role: "location_monthly",
          priceId: "price_monthly",
          interval: "month",
          usageType: "licensed",
        },
        price: price("price_monthly", "month", "licensed"),
      },
      {
        spec: {
          role: "location_annual",
          priceId: "price_annual",
          interval: "year",
          usageType: "licensed",
        },
        price: annual,
      },
    ]);
    expect(findings.map((finding) => finding.code)).toEqual([
      "price_inactive",
      "price_interval_mismatch",
      "price_usage_type_mismatch",
      "price_currency_mismatch",
    ]);
  });

  it("rejects one Stripe price being configured for multiple billing roles", () => {
    const shared = price("price_shared", "month", "licensed");
    const findings = validateStripeBillingPrices([
      {
        spec: {
          role: "location_monthly",
          priceId: shared.id,
          interval: "month",
          usageType: "licensed",
        },
        price: shared,
      },
      {
        spec: {
          role: "location_annual",
          priceId: shared.id,
          interval: "month",
          usageType: "licensed",
        },
        price: shared,
      },
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "price_role_collision",
        resourceId: "price_shared",
      }),
    );
  });

  it("summarizes safe flexible subscriptions without exposing customer data", () => {
    const summary = summarizeStripeBillingSubscriptions({
      monthlyLocationPriceId: "price_monthly",
      annualLocationPriceId: "price_annual",
      companionPriceIds: ["price_ai", "price_sms"],
      subscriptions: [
        subscription({
          id: "sub_monthly",
          billingMode: "flexible",
          prices: ["price_monthly", "price_ai", "price_sms"],
        }),
        subscription({
          id: "sub_annual",
          billingMode: "flexible",
          prices: ["price_annual", "price_ai", "price_sms"],
          schedule: "sub_sched_1",
        }),
      ],
    });
    expect(summary).toMatchObject({
      total: 2,
      billingModes: { flexible: 2 },
      cadences: { monthly: 1, annual: 1 },
      attachedSchedules: 1,
      findings: [],
    });
    expect(JSON.stringify(summary)).not.toContain("customer");
  });

  it("flags classic cadence and missing companion states with bounded IDs", () => {
    const summary = summarizeStripeBillingSubscriptions({
      monthlyLocationPriceId: "price_monthly",
      annualLocationPriceId: "price_annual",
      companionPriceIds: ["price_ai"],
      subscriptions: [
        subscription({
          id: "sub_classic_monthly",
          billingMode: "classic",
          prices: ["price_monthly", "price_ai"],
        }),
        subscription({
          id: "sub_classic_annual",
          billingMode: "classic",
          prices: ["price_annual"],
        }),
      ],
    });
    expect(summary.findings.map((finding) => finding.code)).toEqual([
      "monthly_subscription_not_flexible",
      "annual_subscription_not_flexible",
      "subscription_companion_missing",
    ]);
    expect(summary.findings[1]?.resourceId).toBe("sub_classic_annual");
  });

  it("requires deliberate confirmation before live read-only access", () => {
    expect(
      assertStripeInventoryCredential({
        key: "sk_test_redacted",
        allowLiveReadOnly: false,
      }),
    ).toBe("test");
    expect(() =>
      assertStripeInventoryCredential({
        key: "rk_live_redacted",
        allowLiveReadOnly: true,
      }),
    ).toThrow("Live Stripe inventory requires");
    expect(
      assertStripeInventoryCredential({
        key: "rk_live_redacted",
        allowLiveReadOnly: true,
        liveConfirmation: "OPENVPM_STRIPE_LIVE_READ_ONLY",
      }),
    ).toBe("live");
  });
});
