import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const updateReturns: unknown[][] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const updateReturning = vi.fn(async () => updateReturns.shift() ?? []);
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn((_values: unknown) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db = { select, update };

  return {
    db,
    selectResults,
    updateReturns,
    updateSet,
    constructSubscriptionWebhookEvent: vi.fn(),
    retrieveSubscription: vi.fn(),
    claimStripeEvent: vi.fn(async () => true),
    syncPracticeSubscriptionQuantities: vi.fn(async () => ({ status: "ok" })),
    alertOps: vi.fn(async () => undefined),
    sendLifecycleEmail: vi.fn(
      async (_opts: { send: () => Promise<unknown> }) => undefined
    ),
    sendPaymentReceiptEmail: vi.fn(async () => undefined),
    sendPaymentFailedEmail: vi.fn(async () => undefined),
    recordPracticeFunnelStage: vi.fn(async () => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/stripe", () => ({
  constructSubscriptionWebhookEvent: mocks.constructSubscriptionWebhookEvent,
  stripe: {
    subscriptions: {
      retrieve: mocks.retrieveSubscription,
    },
  },
}));

vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
}));

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: mocks.syncPracticeSubscriptionQuantities,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/email", () => ({
  sendPaymentReceiptEmail: mocks.sendPaymentReceiptEmail,
  sendPaymentFailedEmail: mocks.sendPaymentFailedEmail,
}));

vi.mock("@/lib/email-lifecycle", () => ({
  sendLifecycleEmail: mocks.sendLifecycleEmail,
}));

vi.mock("@/lib/funnel-events-server", () => ({
  recordPracticeFunnelStage: mocks.recordPracticeFunnelStage,
}));

const { POST } = await import("./route");
const { STRIPE_WEBHOOK_BODY_MAX_BYTES } = await import(
  "@/lib/stripe-webhook-limits"
);

const ROUTE_SOURCE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER_ID = "cus_test_123";
const SUBSCRIPTION_ID = "sub_test_123";
const PRICE_ID = "price_cloud_location";

function stripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-subscription", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  }) as never;
}

function oversizedStripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-subscription", {
    method: "POST",
    headers: {
      "stripe-signature": "sig",
      "content-length": String(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1),
    },
    body: "{}",
  }) as never;
}

function streamedOversizedStripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-subscription", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "x".repeat(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1),
  }) as never;
}

function checkoutCompletedEvent() {
  return {
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: PRACTICE_ID,
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
      },
    },
  };
}

function stripeSubscription(
  status: "trialing" | "active" = "active",
  metadata: Record<string, string> = { practiceId: PRACTICE_ID },
) {
  return {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    metadata,
    status,
    trial_end: status === "trialing" ? 1782604800 : null,
    items: {
      data: [{ price: { id: PRICE_ID } }],
    },
  };
}

function subscriptionUpdatedEvent(
  status: "trialing" | "active" = "active",
  eventId = "evt_subscription",
) {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    data: {
      object: stripeSubscription(status),
    },
  };
}

function invoicePaymentSucceededEvent(subscriptionId?: string) {
  return {
    id: "evt_invoice_paid",
    type: "invoice.payment_succeeded",
    data: {
      object: {
        id: "in_paid",
        customer: CUSTOMER_ID,
        amount_paid: 7900,
        currency: "usd",
        period_start: Math.floor(
          Date.parse("2026-07-01T02:00:00.000Z") / 1000
        ),
        period_end: Math.floor(
          Date.parse("2026-08-01T02:00:00.000Z") / 1000
        ),
        hosted_invoice_url: "https://billing.stripe.test/in_paid",
        parent: subscriptionId
          ? {
              type: "subscription_details",
              quote_details: null,
              subscription_details: {
                metadata: { practiceId: PRACTICE_ID },
                subscription: subscriptionId,
              },
            }
          : null,
      },
    },
  };
}

function invoicePaymentFailedEvent() {
  return {
    id: "evt_invoice_failed",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_failed",
        customer: CUSTOMER_ID,
        amount_due: 7900,
        currency: "usd",
        attempt_count: 2,
        next_payment_attempt: Math.floor(
          Date.parse("2026-07-01T02:00:00.000Z") / 1000
        ),
      },
    },
  };
}

function invokeLifecycleSendOnce() {
  mocks.sendLifecycleEmail.mockImplementationOnce(
    async (opts: { send: () => Promise<unknown> }) => {
      await opts.send();
    }
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.updateReturns.length = 0;
  mocks.claimStripeEvent.mockResolvedValue(true);
  mocks.retrieveSubscription.mockResolvedValue(stripeSubscription());
  delete process.env.STRIPE_PRICE_CLOUD_LOCATION;
});

describe("Stripe subscription webhook", () => {
  it("rejects oversized payloads before Stripe verification or DB work", async () => {
    const response = await POST(oversizedStripeRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook payload too large",
    });
    expect(mocks.constructSubscriptionWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized payloads without a content-length header", async () => {
    const response = await POST(streamedOversizedStripeRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook payload too large",
    });
    expect(mocks.constructSubscriptionWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("uses the capped streaming body reader", () => {
    expect(ROUTE_SOURCE).toContain("readRequestTextWithLimit(");
    expect(ROUTE_SOURCE).toContain("STRIPE_WEBHOOK_BODY_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toMatch(/\b(?:req|request)\.text\(\)/);
  });

  it("claims and applies Checkout subscription state after linking an active practice", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      checkoutCompletedEvent()
    );
    mocks.retrieveSubscription.mockResolvedValueOnce(
      stripeSubscription("trialing"),
    );
    mocks.updateReturns.push([{ id: PRACTICE_ID }], [{ id: PRACTICE_ID }]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_checkout",
      endpoint: "subscription",
      eventType: "checkout.session.completed",
    });
    expect(mocks.updateSet).toHaveBeenCalledWith({
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionTier: "cloud",
        billingStatus: "trialing",
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
      }),
    );
    expect(mocks.syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db: mocks.db,
      practiceId: PRACTICE_ID,
      subscriptionId: SUBSCRIPTION_ID,
    });
  });

  it("does not sync Checkout quantities when no active practice was updated", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      checkoutCompletedEvent()
    );
    mocks.updateReturns.push([]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("applies subscription updates only after touching an active practice", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      subscriptionUpdatedEvent()
    );
    mocks.updateReturns.push([{ id: PRACTICE_ID }]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionTier: "cloud",
        billingStatus: "active",
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
        trialEndsAt: null,
      })
    );
    expect(mocks.syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db: mocks.db,
      practiceId: PRACTICE_ID,
      subscriptionId: SUBSCRIPTION_ID,
    });
  });

  it.each(["checkout-first", "subscription-first"] as const)(
    "converges on current Stripe state when events arrive %s",
    async (order) => {
      process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
      const checkout = checkoutCompletedEvent();
      const updated = subscriptionUpdatedEvent("active", "evt_subscription_active");
      const events =
        order === "checkout-first" ? [checkout, updated] : [updated, checkout];
      mocks.constructSubscriptionWebhookEvent
        .mockResolvedValueOnce(events[0])
        .mockResolvedValueOnce(events[1]);
      mocks.retrieveSubscription.mockResolvedValueOnce(
        stripeSubscription("active"),
      );
      mocks.updateReturns.push(
        [{ id: PRACTICE_ID }],
        [{ id: PRACTICE_ID }],
        [{ id: PRACTICE_ID }],
      );

      await expect(POST(stripeRequest()).then((r) => r.json())).resolves.toEqual({
        received: true,
      });
      await expect(POST(stripeRequest()).then((r) => r.json())).resolves.toEqual({
        received: true,
      });

      const statusWrites = mocks.updateSet.mock.calls
        .map(([values]) => values as Record<string, unknown>)
        .filter((values) => "billingStatus" in values);
      expect(statusWrites).toHaveLength(2);
      expect(statusWrites.at(-1)).toEqual(
        expect.objectContaining({
          billingStatus: "active",
          stripeSubscriptionId: SUBSCRIPTION_ID,
        }),
      );
    },
  );

  it("does no reconciliation work for a duplicate claimed event", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      checkoutCompletedEvent(),
    );
    mocks.claimStripeEvent.mockResolvedValueOnce(false);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("falls back to an unambiguous stored subscription when metadata is absent", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    const event = subscriptionUpdatedEvent();
    event.data.object.metadata = {};
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(event);
    mocks.selectResults.push([
      { id: PRACTICE_ID, stripeSubscriptionId: SUBSCRIPTION_ID },
    ]);
    mocks.updateReturns.push([{ id: PRACTICE_ID }]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        billingStatus: "active",
        stripeSubscriptionId: SUBSCRIPTION_ID,
      }),
    );
  });

  it("alerts and retries when metadata-free mapping is ambiguous", async () => {
    const event = subscriptionUpdatedEvent();
    event.data.object.metadata = {};
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(event);
    mocks.selectResults.push([
      { id: PRACTICE_ID, stripeSubscriptionId: SUBSCRIPTION_ID },
      {
        id: "00000000-0000-0000-0000-0000000000bb",
        stripeSubscriptionId: SUBSCRIPTION_ID,
      },
    ]);

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Handler error" });
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Subscription webhook handler error",
      expect.stringContaining("could not be mapped unambiguously"),
    );
  });

  it("normalizes subscription receipt billing contacts before claiming and sending", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentSucceededEvent()
    );
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        email: " Owner@Example.COM ",
        name: "Westside Vet",
        timezone: "America/Los_Angeles",
      },
    ]);
    invokeLifecycleSendOnce();

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.sendLifecycleEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "receipt",
        dedupeKey: "lc:receipt:in_paid",
      })
    );
    expect(mocks.sendPaymentReceiptEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      practiceName: "Westside Vet",
      amount: "$79.00",
      periodLabel: "June 30, 2026 – July 31, 2026",
      invoiceUrl: "https://billing.stripe.test/in_paid",
    });
  });

  it("self-heals subscription state from a positive paid invoice", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentSucceededEvent(SUBSCRIPTION_ID),
    );
    mocks.retrieveSubscription.mockResolvedValueOnce(
      stripeSubscription("active"),
    );
    mocks.updateReturns.push([{ id: PRACTICE_ID }]);
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        email: "owner@example.com",
        name: "Westside Vet",
        timezone: "America/Los_Angeles",
      },
    ]);
    invokeLifecycleSendOnce();

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.retrieveSubscription).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionTier: "cloud",
        billingStatus: "active",
        stripeSubscriptionId: SUBSCRIPTION_ID,
      }),
    );
    expect(mocks.recordPracticeFunnelStage).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      "card_added",
      { stripeStatus: "active" },
    );
    expect(mocks.recordPracticeFunnelStage).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      "paid",
      { stripeStatus: "active" },
    );
    expect(mocks.sendPaymentReceiptEmail).toHaveBeenCalledOnce();
  });

  it("skips subscription receipts when the billing contact is blank", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentSucceededEvent()
    );
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        email: "   ",
        name: "Westside Vet",
        timezone: "America/Los_Angeles",
      },
    ]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(mocks.sendPaymentReceiptEmail).not.toHaveBeenCalled();
  });

  it("normalizes subscription dunning contacts before claiming and sending", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentFailedEvent()
    );
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        email: " Owner@Example.COM ",
        name: "Westside Vet",
        timezone: "America/Los_Angeles",
      },
    ]);
    invokeLifecycleSendOnce();

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith({
      billingStatus: "past_due",
    });
    expect(mocks.sendLifecycleEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "dunning",
        dedupeKey: "lc:dunning:in_failed:2",
      })
    );
    expect(mocks.sendPaymentFailedEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      practiceName: "Westside Vet",
      amount: "$79.00",
      nextRetryDate: "June 30, 2026",
    });
  });

  it("still marks the practice past_due when the dunning contact is blank", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentFailedEvent()
    );
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        email: "\t",
        name: "Westside Vet",
        timezone: "America/Los_Angeles",
      },
    ]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith({
      billingStatus: "past_due",
    });
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(mocks.sendPaymentFailedEmail).not.toHaveBeenCalled();
  });

  it("keeps destructive and customer webhook updates active-practice scoped", () => {
    expect(ROUTE_SOURCE).toContain("eq(practices.stripeSubscriptionId, sub.id)");
    expect(ROUTE_SOURCE).toMatch(
      /eq\(practices\.stripeCustomerId, customerId\),\s*isNull\(practices\.deletedAt\)/s
    );
    expect(ROUTE_SOURCE).toMatch(
      /eq\(practices\.id, practiceId\),\s*isNull\(practices\.deletedAt\)/s
    );
  });
});
