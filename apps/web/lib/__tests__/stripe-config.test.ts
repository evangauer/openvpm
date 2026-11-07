import { afterEach, describe, expect, it, vi } from "vitest";
import {
  stripeConnectApplicationFeeBps,
  stripeConnectApplicationFeeConfigured,
  stripeConnectWebhookSecret,
  stripeConfigured,
  stripeSecretKey,
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

  it("treats blank webhook secrets as missing and trims configured values", () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "   ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "\n");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "\t");
    expect(stripeWebhookSecret()).toBeNull();
    expect(stripeConnectWebhookSecret()).toBeNull();
    expect(stripeSubscriptionWebhookSecret()).toBeNull();

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", " whsec_invoice ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", " whsec_connect ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", " whsec_subscription ");
    expect(stripeWebhookSecret()).toBe("whsec_invoice");
    expect(stripeConnectWebhookSecret()).toBe("whsec_connect");
    expect(stripeSubscriptionWebhookSecret()).toBe("whsec_subscription");
  });

  it("defaults Stripe Connect platform fees to zero and clamps configured basis points", () => {
    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "");
    expect(stripeConnectApplicationFeeBps()).toBe(0);
    expect(stripeConnectApplicationFeeConfigured()).toBe(false);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", " 125.8 ");
    expect(stripeConnectApplicationFeeBps()).toBe(125);
    expect(stripeConnectApplicationFeeConfigured()).toBe(true);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "-10");
    expect(stripeConnectApplicationFeeBps()).toBe(0);

    vi.stubEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS", "12000");
    expect(stripeConnectApplicationFeeBps()).toBe(10_000);
  });
});
