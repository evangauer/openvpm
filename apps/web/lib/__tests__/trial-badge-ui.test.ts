import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trial badge UI", () => {
  const source = readFileSync("components/layout/trial-badge.tsx", "utf8");
  const settingsSource = readFileSync(
    "app/(dashboard)/settings/page.tsx",
    "utf8",
  );
  const addCardSource = readFileSync(
    "components/onboarding/steps/add-a-card.tsx",
    "utf8",
  );

  it("surfaces subscription loading and failures before hiding the badge", () => {
    expect(source).toContain("const { data, isLoading, error }");
    expect(source).toContain("if (!isAdmin) return null");
    expect(source).toContain('aria-label="Checking billing status"');
    expect(source).toContain("Billing status unavailable");
    expect(source).toContain("if (error || !data)");
    expect(source.indexOf("if (isLoading)")).toBeLessThan(
      source.indexOf("if (error || !data)"),
    );
    expect(source.indexOf("if (error || !data)")).toBeLessThan(
      source.indexOf(
        'if (!data.billingEnforced || data.billingStatus === "active")',
      ),
    );
    expect(source).not.toContain(
      'if (!data || !data.billingEnforced || data.billingStatus === "active")',
    );
  });

  it("starts Stripe checkout directly from the trial badge", () => {
    expect(source).toContain("trpc.subscription.createCheckout.useMutation");
    expect(source).toContain('checkout.mutate({ tier: "cloud" })');
    expect(source).toContain("isSafeCheckoutRedirectUrl(result.url)");
    expect(source).toContain("window.location.href = result.url");
    // The trial badge is a real action button now, not a link to settings.
    expect(source).toContain("disabled={checkout.isPending}");
  });

  it("routes card-on-file trialing accounts to billing instead of another Checkout", () => {
    expect(source).toContain("if (data.hasSubscription)");
    expect(source).toContain('href="/settings?tab=billing"');
    expect(source).toContain("Card on file · Manage billing");
    expect(source.indexOf("if (data.hasSubscription)")).toBeLessThan(
      source.indexOf("const trialing ="),
    );
    expect(settingsSource).toContain(
      "data.hasSubscription || data.hasBillingAccount",
    );
    expect(addCardSource).toContain(
      "subscription.data?.hasSubscription || subscription.data?.hasBillingAccount",
    );
  });

  it("distinguishes retrying payments from terminal read-only billing", () => {
    expect(source).toContain('data.billingStatus === "past_due"');
    expect(source).toContain("Payment retrying · Manage billing");
    expect(source).toContain('data.billingStatus === "unpaid"');
    expect(source).toContain("Subscription inactive · Reactivate billing");
    expect(source.indexOf('data.billingStatus === "past_due"')).toBeLessThan(
      source.indexOf("if (data.hasSubscription)"),
    );
    expect(source.indexOf('data.billingStatus === "unpaid"')).toBeLessThan(
      source.indexOf("if (data.hasSubscription)"),
    );
    expect(settingsSource).toContain("Stripe is retrying it.");
    expect(settingsSource).toContain("remains available; update your payment");
    expect(settingsSource).not.toContain(
      "Update your payment method to restore write access.",
    );
  });

  it("counts trial days from the practice timezone", () => {
    expect(source).toContain(
      'import { trialCalendarDaysLeft } from "@/lib/billing/trial-days"',
    );
    expect(source).toContain(
      "trialCalendarDaysLeft(data.trialEndsAt, data.timezone)",
    );
    expect(source).not.toContain("getTime() - Date.now()");
    expect(source).not.toContain("24 * 60 * 60 * 1000");
  });
});
