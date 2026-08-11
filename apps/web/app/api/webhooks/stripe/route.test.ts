import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE_SOURCE = readFileSync(
  new URL("./route.ts", import.meta.url),
  "utf8"
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const insertConflict = vi.fn(async (_config?: unknown) => undefined);
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoNothing: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => [{ id: "invoice_updated" }]);
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn((_values: unknown) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const execute = vi.fn(async () => []);
  const db = { execute, insert, select, update };

  return {
    db,
    selectResults,
    insertConflict,
    insertValues,
    updateSet,
    claimStripeEvent: vi.fn(async () => true),
    captureStripeCheckoutAuthorization: vi.fn(async (input: { amountCents: number }) => ({
      amountCapturedCents: input.amountCents,
    })),
    constructWebhookEvent: vi.fn(),
    dispatchWebhookEvent: vi.fn(async () => undefined),
    loadClientReceipt: vi.fn(async (): Promise<unknown> => null),
    deliverClientReceipt: vi.fn(async () => undefined),
    execute,
    refundInvalidStripeCheckoutPayment: vi.fn(async () => ({
      outcome: "authorization_canceled" as const,
    })),
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
  captureStripeCheckoutAuthorization: mocks.captureStripeCheckoutAuthorization,
  constructWebhookEvent: mocks.constructWebhookEvent,
  INVOICE_CHECKOUT_CAPTURE_MODE: "manual_v1",
  refundInvalidStripeCheckoutPayment: mocks.refundInvalidStripeCheckoutPayment,
}));

vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/billing/client-receipts", () => ({
  loadClientReceipt: mocks.loadClientReceipt,
  deliverClientReceipt: mocks.deliverClientReceipt,
}));

const { POST } = await import("./route");
const { auditLog, payments } = await import("@openpims/db");
const { STRIPE_WEBHOOK_BODY_MAX_BYTES } = await import(
  "@/lib/stripe-webhook-limits"
);

const INVOICE_ID = "00000000-0000-0000-0000-000000000001";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000ab";
const CLOSEOUT_ID = "00000000-0000-0000-0000-0000000000ac";
vi.spyOn(console, "error").mockImplementation(() => {});

const activeInvoice = {
  id: INVOICE_ID,
  practiceId: PRACTICE_ID,
  total: "125.00",
  paidAmount: "0.00",
  status: "sent",
  isEstimate: false,
};

function checkoutEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        metadata: { invoiceId: INVOICE_ID, source: "client_invoice" },
        amount_total: 12500,
        ...overrides,
      },
    },
  };
}

function stripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  }) as never;
}

function oversizedStripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe", {
    method: "POST",
    headers: {
      "stripe-signature": "sig",
      "content-length": String(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1),
    },
    body: "{}",
  }) as never;
}

function streamedOversizedStripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "x".repeat(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1),
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.claimStripeEvent.mockResolvedValue(true);
  mocks.captureStripeCheckoutAuthorization.mockImplementation(
    async (input: { amountCents: number }) => ({
      amountCapturedCents: input.amountCents,
    })
  );
  mocks.loadClientReceipt.mockResolvedValue(null);
  mocks.execute.mockResolvedValue([]);
  mocks.refundInvalidStripeCheckoutPayment.mockResolvedValue({
    outcome: "authorization_canceled",
  });
});

describe("Stripe client invoice webhook", () => {
  it("rejects oversized payloads before Stripe verification or DB work", async () => {
    const response = await POST(oversizedStripeRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook payload too large",
    });
    expect(mocks.constructWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized payloads without a content-length header", async () => {
    const response = await POST(streamedOversizedStripeRequest());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook payload too large",
    });
    expect(mocks.constructWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("uses the capped streaming body reader", () => {
    expect(ROUTE_SOURCE).toContain("readRequestTextWithLimit(");
    expect(ROUTE_SOURCE).toContain("STRIPE_WEBHOOK_BODY_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toMatch(/\b(?:req|request)\.text\(\)/);
  });

  it("rejects invalid signatures before DB work", async () => {
    mocks.constructWebhookEvent.mockRejectedValueOnce(
      new Error("No signatures found")
    );

    const response = await POST(stripeRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid signature",
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("records checkout payments with a durable checkout-session idempotency key", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.selectResults.push(
      [activeInvoice],
      [activeInvoice],
      [],
      [],
      [{ total: "125.00" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_123",
      endpoint: "client-invoice",
      eventType: "checkout.session.completed",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      amount: "125.00",
      method: "online",
      externalId: "stripe:checkout:cs_test_123",
      notes: "Paid via Stripe Checkout (cs_test_123)",
    });
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: payments.externalId,
    });
    expect(mocks.updateSet).toHaveBeenCalledWith({
      paidAmount: "125.00",
      status: "paid",
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "invoice.paid",
      {
        id: INVOICE_ID,
        paymentExternalId: "stripe:checkout:cs_test_123",
        paidAmount: "125.00",
        total: "125.00",
        source: "stripe",
      }
    );
    // A newly recorded payment emails the pet owner a receipt.
    expect(mocks.loadClientReceipt).toHaveBeenCalledWith(mocks.db, INVOICE_ID, {
      amountPaidCents: 12500,
      balanceRemainingCents: 0,
    });
  });

  it("settles a completed accounts-receivable closeout with the Stripe payment", async () => {
    const linkedInvoice = { ...activeInvoice, appointmentId: APPOINTMENT_ID };
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.selectResults.push(
      [linkedInvoice],
      [{ id: APPOINTMENT_ID }],
      [{ status: "completed" }],
      [linkedInvoice],
      [],
      [],
      [{ total: "125.00" }],
      [{
        id: CLOSEOUT_ID,
        chargeDisposition: "accounts_receivable",
        revision: 2,
      }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ chargeDisposition: "paid", revision: 3 })
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: null,
        action: "visit_closeout_settled",
        entityId: CLOSEOUT_ID,
        changes: expect.objectContaining({
          source: "stripe",
          paymentExternalId: "stripe:checkout:cs_test_123",
          priorRevision: 2,
          nextRevision: 3,
        }),
      })
    );
  });

  it("refunds a recognized legacy Checkout when its linked visit is not ready", async () => {
    const linkedInvoice = { ...activeInvoice, appointmentId: APPOINTMENT_ID };
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.selectResults.push(
      [linkedInvoice],
      [{ id: APPOINTMENT_ID }],
      [{ status: "draft" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:checkout:cs_test_123",
      amountCents: 12500,
      idempotencyKey: "invalid:stripe:checkout:cs_test_123",
    });
    const auditWrite = mocks.insertValues.mock.calls
      .map(([value]) => value)
      .find(
        (value) =>
          (value as { action?: string }).action ===
          "stripe_checkout_invalid_resolved"
      ) as Record<string, any>;
    expect(auditWrite).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        practiceId: PRACTICE_ID,
        action: "stripe_checkout_invalid_resolved",
        entityType: "stripe_checkout_resolution",
        changes: expect.objectContaining({
          eventId: "evt_123",
          endpoint: "client-invoice",
          sessionId: "cs_test_123",
          externalId: "stripe:checkout:cs_test_123",
          invoiceId: INVOICE_ID,
          practiceId: PRACTICE_ID,
          connectedAccountId: null,
          reason: "visit_not_ready",
          outcome: "authorization_canceled",
          refundId: null,
          refundAmountCents: null,
          checkoutAmountCents: 12500,
        }),
      })
    );
    expect(auditWrite.entityId).toBe(auditWrite.id);
    expect(mocks.insertConflict).toHaveBeenCalledWith({ target: auditLog.id });
    expect(mocks.captureStripeCheckoutAuthorization).not.toHaveBeenCalled();
  });

  it("retries rather than resolving Checkout when readiness infrastructure fails", async () => {
    const linkedInvoice = { ...activeInvoice, appointmentId: APPOINTMENT_ID };
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.selectResults.push(
      [linkedInvoice],
      [{ id: APPOINTMENT_ID }],
      [{ status: "clinical_finalized" }]
    );
    mocks.execute.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("emails a receipt only when the client has an email on file", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    const receipt = { to: "jane@example.com" };
    mocks.loadClientReceipt.mockResolvedValue(receipt);
    mocks.selectResults.push(
      [activeInvoice],
      [activeInvoice],
      [],
      [],
      [{ total: "125.00" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.deliverClientReceipt).toHaveBeenCalledWith(receipt);
  });

  it("skips money side effects for already-claimed Stripe events", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.claimStripeEvent.mockResolvedValue(false);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("ignores unrelated Checkout sessions before claiming money events", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({
        metadata: { source: "subscription", invoiceId: INVOICE_ID },
      })
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("ignores Checkout carrying only arbitrary invoice metadata without our source", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ metadata: { invoiceId: INVOICE_ID } })
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("resolves a recognized invoice Checkout with missing invoice metadata", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ metadata: { source: "client_invoice" } })
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:checkout:cs_test_123",
      amountCents: 12500,
      idempotencyKey: "invalid:stripe:checkout:cs_test_123",
    });
  });

  it("recalculates invoice totals for an already-recorded checkout-session payment", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ amount_total: 7500 })
    );
    mocks.selectResults.push(
      [{ ...activeInvoice, total: "100.00", paidAmount: "75.00" }],
      [{ ...activeInvoice, total: "100.00", paidAmount: "75.00" }],
      [{ id: "pay_existing", invoiceId: INVOICE_ID }],
      [],
      [{ total: "75.00" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "stripe:checkout:cs_test_123" })
    );
    expect(mocks.insertConflict).not.toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith({ paidAmount: "75.00" });
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("skips payment side effects when Checkout metadata points at no active invoice", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    mocks.selectResults.push([]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: INVOICE_ID })
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("refunds a legacy automatic-capture Checkout that exceeds the live balance", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ amount_total: 7500 })
    );
    mocks.selectResults.push(
      [{ ...activeInvoice, paidAmount: "75.00" }],
      [{ ...activeInvoice, paidAmount: "75.00" }],
      [],
      []
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:checkout:cs_test_123",
      amountCents: 7500,
      idempotencyKey: "invalid:stripe:checkout:cs_test_123",
    });
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: INVOICE_ID })
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("partially captures a stale manual Checkout at the live remaining balance", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({
        amount_total: 12500,
        payment_intent: "pi_manual_123",
        metadata: {
          invoiceId: INVOICE_ID,
          captureMode: "manual_v1",
          source: "client_invoice",
        },
      })
    );
    mocks.selectResults.push(
      [{ ...activeInvoice, paidAmount: "75.00" }],
      [{ ...activeInvoice, paidAmount: "75.00" }],
      [],
      [],
      [{ total: "125.00" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.captureStripeCheckoutAuthorization).toHaveBeenCalledWith({
      paymentIntentId: "pi_manual_123",
      amountCents: 5000,
      checkoutSessionId: "cs_test_123",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "50.00" })
    );
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("leaves a held-practice event retryable without capturing money", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({
        payment_intent: "pi_held_123",
        metadata: {
          invoiceId: INVOICE_ID,
          captureMode: "manual_v1",
          source: "client_invoice",
        },
      }),
    );
    mocks.selectResults.push([
      { ...activeInvoice, recoveryHold: true },
    ]);

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    expect(mocks.captureStripeCheckoutAuthorization).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "stripe:checkout:cs_test_123" }),
    );
  });

  it("does not capture a manual Checkout after the invoice is voided", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({
        payment_intent: "pi_manual_void",
        metadata: {
          invoiceId: INVOICE_ID,
          captureMode: "manual_v1",
          source: "client_invoice",
        },
      })
    );
    mocks.selectResults.push(
      [{ ...activeInvoice, status: "void" }],
      [{ ...activeInvoice, status: "void" }],
      []
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.captureStripeCheckoutAuthorization).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:checkout:cs_test_123",
      amountCents: 12500,
      idempotencyKey: "invalid:stripe:checkout:cs_test_123",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stripe_checkout_invalid_resolved",
        changes: expect.objectContaining({ reason: "invoice_void" }),
      })
    );
  });

  it.each(["draft", "paid", "void"])(
    "skips payment side effects when Checkout completes for a %s invoice",
    async (status) => {
      mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
      mocks.selectResults.push(
        [{ ...activeInvoice, status }],
        [{ ...activeInvoice, status }],
        []
      );

      const response = await POST(stripeRequest());

      await expect(response.json()).resolves.toEqual({ received: true });
      expect(mocks.insertValues).not.toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: INVOICE_ID })
      );
      expect(mocks.updateSet).not.toHaveBeenCalled();
      expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
      expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
        externalId: "stripe:checkout:cs_test_123",
        amountCents: 12500,
        idempotencyKey: "invalid:stripe:checkout:cs_test_123",
      });
    }
  );

  it("matches checkout invoices only for active practices", () => {
    const invoiceLookup = ROUTE_SOURCE.match(
      /const \[invoice\] = await tx[\s\S]+?\.for\("update", \{ of: invoices \}\);/
    )?.[0];

    expect(invoiceLookup).toContain("innerJoin(");
    expect(invoiceLookup).toContain("practices");
    expect(invoiceLookup).toContain("isNull(practices.deletedAt)");
  });

  it("locks a linked appointment before the invoice row", () => {
    expect(ROUTE_SOURCE.indexOf(".from(appointments)")).toBeGreaterThan(-1);
    expect(ROUTE_SOURCE.indexOf(".from(appointments)")).toBeLessThan(
      ROUTE_SOURCE.indexOf('.for("update", { of: invoices })')
    );
  });
});
