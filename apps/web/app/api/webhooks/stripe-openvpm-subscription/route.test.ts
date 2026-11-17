import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import Stripe from "stripe";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const selectWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const milestoneInserts: unknown[] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn((condition: unknown) => {
        selectWheres.push(condition);
        return builder;
      }),
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
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
  const insertValues = vi.fn((values: unknown) => {
    milestoneInserts.push(values);
    return {
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(async () => [{ practiceId: "projected" }]),
      })),
    };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const db = { select, update, insert };

  return {
    db,
    select,
    selectResults,
    selectWheres,
    updateReturns,
    updateSet,
    milestoneInserts,
    retrieveOpenvpmSubscription: vi.fn(),
    constructSubscriptionWebhookEvent: vi.fn(),
    claimStripeEvent: vi.fn(async (..._args: unknown[]) => true),
    attachStripeEventPractice: vi.fn(async (..._args: unknown[]) => undefined),
    projectStripeConversionMilestonesForEvent: vi.fn(
      async (..._args: unknown[]) => 1,
    ),
    syncPracticeSubscriptionQuantities: vi.fn(async () => ({ status: "ok" })),
    alertOps: vi.fn(async () => undefined),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
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
  subscriptionStripe: vi.fn(() => ({
    subscriptions: { retrieve: mocks.retrieveOpenvpmSubscription },
  })),
  stripe: { subscriptions: { retrieve: vi.fn() } },
}));

vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
  attachStripeEventPractice: mocks.attachStripeEventPractice,
}));

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: mocks.syncPracticeSubscriptionQuantities,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/email", () => ({
  sendPaymentReceiptEmail: vi.fn(),
  sendPaymentFailedEmail: vi.fn(),
}));

vi.mock("@/lib/email-lifecycle", () => ({
  sendLifecycleEmail: vi.fn(),
}));

vi.mock("@/lib/conversion-milestones", () => ({
  projectStripeConversionMilestonesForEvent:
    mocks.projectStripeConversionMilestonesForEvent,
}));

const { POST } = await import("./route");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER_ID = "cus_test_123";
const SUBSCRIPTION_ID = "sub_test_123";
const PRICE_ID = "price_cloud_location";
const EVENT_CREATED = Math.floor(Date.parse("2026-08-02T03:04:05.000Z") / 1000);
const LEGACY_WEBHOOK_SECRET =
  "whsec_" + Buffer.from("legacy-subscription-webhook-secret").toString("base64");
const OPENVPM_WEBHOOK_SECRET =
  "whsec_" + Buffer.from("openvpm-subscription-webhook-secret").toString("base64");

function stripeRequest(body = "{}", signature = "sig") {
  return new Request(
    "https://openvpm.test/api/webhooks/stripe-openvpm-subscription",
    {
      method: "POST",
      headers: { "stripe-signature": signature },
      body,
    },
  ) as never;
}

function checkoutCompletedEvent() {
  return {
    id: "evt_checkout",
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: EVENT_CREATED,
    type: "checkout.session.completed",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: "cs_subscription",
        object: "checkout.session",
        mode: "subscription",
        payment_method_collection: "always",
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
    object: "subscription",
    customer: CUSTOMER_ID,
    metadata,
    status,
    trial_end: status === "trialing" ? 1782604800 : null,
    items: {
      object: "list",
      data: [{ id: "si_test", price: { id: PRICE_ID } }],
    },
  };
}

function invoicePaymentSucceededEvent() {
  return {
    id: "evt_invoice_paid",
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: EVENT_CREATED,
    type: "invoice.payment_succeeded",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: "in_paid",
        object: "invoice",
        customer: CUSTOMER_ID,
        amount_paid: 7900,
        currency: "usd",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: SUBSCRIPTION_ID,
          },
        },
      },
    },
  };
}

function signedEvent(secret: string) {
  const event = {
    id: "evt_signed",
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    type: "customer.created",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: { id: "cus_signed", object: "customer" },
    },
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  return { payload, signature };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.selectWheres.length = 0;
  mocks.updateReturns.length = 0;
  mocks.milestoneInserts.length = 0;
  mocks.constructSubscriptionWebhookEvent.mockReset();
  mocks.retrieveOpenvpmSubscription.mockReset();
  mocks.claimStripeEvent.mockReset();
  mocks.claimStripeEvent.mockResolvedValue(true);
  mocks.attachStripeEventPractice.mockReset();
  mocks.attachStripeEventPractice.mockResolvedValue(undefined);
  mocks.projectStripeConversionMilestonesForEvent.mockReset();
  mocks.projectStripeConversionMilestonesForEvent.mockResolvedValue(1);
  mocks.withSystem.mockReset();
  mocks.withSystem.mockImplementation(async (_db, fn) => fn(mocks.db));
  mocks.alertOps.mockReset();
  mocks.alertOps.mockResolvedValue(undefined);
  delete process.env.STRIPE_PRICE_CLOUD_LOCATION;
  vi.unstubAllEnvs();
});

describe("OpenVPM subscription webhook", () => {
  it("returns 400 when a legacy secret signs the OpenVPM route", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_legacy_webhook_route");
    vi.stubEnv("STRIPE_OPENVPM_SECRET_KEY", "sk_test_openvpm_webhook_route");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", LEGACY_WEBHOOK_SECRET);
    vi.stubEnv(
      "STRIPE_OPENVPM_SUBSCRIPTION_WEBHOOK_SECRET",
      OPENVPM_WEBHOOK_SECRET,
    );
    const stripeModule = await vi.importActual<typeof import("@/lib/stripe")>(
      "@/lib/stripe",
    );
    mocks.constructSubscriptionWebhookEvent.mockImplementation(
      (body: string, signature: string, account?: "legacy" | "openvpm") =>
        stripeModule.constructSubscriptionWebhookEvent(body, signature, account),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const legacy = signedEvent(LEGACY_WEBHOOK_SECRET);
    const rejected = await POST(stripeRequest(legacy.payload, legacy.signature));

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: "Invalid signature" });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(
      "endpoint=/api/webhooks/stripe-openvpm-subscription account=openvpm",
    );
    expect(logged).not.toContain(LEGACY_WEBHOOK_SECRET);
    expect(logged).not.toContain(OPENVPM_WEBHOOK_SECRET);
    expect(logged).not.toContain(legacy.signature);
    expect(logged).not.toContain("whsec_");

    const openvpm = signedEvent(OPENVPM_WEBHOOK_SECRET);
    const accepted = await POST(
      stripeRequest(openvpm.payload, openvpm.signature),
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        eventId: "evt_signed",
        endpoint: "subscription",
        eventType: "customer.created",
      }),
    );
    errorSpy.mockRestore();
  });

  it("keeps stripe event evidence and alerts when an OpenVPM invoice targets a legacy-owned practice", async () => {
    const event = invoicePaymentSucceededEvent();
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(event);
    mocks.retrieveOpenvpmSubscription.mockResolvedValueOnce(
      stripeSubscription("active", {}),
    );
    mocks.selectResults.push([]);
    const durable: Array<Record<string, unknown>> = [];
    const pending: Array<Record<string, unknown>> = [];
    mocks.claimStripeEvent.mockImplementation(async (...args: unknown[]) => {
      pending.push(args[1] as Record<string, unknown>);
      return true;
    });
    mocks.withSystem.mockImplementation(async (_db, fn) => {
      const start = pending.length;
      try {
        const result = await fn(mocks.db);
        durable.push(...pending.slice(start));
        return result;
      } catch (error) {
        pending.splice(start);
        throw error;
      }
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
    });
    expect(durable).toEqual([
      {
        eventId: "evt_invoice_paid",
        endpoint: "subscription",
        eventType: "invoice.payment_succeeded",
        evidence: {
          eventCreatedAt: new Date(EVENT_CREATED * 1000),
          objectId: "in_paid",
          evidenceKind: "positive_subscription_invoice_paid",
          amountCents: 7900,
          currency: "usd",
        },
        practiceId: null,
      },
    ]);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.attachStripeEventPractice).not.toHaveBeenCalled();
    const dialect = new PgDialect();
    const lookup = mocks.selectWheres.map((condition) =>
      dialect.sqlToQuery(condition as never),
    );
    expect(lookup).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('"practices"."stripe_billing_account"'),
        params: expect.arrayContaining(["openvpm"]),
      }),
    ]);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Unmanaged Stripe subscription event",
      "type=invoice.payment_succeeded id=evt_invoice_paid account=openvpm",
    );
  });

  it("does not acknowledge an unmanaged event when its stripe_events row cannot be stored", async () => {
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      invoicePaymentSucceededEvent(),
    );
    mocks.retrieveOpenvpmSubscription.mockResolvedValueOnce(
      stripeSubscription("active", {}),
    );
    mocks.selectResults.push([]);
    mocks.withSystem
      .mockImplementationOnce(async (_db, fn) => fn(mocks.db))
      .mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Handler error" });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Subscription webhook evidence was not stored",
      "type=invoice.payment_succeeded id=evt_invoice_paid account=openvpm",
    );
  });

  it("projects payment_method_collected from checkout.session.completed", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    const milestones = await vi.importActual<
      typeof import("@/lib/conversion-milestones")
    >("@/lib/conversion-milestones");
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      checkoutCompletedEvent(),
    );
    mocks.retrieveOpenvpmSubscription.mockResolvedValueOnce(
      stripeSubscription("trialing"),
    );
    mocks.updateReturns.push([{ id: PRACTICE_ID }], [{ id: PRACTICE_ID }]);
    mocks.projectStripeConversionMilestonesForEvent.mockImplementation(
      async (...args: unknown[]) => {
        const database = args[0];
        const eventId = String(args[1]);
        const claim = mocks.claimStripeEvent.mock.calls.find((call) => {
          const input = call[1] as { eventId?: string } | undefined;
          return input?.eventId === eventId;
        })?.[1] as
          | {
              evidence?: {
                eventCreatedAt?: Date | null;
                evidenceKind?: string | null;
                amountCents?: number | null;
                currency?: string | null;
              };
            }
          | undefined;
        const attached = mocks.attachStripeEventPractice.mock.calls.find(
          (call) => {
            const input = call[1] as { eventId?: string } | undefined;
            return input?.eventId === eventId;
          },
        )?.[1] as { practiceId?: string } | undefined;
        mocks.selectResults.unshift([
          {
            eventId,
            practiceId: attached?.practiceId ?? null,
            eventCreatedAt: claim?.evidence?.eventCreatedAt ?? null,
            evidenceKind: claim?.evidence?.evidenceKind ?? null,
            amountCents: claim?.evidence?.amountCents ?? null,
            currency: claim?.evidence?.currency ?? null,
          },
        ]);
        return milestones.projectStripeConversionMilestonesForEvent(
          database as never,
          eventId,
        );
      },
    );

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.constructSubscriptionWebhookEvent).toHaveBeenCalledWith(
      "{}",
      "sig",
      "openvpm",
    );
    expect(mocks.retrieveOpenvpmSubscription).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
    );
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        eventId: "evt_checkout",
        endpoint: "subscription",
        eventType: "checkout.session.completed",
        evidence: expect.objectContaining({
          evidenceKind: "subscription_checkout_completed",
          objectId: "cs_subscription",
        }),
      }),
    );
    expect(mocks.attachStripeEventPractice).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_checkout",
      endpoint: "subscription",
      practiceId: PRACTICE_ID,
    });
    expect(mocks.milestoneInserts).toContainEqual(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        milestone: "payment_method_collected",
        evidenceSource: "stripe_webhook",
        evidenceKey: "stripe:evt_checkout",
      }),
    );
  });

  it("keeps a replayed checkout idempotent", async () => {
    process.env.STRIPE_PRICE_CLOUD_LOCATION = PRICE_ID;
    mocks.constructSubscriptionWebhookEvent.mockResolvedValue(
      checkoutCompletedEvent(),
    );
    mocks.retrieveOpenvpmSubscription.mockResolvedValue(
      stripeSubscription("trialing"),
    );
    mocks.updateReturns.push([{ id: PRACTICE_ID }], [{ id: PRACTICE_ID }]);
    mocks.claimStripeEvent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const first = await POST(stripeRequest());
    expect(first.status).toBe(200);
    const updates = mocks.updateSet.mock.calls.length;
    expect(updates).toBeGreaterThan(0);
    expect(mocks.retrieveOpenvpmSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.syncPracticeSubscriptionQuantities).toHaveBeenCalledTimes(1);

    const second = await POST(stripeRequest());
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledTimes(updates);
    expect(mocks.retrieveOpenvpmSubscription).toHaveBeenCalledTimes(1);
    expect(mocks.syncPracticeSubscriptionQuantities).toHaveBeenCalledTimes(1);
    expect(mocks.claimStripeEvent).toHaveBeenLastCalledWith(
      mocks.db,
      expect.objectContaining({
        eventId: "evt_checkout",
        endpoint: "subscription",
      }),
    );
  });
});
