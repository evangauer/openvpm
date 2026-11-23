import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLOUD_MONTHLY_PRICE_USD } from "@/lib/billing/catalog";
import { getPlan, TRIAL_DAYS } from "@/lib/billing/plans";
import {
  canResumeHostedCheckout,
  checkoutTrialSummary,
  formatCheckoutTrialEnd,
  resolveCheckoutMonthlyPriceUsd,
  stripeTrialPeriodEnd,
} from "@/lib/billing/checkout-summary";

describe("checkout trial summary", () => {
  it("formats the current Cloud plan as $79/mo", () => {
    const summary = checkoutTrialSummary({
      now: new Date("2026-06-15T16:00:00.000Z"),
    });

    expect(getPlan("cloud").locationUnitPriceMonthlyUsd).toBe(79);
    expect(summary.priceUsd).toBe(79);
    expect(summary.priceLabel).toBe("$79/mo");
    expect(summary.text).toBe(
      `$0 today, trial ends ${summary.trialEndLabel}, then $79/mo`,
    );
    expect(CLOUD_MONTHLY_PRICE_USD).toBe(79);
  });

  it("reads a configured price and falls back to plan metadata", () => {
    expect(
      resolveCheckoutMonthlyPriceUsd({
        configuredPriceUsd: 99,
        plan: { locationUnitPriceMonthlyUsd: 64 },
      }),
    ).toBe(99);
    expect(
      resolveCheckoutMonthlyPriceUsd({
        configuredPriceUsd: null,
        plan: { locationUnitPriceMonthlyUsd: 64 },
      }),
    ).toBe(64);
    expect(
      checkoutTrialSummary({
        now: new Date("2026-06-15T16:00:00.000Z"),
        plan: { locationUnitPriceMonthlyUsd: 64 },
      }).text,
    ).toContain("then $64/mo");
    expect(
      resolveCheckoutMonthlyPriceUsd({
        configuredPriceUsd: null,
        plan: { locationUnitPriceMonthlyUsd: null },
      }),
    ).toBe(CLOUD_MONTHLY_PRICE_USD);
  });

  it("uses the Eastern Time calendar day across midnight", () => {
    const beforeMidnight = checkoutTrialSummary({
      now: new Date("2026-01-15T04:59:59.000Z"),
    });
    const afterMidnight = checkoutTrialSummary({
      now: new Date("2026-01-15T05:00:00.000Z"),
    });

    expect(beforeMidnight.trialEndLabel).toBe("January 28, 2026");
    expect(afterMidnight.trialEndLabel).toBe("January 29, 2026");
    expect(beforeMidnight.text).toBe(
      "$0 today, trial ends January 28, 2026, then $79/mo",
    );
    // 03:30Z is still the previous evening in New York, not the UTC date.
    expect(
      checkoutTrialSummary({ now: new Date("2026-01-15T03:30:00.000Z") })
        .trialEndLabel,
    ).toBe("January 28, 2026");
  });

  it("follows the Stripe trial_period_days date across DST boundaries", () => {
    const cases = [
      {
        // Feb 22, 11:30pm EST. Fourteen exact days land after the spring-forward.
        now: "2026-02-23T04:30:00.000Z",
        label: "March 9, 2026",
      },
      {
        // Oct 18, 11:30pm EDT. Fourteen exact days land on the fall-back evening.
        now: "2026-10-19T03:30:00.000Z",
        label: "November 1, 2026",
      },
      {
        now: "2026-03-08T06:30:00.000Z",
        label: "March 22, 2026",
      },
      {
        now: "2026-11-01T05:30:00.000Z",
        label: "November 15, 2026",
      },
    ];

    for (const testCase of cases) {
      const now = new Date(testCase.now);
      const summary = checkoutTrialSummary({ now });
      const stripeEnd = stripeTrialPeriodEnd(now, TRIAL_DAYS);

      expect(summary.trialEndLabel).toBe(testCase.label);
      expect(formatCheckoutTrialEnd(stripeEnd)).toBe(testCase.label);
      expect(formatCheckoutTrialEnd(summary.trialEndsAt)).toBe(
        formatCheckoutTrialEnd(stripeEnd),
      );
    }
  });

  it("shows an in-progress trial end instead of starting a new 14-day clock", () => {
    const now = new Date("2026-06-15T16:00:00.000Z");
    const existing = new Date("2026-06-20T03:59:59.000Z");
    const summary = checkoutTrialSummary({
      now,
      existingTrialEndsAt: existing,
    });

    expect(summary.trialEndsAt).toEqual(existing);
    expect(summary.trialEndLabel).toBe("June 19, 2026");
    expect(summary.text).toContain("trial ends June 19, 2026");
  });
});

describe("resume checkout eligibility", () => {
  const future = new Date("2026-07-01T00:00:00.000Z");
  const past = new Date("2026-05-01T00:00:00.000Z");
  const now = new Date("2026-06-15T16:00:00.000Z");

  it("hides the button for active and trialing practices", () => {
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: true,
        billingStatus: "active",
        now,
      }),
    ).toBe(false);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: false,
        billingStatus: "active",
        now,
      }),
    ).toBe(false);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: false,
        billingStatus: "trialing",
        trialEndsAt: future,
        now,
      }),
    ).toBe(false);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: true,
        billingStatus: "trialing",
        trialEndsAt: future,
        now,
      }),
    ).toBe(false);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: false,
        billingStatus: "trialing",
        trialEndsAt: past,
        now,
      }),
    ).toBe(false);
  });

  it("shows the button only with no subscription and no active trial", () => {
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: false,
        billingStatus: "none",
        trialEndsAt: null,
        now,
      }),
    ).toBe(true);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: false,
        billingStatus: "canceled",
        trialEndsAt: past,
        now,
      }),
    ).toBe(true);
    expect(
      canResumeHostedCheckout({
        billingEnforced: true,
        hasSubscription: true,
        billingStatus: "none",
        now,
      }),
    ).toBe(false);
    expect(
      canResumeHostedCheckout({
        billingEnforced: false,
        hasSubscription: false,
        billingStatus: "none",
        now,
      }),
    ).toBe(false);
  });
});

describe("checkout resume surfaces", () => {
  const login = readFileSync("app/(auth)/login/page.tsx", "utf8");
  const register = readFileSync("app/(auth)/register/register-form.tsx", "utf8");
  const registerPage = readFileSync("app/(auth)/register/page.tsx", "utf8");
  const settings = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");
  const banner = readFileSync(
    "components/layout/resume-checkout-banner.tsx",
    "utf8",
  );
  const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  const stripe = readFileSync("lib/stripe.ts", "utf8");
  const subscription = readFileSync("server/routers/subscription.ts", "utf8");

  it("keeps card collection and the 14-day trial", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(stripe).toContain('payment_method_collection: "always"');
    expect(subscription).toContain(
      "trialPeriodDays: activeTrialEnd || practice.trialEndsAt ? undefined : TRIAL_DAYS",
    );
    expect(subscription).toContain(
      "stripeBillingAccount: practices.stripeBillingAccount",
    );
  });

  it("shows the summary before checkout and resumes from the stored account flow", () => {
    expect(registerPage).toContain("resolveCheckoutMonthlyPriceUsd()");
    expect(register).toContain("checkoutTrialSummary(");
    expect(register).toContain("Continue to secure checkout");
    expect(register).not.toContain("$79");
    expect(settings).toContain("checkoutTrialSummary(");
    expect(settings).not.toContain("$79");
    expect(settings).toContain(
      '{data.canResumeCheckout ? "Resume checkout" : "Continue to secure checkout"}',
    );
    expect(settings).toContain('searchParams.get("resume") === "checkout"');
    expect(login).toContain("RESUME_CHECKOUT_PATH");
    expect(login).toContain("Resume checkout");
    expect(login).toContain("checkoutTrialSummary(");
    expect(banner).toContain(
      "if (!isAdmin || onBillingTab || !data?.canResumeCheckout) return null",
    );
    expect(banner).toContain("subscription.createCheckout.useMutation");
    expect(banner).toContain("Resume checkout");
    expect(layout).toContain("ResumeCheckoutBanner");
  });
});
