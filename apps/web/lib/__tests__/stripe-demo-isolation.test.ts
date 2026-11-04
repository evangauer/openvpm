import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructed: vi.fn(),
  provider: vi.fn(),
  clients: new Map<string, unknown>(),
  claimStripeEvent: vi.fn(),
  withSystem: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    constructor(key: string) {
      mocks.constructed(key);
      mocks.clients.set(key, this);
    }
    checkout = { sessions: { create: mocks.provider, retrieve: mocks.provider } };
    paymentIntents = { retrieve: mocks.provider, capture: mocks.provider, cancel: mocks.provider };
    refunds = { create: mocks.provider };
    accounts = { create: mocks.provider, retrieve: mocks.provider, createLoginLink: mocks.provider };
    accountLinks = { create: mocks.provider };
    billingPortal = {
      sessions: { create: mocks.provider },
      configurations: { retrieve: mocks.provider },
    };
    billing = { meterEvents: { create: mocks.provider } };
    subscriptions = { retrieve: mocks.provider };
    subscriptionItems = { update: mocks.provider, create: mocks.provider };
    webhooks = { constructEvent: mocks.provider };
  },
}));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/alerts", () => ({ alertOps: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendPaymentReceiptEmail: vi.fn(), sendPaymentFailedEmail: vi.fn() }));
vi.mock("@/lib/email-lifecycle", () => ({ sendLifecycleEmail: vi.fn() }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
  attachStripeEventPractice: vi.fn(),
}));
vi.mock("@/lib/conversion-milestones", () => ({ projectStripeConversionMilestonesForEvent: vi.fn() }));

const legacyKey = "sk_test_synthetic_legacy";
const openvpmKey = "sk_test_synthetic_openvpm";
const checkout = {
  invoiceId: "synthetic-invoice",
  amount: 100,
  clientName: "Example",
  description: "Synthetic checkout",
  successUrl: "https://example.test/success",
  cancelUrl: "https://example.test/cancel",
};
const subscription = {
  lineItems: [{ priceId: "price_synthetic" }],
  practiceId: "synthetic-practice",
  successUrl: checkout.successUrl,
  cancelUrl: checkout.cancelUrl,
};

beforeEach(() => {
  vi.resetModules();
  mocks.clients.clear();
  mocks.provider.mockReset();
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
  vi.stubEnv("STRIPE_SECRET_KEY", legacyKey);
  vi.stubEnv("STRIPE_OPENVPM_SECRET_KEY", openvpmKey);
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic");
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic_connect");
  vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "whsec_synthetic_subscription");
  vi.stubEnv("STRIPE_OPENVPM_SUBSCRIPTION_WEBHOOK_SECRET", "whsec_synthetic_openvpm");
  vi.stubEnv("STRIPE_OPENVPM_ACCOUNT_ID", "acct_synthetic");
  vi.stubEnv("STRIPE_OPENVPM_BILLING_PORTAL_CONFIGURATION", "bpc_synthetic");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectUnavailable(api: typeof import("../stripe")) {
  expect(api.getStripeClient()).toBeNull();
  expect("stripe" in api).toBe(false);
  await expect(api.createCheckoutSession(checkout)).resolves.toBeNull();
  await expect(api.captureStripeCheckoutAuthorization({
    paymentIntentId: "pi_synthetic", amountCents: 100, checkoutSessionId: "cs_synthetic",
  })).rejects.toThrow("cannot capture card payment");
  await expect(api.refundInvalidStripeCheckoutPayment({
    externalId: "stripe:checkout:cs_synthetic", amountCents: 100, idempotencyKey: "synthetic",
  })).rejects.toThrow("cannot resolve card payment");
  await expect(api.refundStripeCheckoutPayment({
    externalId: "stripe:checkout:cs_synthetic", amountCents: 100,
  })).rejects.toThrow("cannot refund a card payment");
  await expect(api.refundStripeCheckoutPayment({ externalId: "cash", amountCents: 100 })).resolves.toBeNull();
  await expect(api.createConnectAccount({ practiceId: "synthetic-practice" })).resolves.toBeNull();
  await expect(api.retrieveConnectAccount("acct_synthetic")).resolves.toBeNull();
  await expect(api.createConnectAccountLink({
    accountId: "acct_synthetic", refreshUrl: checkout.cancelUrl, returnUrl: checkout.successUrl,
  })).resolves.toBeNull();
  await expect(api.createConnectLoginLink("acct_synthetic")).resolves.toBeNull();
  await expect(api.constructWebhookEvent("{}", "sig")).resolves.toBeNull();
  await expect(api.constructConnectWebhookEvent("{}", "sig")).resolves.toBeNull();
  for (const billingAccount of ["legacy", "openvpm"] as const) {
    expect(api.subscriptionStripe(billingAccount)).toBeNull();
    await expect(api.createSubscriptionCheckoutSession({ ...subscription, billingAccount })).resolves.toBeNull();
    await expect(api.createBillingPortalSession({
      customerId: "cus_synthetic", returnUrl: checkout.successUrl, billingAccount,
    })).resolves.toBeNull();
    await expect(api.constructSubscriptionWebhookEvent("{}", "sig", billingAccount)).resolves.toBeNull();
  }
  expect(mocks.provider).not.toHaveBeenCalled();
}

function syntheticSyncDb(billingAccount: "legacy" | "openvpm") {
  let reads = 0;
  const select = vi.fn(() => {
    const rows = reads++ === 0
      ? [{ stripeSubscriptionId: "sub_synthetic", stripeBillingAccount: billingAccount, recoveryHold: false }]
      : [{ c: 1 }];
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      for: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return builder;
  });
  const write = vi.fn(async () => []);
  return { select, update: vi.fn(() => ({ set: () => ({ where: write }) })) };
}

describe("Stripe demo isolation", () => {
  it.each(["true", " true ", "\ntrue\t"])("never constructs either client for %j despite inherited keys", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", flag);
    const api = await import("../stripe");
    await expectUnavailable(api);
    expect(mocks.constructed).not.toHaveBeenCalled();
    // Disabling a demo-imported module cannot resurrect unconstructed clients.
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    expect(api.getStripeClient()).toBeNull();
    expect(api.subscriptionStripe("openvpm")).toBeNull();
  });

  it.each(["false", "", "TRUE", "1"])("keeps exact existing boolean conventions for %j", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", flag);
    const api = await import("../stripe");
    expect(mocks.constructed).toHaveBeenCalledTimes(2);
    expect(api.getStripeClient()).toBe(mocks.clients.get(legacyKey));
    expect(api.subscriptionStripe("legacy")).toBe(mocks.clients.get(legacyKey));
    expect(api.subscriptionStripe("openvpm")).toBe(mocks.clients.get(openvpmKey));
  });

  it("blocks every helper when a Cloud-imported module enters demo at runtime", async () => {
    const api = await import("../stripe");
    expect(mocks.constructed).toHaveBeenCalledTimes(2);
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", " true ");
    await expectUnavailable(api);
  });

  it("preserves configured Cloud invoice checkout and meter behavior", async () => {
    const api = await import("../stripe");
    const { recordMeterEvent } = await import("../billing/stripe-meters");
    mocks.provider.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/synthetic" });
    await expect(api.createCheckoutSession(checkout)).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay/synthetic" });
    await expect(recordMeterEvent({ kind: "ai_run", stripeCustomerId: "cus_synthetic" })).resolves.toBe(true);
    expect(mocks.provider).toHaveBeenCalledTimes(2);
  });

  it.each(["legacy", "openvpm"] as const)("stops imported %s meter, sync and pre-created webhook handlers after a demo toggle", async (billingAccount) => {
    await import("../stripe");
    const { recordMeterEvent } = await import("../billing/stripe-meters");
    const { syncPracticeSubscriptionQuantities } = await import("../billing/subscription-sync");
    const { createSubscriptionWebhookHandler } = await import("../billing/subscription-webhook");
    const POST = createSubscriptionWebhookHandler(billingAccount);
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_synthetic");
    vi.stubEnv("STRIPE_OPENVPM_PRICE_CLOUD_LOCATION", "price_synthetic");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    await expect(recordMeterEvent({ kind: "ai_run", stripeCustomerId: "cus_synthetic", billingAccount })).resolves.toBe(false);
    await expect(syncPracticeSubscriptionQuantities({
      db: syntheticSyncDb(billingAccount) as never, practiceId: "synthetic-practice",
    })).resolves.toMatchObject({ status: "error", message: "Stripe API key is not configured." });
    const response = await POST(new Request("https://example.test/webhook", {
      method: "POST", headers: { "stripe-signature": "sig" }, body: "{}",
    }) as never);
    expect(response.status).toBe(400);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("cannot capture after demo is enabled during a PaymentIntent lookup", async () => {
    const api = await import("../stripe");
    mocks.provider.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { status: "requires_capture", amount_capturable: 100, amount: 100 };
    });
    await expect(api.captureStripeCheckoutAuthorization({
      paymentIntentId: "pi_synthetic", amountCents: 100, checkoutSessionId: "cs_synthetic",
    })).rejects.toThrow("cannot capture card payment");
    expect(mocks.provider).toHaveBeenCalledOnce();
  });

  it.each(["checkout", "portal"] as const)("cannot create dedicated %s after demo is enabled during account verification", async (operation) => {
    const api = await import("../stripe");
    mocks.provider.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { id: "acct_synthetic" };
    });
    const result = operation === "checkout"
      ? api.createSubscriptionCheckoutSession({ ...subscription, billingAccount: "openvpm" })
      : api.createBillingPortalSession({ customerId: "cus_synthetic", returnUrl: checkout.successUrl, billingAccount: "openvpm" });
    await expect(result).resolves.toBeNull();
    expect(mocks.provider).toHaveBeenCalledOnce();
  });

  it.each(["checkout", "portal"] as const)("rechecks demo after the dedicated portal configuration lookup before %s", async (operation) => {
    const api = await import("../stripe");
    mocks.provider.mockResolvedValueOnce({ id: "acct_synthetic" });
    mocks.provider.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { active: true, features: { subscription_cancel: { enabled: true }, payment_method_update: { enabled: true } } };
    });
    const result = operation === "checkout"
      ? api.createSubscriptionCheckoutSession({ ...subscription, billingAccount: "openvpm" })
      : api.createBillingPortalSession({ customerId: "cus_synthetic", returnUrl: checkout.successUrl, billingAccount: "openvpm" });
    await expect(result).resolves.toBeNull();
    expect(mocks.provider).toHaveBeenCalledTimes(2);
  });

  it("cannot refund or look up a fallback intent after demo is enabled during a Checkout lookup", async () => {
    const api = await import("../stripe");
    mocks.provider.mockImplementation(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { payment_intent: "pi_synthetic" };
    });
    await expect(api.refundStripeCheckoutPayment({ externalId: "stripe:checkout:cs_synthetic", amountCents: 100 })).rejects.toThrow("cannot refund a card payment");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
    await expect(api.refundInvalidStripeCheckoutPayment({
      externalId: "stripe:checkout:cs_synthetic", amountCents: 100, idempotencyKey: "synthetic",
    })).rejects.toThrow("cannot resolve card payment");
    expect(mocks.provider).toHaveBeenCalledTimes(2);
  });

  it.each(["requires_capture", "succeeded"])("cannot cancel/refund a %s intent when demo is enabled during its lookup", async (status) => {
    const api = await import("../stripe");
    mocks.provider.mockResolvedValueOnce({ payment_intent: "pi_synthetic" });
    mocks.provider.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { status, amount_received: 100 };
    });
    await expect(api.refundInvalidStripeCheckoutPayment({
      externalId: "stripe:checkout:cs_synthetic", amountCents: 100, idempotencyKey: "synthetic",
    })).rejects.toThrow("cannot resolve card payment");
    expect(mocks.provider).toHaveBeenCalledTimes(2);
  });

  it("cannot update subscription items after demo is enabled during subscription retrieval", async () => {
    await import("../stripe");
    const { syncPracticeSubscriptionQuantities } = await import("../billing/subscription-sync");
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_synthetic");
    mocks.provider.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return { items: { data: [{ id: "si_synthetic", price: { id: "price_synthetic" } }] } };
    });
    await expect(syncPracticeSubscriptionQuantities({
      db: syntheticSyncDb("legacy") as never, practiceId: "synthetic-practice", alertOnError: false,
    })).resolves.toMatchObject({ status: "error", message: "Stripe API key is not configured." });
    expect(mocks.provider).toHaveBeenCalledOnce();
  });

  it("rechecks demo after claiming a signed webhook event before subscription retrieval", async () => {
    const { createSubscriptionWebhookHandler } = await import("../billing/subscription-webhook");
    mocks.provider.mockReturnValueOnce({
      id: "evt_synthetic", type: "customer.subscription.updated",
      data: { object: { id: "sub_synthetic", status: "active", metadata: {} } },
    });
    mocks.withSystem.mockImplementationOnce(async (_db, fn) => fn({}));
    mocks.claimStripeEvent.mockImplementationOnce(async () => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createSubscriptionWebhookHandler("legacy")(new Request("https://example.test/webhook", {
      method: "POST", headers: { "stripe-signature": "sig" }, body: "{}",
    }) as never);
    expect(response.status).toBe(500);
    // Signature construction is the sole SDK call. No subscription is fetched.
    expect(mocks.provider).toHaveBeenCalledOnce();
    expect(mocks.claimStripeEvent).toHaveBeenCalledOnce();
  });
});
