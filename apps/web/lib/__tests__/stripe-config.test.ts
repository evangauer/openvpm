import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stripeBillingPortalConfigurationId,
  stripeConnectApplicationFeeBps,
  stripeConnectApplicationFeeConfigured,
  stripeConnectV2WebhookSecret,
  stripeConnectWebhookSecret,
  stripeConfigured,
  stripeCredentialMode,
  stripeExpectedAccountId,
  stripeRuntimeModeCheck,
  stripeSecretKey,
  stripeSubscriptionPaymentMethodConfigurationId,
  stripeSubscriptionWebhookSecret,
  stripeWebhookSecret,
} from "../stripe-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe configuration helpers", () => {
  it("treats missing and blank Stripe secrets as unconfigured", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(stripeSecretKey()).toBeNull();
    expect(stripeConfigured()).toBe(false);

    vi.stubEnv("STRIPE_SECRET_KEY", "   ");
    expect(stripeSecretKey()).toBeNull();
    expect(stripeConfigured()).toBe(false);
  });

  it("returns a trimmed Stripe secret when configured", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "  sk_test_123  ");

    expect(stripeSecretKey()).toBe("sk_test_123");
    expect(stripeConfigured()).toBe(true);
  });

  it("fails closed when a hosted Stripe credential mode crosses environments", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_preview");
    expect(stripeCredentialMode()).toBe("test");
    expect(stripeRuntimeModeCheck()).toEqual({
      ok: true,
      mode: "test",
      deployment: "preview",
    });

    vi.stubEnv("STRIPE_SECRET_KEY", "rk_live_crossed");
    expect(stripeRuntimeModeCheck()).toEqual({
      ok: false,
      mode: "live",
      deployment: "preview",
    });

    vi.stubEnv("VERCEL_ENV", "production");
    expect(stripeRuntimeModeCheck().ok).toBe(true);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_crossed");
    expect(stripeRuntimeModeCheck().ok).toBe(false);
  });

  it("allows an operator-selected Stripe mode outside Vercel hosting", () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("STRIPE_SECRET_KEY", "custom-secret");
    expect(stripeRuntimeModeCheck()).toEqual({
      ok: true,
      mode: "unknown",
      deployment: null,
    });
  });

  it("normalizes the expected account and pinned Stripe configurations", () => {
    vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", " acct_openvpm ");
    vi.stubEnv(
      "STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION",
      " pmc_openvpm ",
    );
    vi.stubEnv("STRIPE_BILLING_PORTAL_CONFIGURATION", " bpc_openvpm ");

    expect(stripeExpectedAccountId()).toBe("acct_openvpm");
    expect(stripeSubscriptionPaymentMethodConfigurationId()).toBe(
      "pmc_openvpm",
    );
    expect(stripeBillingPortalConfigurationId()).toBe("bpc_openvpm");

    vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "   ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION", "\n");
    vi.stubEnv("STRIPE_BILLING_PORTAL_CONFIGURATION", "\t");
    expect(stripeExpectedAccountId()).toBeNull();
    expect(stripeSubscriptionPaymentMethodConfigurationId()).toBeNull();
    expect(stripeBillingPortalConfigurationId()).toBeNull();
  });

  it("treats blank webhook secrets as missing and trims configured values", () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "   ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "\n");
    vi.stubEnv("STRIPE_CONNECT_V2_WEBHOOK_SECRET", " ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "\t");
    expect(stripeWebhookSecret()).toBeNull();
    expect(stripeConnectWebhookSecret()).toBeNull();
    expect(stripeConnectV2WebhookSecret()).toBeNull();
    expect(stripeSubscriptionWebhookSecret()).toBeNull();

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", " whsec_invoice ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", " whsec_connect ");
    vi.stubEnv("STRIPE_CONNECT_V2_WEBHOOK_SECRET", " whsec_connect_v2 ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", " whsec_subscription ");
    expect(stripeWebhookSecret()).toBe("whsec_invoice");
    expect(stripeConnectWebhookSecret()).toBe("whsec_connect");
    expect(stripeConnectV2WebhookSecret()).toBe("whsec_connect_v2");
    expect(stripeSubscriptionWebhookSecret()).toBe("whsec_subscription");
  });

  it("accepts only a positive, whole-number Stripe Connect platform fee below 100%", () => {
    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "");
    expect(stripeConnectApplicationFeeBps()).toBe(0);
    expect(stripeConnectApplicationFeeConfigured()).toBe(false);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", " 125 ");
    expect(stripeConnectApplicationFeeBps()).toBe(125);
    expect(stripeConnectApplicationFeeConfigured()).toBe(true);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "125.8");
    expect(stripeConnectApplicationFeeBps()).toBe(0);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "-10");
    expect(stripeConnectApplicationFeeBps()).toBe(0);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "10000");
    expect(stripeConnectApplicationFeeBps()).toBe(0);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "12000");
    expect(stripeConnectApplicationFeeBps()).toBe(0);
  });
});
