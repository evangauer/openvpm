import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PLANS,
  getPlan,
  planHasFeature,
  isEntitled,
  withinSeatLimit,
  withinLocationLimit,
  isTrialActive,
  effectiveTier,
  hasHostedFullAccess,
  billingEnforced,
  estimatedCloudBaseMonthlyUsd,
  estimatedCloudBaseAnnualUsd,
  tierForStripePrice,
  cloudCheckoutPriceIds,
  billingCadenceForStripePrice,
  cloudMeteredPriceIds,
  stripePriceIdFromEnv,
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
  STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV,
  STRIPE_PRICE_CLOUD_USER_ENV,
  STRIPE_PRICE_CLOUD_LEGACY_ENV,
  STRIPE_PRICE_AI_OVERAGE_ENV,
  STRIPE_PRICE_SMS_OVERAGE_ENV,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  CLOUD_AI_OVERAGE_PRICE_USD,
  CLOUD_SMS_OVERAGE_PRICE_USD,
  ALL_FEATURES,
} from "../plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPlan", () => {
  it("returns the matching plan and falls back to free", () => {
    expect(getPlan("cloud").tier).toBe("cloud");
    expect(getPlan(null).tier).toBe("free");
    expect(getPlan("nonsense").tier).toBe("free");
  });
  it("maps legacy starter/pro tiers onto cloud", () => {
    expect(getPlan("starter").tier).toBe("cloud");
    expect(getPlan("pro").tier).toBe("cloud");
  });
});

describe("planHasFeature (parity)", () => {
  it("cloud and enterprise include every feature; free (lapsed/unpaid) includes none", () => {
    for (const f of ALL_FEATURES) {
      expect(planHasFeature("cloud", f)).toBe(true);
      expect(planHasFeature("enterprise", f)).toBe(true);
      expect(planHasFeature("pro", f)).toBe(true); // legacy → cloud
      expect(planHasFeature("free", f)).toBe(false);
    }
  });
});

describe("isEntitled", () => {
  it("self-host (not enforced) unlocks everything regardless of tier", () => {
    expect(isEntitled("free", "agent", false)).toBe(true);
    expect(isEntitled(null, "sms", false)).toBe(true);
  });
  it("hosted (enforced) gates free/lapsed but allows cloud + enterprise", () => {
    expect(isEntitled("free", "agent", true)).toBe(false);
    expect(isEntitled("cloud", "agent", true)).toBe(true);
    expect(isEntitled("enterprise", "apiAccess", true)).toBe(true);
  });
});

describe("seat + location limits", () => {
  it("not enforced always passes", () => {
    expect(withinSeatLimit("free", 999, false)).toBe(true);
    expect(withinLocationLimit("cloud", 999, false)).toBe(true);
  });
  it("cloud has unlimited seats + locations (billed by quantity)", () => {
    expect(withinSeatLimit("cloud", 100000, true)).toBe(true);
    expect(withinLocationLimit("cloud", 50, true)).toBe(true);
  });
});

describe("trials", () => {
  const now = new Date("2026-06-07T00:00:00Z");
  const future = new Date("2026-06-20T00:00:00Z");
  const past = new Date("2026-06-01T00:00:00Z");

  it("isTrialActive only when status=trialing and not expired", () => {
    expect(isTrialActive("trialing", future, now)).toBe(true);
    expect(isTrialActive("trialing", past, now)).toBe(false);
    expect(isTrialActive("active", future, now)).toBe(false);
    expect(isTrialActive("trialing", null, now)).toBe(false);
  });

  it("effectiveTier grants cloud during an active trial, then reverts to stored tier", () => {
    expect(effectiveTier("free", "trialing", future, now)).toBe("cloud");
    expect(effectiveTier("free", "trialing", past, now)).toBe("free");
    expect(effectiveTier("cloud", "active", future, now)).toBe("cloud");
    expect(effectiveTier("pro", "active", future, now)).toBe("cloud"); // legacy → cloud
  });

  it("an active trial unlocks gated features even on the free tier", () => {
    const tier = effectiveTier("free", "trialing", future, now);
    expect(isEntitled(tier, "agent", true)).toBe(true);
  });
});

describe("PLANS pricing", () => {
  it("uses flat per-location Cloud pricing, free self-host, and custom enterprise", () => {
    expect(PLANS.free.locationUnitPriceMonthlyUsd).toBe(0);
    expect(PLANS.free.seatUnitPriceMonthlyUsd).toBe(0);
    expect(PLANS.cloud.locationUnitPriceMonthlyUsd).toBe(
      CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD
    );
    expect(PLANS.cloud.seatUnitPriceMonthlyUsd).toBe(
      CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
    );
    expect(PLANS.enterprise.locationUnitPriceMonthlyUsd).toBeNull();
    expect(PLANS.enterprise.seatUnitPriceMonthlyUsd).toBeNull();
  });

  it("estimates base Cloud subscription from locations (flat, unlimited staff)", () => {
    // Flat per-location model: staff count does not affect the base.
    expect(estimatedCloudBaseMonthlyUsd(2, 5)).toBe(158);
    expect(estimatedCloudBaseMonthlyUsd(0, 0)).toBe(79);
    expect(estimatedCloudBaseAnnualUsd(2, 5)).toBe(1580);
    expect(CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD).toBe(790);
  });

  it("keeps customer-facing plan blurbs scoped to shipped hosted capabilities", () => {
    expect(PLANS.free.blurb).toContain("Self-host OpenVPM");
    expect(PLANS.free.blurb.toLowerCase()).not.toContain("full product");

    expect(PLANS.cloud.blurb).toContain("supported integration hooks");
    expect(PLANS.cloud.blurb.toLowerCase()).not.toContain("every feature");
    expect(PLANS.cloud.blurb.toLowerCase()).not.toContain("full pims");
  });
});

describe("hosted full access", () => {
  const now = new Date("2026-06-07T00:00:00Z");
  const future = new Date("2026-06-20T00:00:00Z");
  const past = new Date("2026-06-01T00:00:00Z");

  it("self-host is fully writable regardless of billing state", () => {
    expect(hasHostedFullAccess("free", "none", null, now, false)).toBe(true);
  });

  it("allows active trial and active paid subscription", () => {
    expect(hasHostedFullAccess("free", "trialing", future, now, true)).toBe(true);
    expect(hasHostedFullAccess("cloud", "active", past, now, true)).toBe(true);
  });

  it("blocks expired trials, canceled, past due, and no subscription on hosted", () => {
    expect(hasHostedFullAccess("free", "trialing", past, now, true)).toBe(false);
    expect(hasHostedFullAccess("cloud", "past_due", future, now, true)).toBe(false);
    expect(hasHostedFullAccess("cloud", "canceled", future, now, true)).toBe(false);
    expect(hasHostedFullAccess("free", "none", null, now, true)).toBe(false);
  });
});

describe("hosted billing enforcement flag", () => {
  it("trims the hosted billing env flag before enforcing SaaS gates", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", " true ");

    expect(billingEnforced()).toBe(true);
  });

  it("keeps hosted billing disabled for missing, blank, or non-true values", () => {
    expect(billingEnforced()).toBe(false);

    vi.stubEnv("HOSTED_BILLING_ENABLED", "   ");
    expect(billingEnforced()).toBe(false);

    vi.stubEnv("HOSTED_BILLING_ENABLED", "TRUE");
    expect(billingEnforced()).toBe(false);
  });
});

describe("metered overage", () => {
  it("cloud carries included allowances + overage prices; free/enterprise do not bill overage", () => {
    expect(PLANS.cloud.includedAiRunsPerMonth).toBe(1000);
    expect(PLANS.cloud.includedSmsPerMonth).toBe(1000);
    expect(PLANS.cloud.aiOveragePriceUsd).toBe(CLOUD_AI_OVERAGE_PRICE_USD);
    expect(PLANS.cloud.smsOveragePriceUsd).toBe(CLOUD_SMS_OVERAGE_PRICE_USD);
    expect(PLANS.free.aiOveragePriceUsd).toBeNull();
    expect(PLANS.enterprise.smsOveragePriceUsd).toBeNull();
  });

  it("cloudMeteredPriceIds reads the configured overage price envs", () => {
    expect(cloudMeteredPriceIds()).toEqual({
      aiOveragePriceId: undefined,
      smsOveragePriceId: undefined,
    });
    vi.stubEnv(STRIPE_PRICE_AI_OVERAGE_ENV, " price_ai ");
    vi.stubEnv(STRIPE_PRICE_SMS_OVERAGE_ENV, "price_sms");
    expect(cloudMeteredPriceIds()).toEqual({
      aiOveragePriceId: "price_ai",
      smsOveragePriceId: "price_sms",
    });
  });

  it("ignores blank configured overage price envs", () => {
    vi.stubEnv(STRIPE_PRICE_AI_OVERAGE_ENV, "   ");
    vi.stubEnv(STRIPE_PRICE_SMS_OVERAGE_ENV, "\n");

    expect(cloudMeteredPriceIds()).toEqual({
      aiOveragePriceId: undefined,
      smsOveragePriceId: undefined,
    });
  });
});

describe("Stripe price mapping", () => {
  it("normalizes checkout price envs before billing line items use them", () => {
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV, " price_location ");
    vi.stubEnv(STRIPE_PRICE_CLOUD_USER_ENV, "   ");

    expect(cloudCheckoutPriceIds()).toEqual({
      locationPriceId: "price_location",
      seatPriceId: undefined,
    });
  });

  it("selects and maps the annual Cloud location price", () => {
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV, "price_monthly");
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV, " price_annual ");

    expect(cloudCheckoutPriceIds("year").locationPriceId).toBe("price_annual");
    expect(billingCadenceForStripePrice("price_monthly")).toBe("month");
    expect(billingCadenceForStripePrice("price_annual")).toBe("year");
    expect(tierForStripePrice("price_annual")).toBe("cloud");
  });

  it("returns undefined for blank Stripe price envs", () => {
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV, "   ");

    expect(stripePriceIdFromEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV)).toBeUndefined();
  });

  it("maps split Cloud prices and legacy Cloud price to the cloud tier", () => {
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV, " price_location ");
    vi.stubEnv(STRIPE_PRICE_CLOUD_USER_ENV, "price_user");
    vi.stubEnv(STRIPE_PRICE_CLOUD_LEGACY_ENV, "price_legacy");

    expect(tierForStripePrice("price_location")).toBe("cloud");
    expect(tierForStripePrice(" price_location ")).toBe("cloud");
    expect(tierForStripePrice("price_user")).toBe("cloud");
    expect(tierForStripePrice("price_legacy")).toBe("cloud");
    expect(tierForStripePrice("price_other")).toBeNull();
  });

  it("does not map blank Stripe price envs or blank input", () => {
    vi.stubEnv(STRIPE_PRICE_CLOUD_LOCATION_ENV, "   ");

    expect(tierForStripePrice("")).toBeNull();
    expect(tierForStripePrice("   ")).toBeNull();
    expect(tierForStripePrice("price_location")).toBeNull();
  });
});
