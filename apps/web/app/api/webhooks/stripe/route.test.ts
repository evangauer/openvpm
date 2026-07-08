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
      limit: vi.fn(async () => result),
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

  const db = { insert, select, update };

  return {
    db,
    selectResults,
    insertConflict,
    insertValues,
    updateSet,
    claimStripeEvent: vi.fn(async () => true),
    constructWebhookEvent: vi.fn(),
    dispatchWebhookEvent: vi.fn(async () => undefined),
    loadClientReceipt: vi.fn(async (): Promise<unknown> => null),
    deliverClientReceipt: vi.fn(async () => undefined),
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
  constructWebhookEvent: mocks.constructWebhookEvent,
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
const { payments } = await import("@openpims/db");
const { STRIPE_WEBHOOK_BODY_MAX_BYTES } = await import(
  "@/lib/stripe-webhook-limits"
);

const INVOICE_ID = "00000000-0000-0000-0000-000000000001";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
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
        metadata: { invoiceId: INVOICE_ID },
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
  mocks.loadClientReceipt.mockResolvedValue(null);
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

  it("emails a receipt only when the client has an email on file", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
    const receipt = { to: "jane@example.com" };
    mocks.loadClientReceipt.mockResolvedValue(receipt);
    mocks.selectResults.push([activeInvoice], [], [], [{ total: "125.00" }]);

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

  it("recalculates invoice totals for an already-recorded checkout-session payment", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ amount_total: 7500 })
    );
    mocks.selectResults.push(
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

  it("fails before money side effects when Checkout exceeds the live invoice balance", async () => {
    mocks.constructWebhookEvent.mockResolvedValue(
      checkoutEvent({ amount_total: 7500 })
    );
    mocks.selectResults.push(
      [{ ...activeInvoice, paidAmount: "75.00" }],
      [],
      []
    );

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook handler failed",
    });
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: INVOICE_ID })
    );
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it.each(["draft", "paid", "void"])(
    "skips payment side effects when Checkout completes for a %s invoice",
    async (status) => {
      mocks.constructWebhookEvent.mockResolvedValue(checkoutEvent());
      mocks.selectResults.push([{ ...activeInvoice, status }]);

      const response = await POST(stripeRequest());

      await expect(response.json()).resolves.toEqual({ received: true });
      expect(mocks.insertValues).not.toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: INVOICE_ID })
      );
      expect(mocks.updateSet).not.toHaveBeenCalled();
      expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
    }
  );

  it("matches checkout invoices only for active practices", () => {
    const invoiceLookup = ROUTE_SOURCE.match(
      /const \[invoice\] = await tx[\s\S]+?\.limit\(1\);/
    )?.[0];

    expect(invoiceLookup).toContain("innerJoin(");
    expect(invoiceLookup).toContain("practices");
    expect(invoiceLookup).toContain("isNull(practices.deletedAt)");
  });
});
