import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trial badge UI", () => {
  const source = readFileSync("components/layout/trial-badge.tsx", "utf8");
  const settingsSource = readFileSync(
    "app/(dashboard)/settings/page.tsx",
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
      source.indexOf("if (!data.billingEnforced) return null"),
    );
    expect(source).not.toContain(
      'if (!data || !data.billingEnforced || data.billingStatus === "active")',
    );
  });

  it("routes the trial badge to the native billing choice before Checkout", () => {
    expect(source).toContain('href="/settings?tab=billing"');
    expect(source).toContain('aria-label="Activate account"');
    expect(source).toContain("· Activate account");
    expect(source).not.toContain("createCheckout.useMutation");
    expect(source).not.toContain("window.location.href");
  });

  it("uses the authoritative setup state before lifecycle display or activation", () => {
    expect(source).toContain("data.billingSetupCompleted");
    expect(source).toContain('data.billingSetupState === "contradiction"');
    expect(source).toContain('data.billingSetupState === "manual_review"');
    expect(source).toContain('data.billingSetupState === "confirming"');
    expect(source).toContain('href="/settings?tab=billing"');
    expect(source).toContain("Billing connected · Manage billing");
    expect(source).toContain("Billing setup needs review");
    expect(source).toContain("Billing confirmation in progress");
    expect(source).toContain("Payment retrying · Review billing");
    expect(source).toContain("Payment unpaid · Read only");
    expect(
      source.indexOf('data.billingSetupState === "contradiction"'),
    ).toBeLessThan(source.indexOf('if (data.billingStatus === "active")'));
    expect(source.indexOf("if (data.billingSetupCompleted)")).toBeLessThan(
      source.indexOf("const trialing ="),
    );
    expect(settingsSource).toContain(
      "const firstActivation = !authoritativeSetup.billingSetupCompleted",
    );
    expect(settingsSource).not.toContain("hasBillingAccount");
    expect(source).not.toContain("data.hasStripeCustomer");
  });

  it("bounds Checkout-return polling without treating the URL as evidence", () => {
    expect(settingsSource).toContain(
      "trpc.subscription.getSetupStatus.useQuery",
    );
    expect(settingsSource).toContain("subscriptionSetupPollInterval");
    expect(settingsSource).toContain("subscriptionSetupPollingEligible");
    expect(settingsSource).toContain("SUBSCRIPTION_SETUP_POLL_WINDOW_MS");
    expect(settingsSource).toContain("if (!checkoutPollEligible)");
    expect(settingsSource).toContain(
      'checkoutStatus === "success" &&\n      authoritativeSetup.billingSetupCompleted',
    );
    expect(settingsSource).toContain(
      "The return URL does not prove completion",
    );
    expect(settingsSource).toContain('role="status"');
    expect(settingsSource).toContain('aria-live="polite"');
    expect(settingsSource).toContain('role="alert"');
    expect(settingsSource).toContain(
      "Refresh this page or contact support before trying Checkout again.",
    );
    expect(settingsSource).not.toContain("setInterval(");
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
