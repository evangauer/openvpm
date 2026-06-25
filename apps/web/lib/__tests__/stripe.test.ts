import { describe, expect, it } from "vitest";
import { buildSubscriptionCheckoutSessionParams } from "../stripe";
import { TRIAL_DAYS } from "../billing/plans";

describe("buildSubscriptionCheckoutSessionParams", () => {
  it("creates a no-card trial subscription checkout with location and staff items", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerEmail: "admin@example.com",
      lineItems: [
        { priceId: "price_location", quantity: 2 },
        { priceId: "price_user", quantity: 7 },
      ],
      trialPeriodDays: TRIAL_DAYS,
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.mode).toBe("subscription");
    expect(params.payment_method_collection).toBe("if_required");
    expect(params.line_items).toEqual([
      { price: "price_location", quantity: 2 },
      { price: "price_user", quantity: 7 },
    ]);
    expect(params.subscription_data).toMatchObject({
      metadata: { practiceId: "practice_123" },
      trial_period_days: TRIAL_DAYS,
    });
  });

  it("adds metered overage items without a quantity", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      lineItems: [
        { priceId: "price_location", quantity: 3 },
        { priceId: "price_ai_overage", metered: true },
        { priceId: "price_sms_overage", metered: true },
      ],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.line_items).toEqual([
      { price: "price_location", quantity: 3 },
      { price: "price_ai_overage" },
      { price: "price_sms_overage" },
    ]);
  });

  it("requires payment collection when no trial is passed", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.payment_method_collection).toBe("always");
    expect(params.subscription_data).toEqual({
      metadata: { practiceId: "practice_123" },
    });
  });
});
