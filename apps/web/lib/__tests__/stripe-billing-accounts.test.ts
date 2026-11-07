import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clients: new Map<string, any>() }));
vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/test" })) } };
    billingPortal = {
      sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/test" })) },
      configurations: { retrieve: vi.fn(async () => ({ active: true, features: { subscription_cancel: { enabled: true }, payment_method_update: { enabled: true } } })) },
    };
    accounts = { retrieve: vi.fn(async () => ({ id: "acct_openvpm" })) };
    webhooks = { constructEvent: vi.fn(() => ({ id: "evt_signed" })) };
    constructor(key: string) { mocks.clients.set(key, this); }
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.clients.clear();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_legacy");
  vi.stubEnv("STRIPE_OPENVPM_SECRET_KEY", "sk_test_openvpm");
  vi.stubEnv("STRIPE_OPENVPM_ACCOUNT_ID", "acct_openvpm");
  vi.stubEnv("STRIPE_OPENVPM_BILLING_PORTAL_CONFIGURATION", "bpc_openvpm");
  vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "whsec_legacy");
  vi.stubEnv("STRIPE_OPENVPM_SUBSCRIPTION_WEBHOOK_SECRET", "whsec_openvpm");
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const checkout = {
  practiceId: "practice_new", lineItems: [{ priceId: "price_new", quantity: 1 }],
  trialPeriodDays: 14, successUrl: "https://app.example.com/login?checkout=success",
  cancelUrl: "https://app.example.com/login?checkout=cancelled",
};

describe("separate subscription Stripe clients", () => {
  it("uses the pinned account for checkout and portal while retaining the legacy client", async () => {
    vi.stubEnv("STRIPE_OPENVPM_BILLING_PORTAL_CONFIGURATION", "bpc_openvpm");
    const api = await import("../stripe");
    await api.createSubscriptionCheckoutSession({ ...checkout, billingAccount: "openvpm" });
    await api.createBillingPortalSession({ customerId: "cus_new", returnUrl: "https://app.example.com/settings", billingAccount: "openvpm" });
    const dedicated = mocks.clients.get("sk_test_openvpm");
    const legacy = mocks.clients.get("sk_test_legacy");
    expect(dedicated.accounts.retrieve).toHaveBeenCalledOnce();
    expect(dedicated.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      payment_method_collection: "always", mode: "subscription",
      subscription_data: expect.objectContaining({ trial_period_days: 14 }),
    }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(dedicated.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_new", configuration: "bpc_openvpm" }));
    expect(legacy.checkout.sessions.create).not.toHaveBeenCalled();
    await api.createSubscriptionCheckoutSession({ ...checkout, customerId: "cus_existing" });
    expect(legacy.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_existing" }), expect.anything());
    expect(api.stripe).toBe(legacy);
  });

  it("fails closed without a dedicated key instead of sending new clinics to the legacy account", async () => {
    vi.stubEnv("STRIPE_OPENVPM_SECRET_KEY", "");
    const api = await import("../stripe");
    await expect(api.createSubscriptionCheckoutSession({ ...checkout, billingAccount: "openvpm" })).resolves.toBeNull();
    expect(mocks.clients.get("sk_test_legacy").checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses checkout if the dedicated key belongs to a different account", async () => {
    vi.stubEnv("STRIPE_OPENVPM_ACCOUNT_ID", "acct_wrong");
    const api = await import("../stripe");
    await expect(api.createSubscriptionCheckoutSession({ ...checkout, billingAccount: "openvpm" })).rejects.toThrow("does not match");
    expect(mocks.clients.get("sk_test_openvpm").checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("verifies each endpoint with its own secret and keeps tax configuration separate", async () => {
    vi.stubEnv("STRIPE_TAX_ENABLED", "true");
    vi.stubEnv("STRIPE_OPENVPM_TAX_ENABLED", "false");
    const api = await import("../stripe");
    await api.constructSubscriptionWebhookEvent("body", "sig", "openvpm");
    await api.constructSubscriptionWebhookEvent("body", "sig");
    expect(mocks.clients.get("sk_test_openvpm").webhooks.constructEvent).toHaveBeenCalledWith("body", "sig", "whsec_openvpm");
    expect(mocks.clients.get("sk_test_legacy").webhooks.constructEvent).toHaveBeenCalledWith("body", "sig", "whsec_legacy");
    expect(api.buildSubscriptionCheckoutSessionParams({ ...checkout, billingAccount: "openvpm" })).not.toHaveProperty("automatic_tax");
    expect(api.buildSubscriptionCheckoutSessionParams(checkout)).toHaveProperty("automatic_tax", { enabled: true });
  });
});
