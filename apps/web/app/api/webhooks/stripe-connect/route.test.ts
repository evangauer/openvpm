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

  const insertConflict = vi.fn(async () => undefined);
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoNothing: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => [{ id: "invoice_updated" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const execute = vi.fn(async () => []);
  return {
    db: {
      execute,
      insert,
      select,
      update: vi.fn(() => ({ set: updateSet })),
    },
    selectResults,
    execute,
    insertValues,
    insertConflict,
    updateSet,
    updateWhere,
    captureStripeCheckoutAuthorization: vi.fn(
      async (input: { amountCents: number }) => ({
        amountCapturedCents: input.amountCents,
      })
    ),
    constructConnectWebhookEvent: vi.fn(),
    claimStripeEvent: vi.fn(async () => true),
    refundInvalidStripeCheckoutPayment: vi.fn(async () => ({
      outcome: "authorization_canceled" as const,
    })),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.db),
}));

vi.mock("@/lib/stripe", () => ({
  captureStripeCheckoutAuthorization: mocks.captureStripeCheckoutAuthorization,
  constructConnectWebhookEvent: mocks.constructConnectWebhookEvent,
  INVOICE_CHECKOUT_CAPTURE_MODE: "manual_v1",
  refundInvalidStripeCheckoutPayment: mocks.refundInvalidStripeCheckoutPayment,
}));

vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/billing/client-receipts", () => ({
  loadClientReceipt: vi.fn(async () => null),
  deliverClientReceipt: vi.fn(async () => undefined),
}));

const { POST } = await import("./route");
const { auditLog } = await import("@openpims/db");
vi.spyOn(console, "error").mockImplementation(() => {});
const APPOINTMENT_ID = "00000000-0000-0000-0000-0000000000ab";
const CLOSEOUT_ID = "00000000-0000-0000-0000-0000000000ac";

function stripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-connect", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
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
  mocks.execute.mockResolvedValue([]);
  mocks.refundInvalidStripeCheckoutPayment.mockResolvedValue({
    outcome: "authorization_canceled",
  });
});

describe("Stripe Connect webhook", () => {
  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/stripe-connect", {
        method: "POST",
        body: "{}",
      }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing stripe-signature header",
    });
    expect(mocks.constructConnectWebhookEvent).not.toHaveBeenCalled();
  });

  it("syncs connected account status from account.updated events", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_account",
      type: "account.updated",
      data: {
        object: {
          id: "acct_123",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], disabled_reason: null },
        },
      },
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_connect_account",
      endpoint: "client-invoice-connect",
      eventType: "account.updated",
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingStatus: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsDisabledReason: null,
      })
    );
  });

  it("skips side effects for duplicate Connect events", async () => {
    mocks.claimStripeEvent.mockResolvedValueOnce(false);
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_duplicate",
      type: "account.updated",
      data: { object: { id: "acct_123" } },
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("ignores unrelated connected-account Checkout sessions before claiming", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_unrelated_checkout",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_unrelated",
          metadata: { source: "another_product", invoiceId: "invoice_123" },
        },
      },
    });

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("ignores invoice Checkout with inconsistent connected-account metadata", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_mismatched_account",
      account: "acct_authoritative",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_mismatched_account",
          metadata: {
            source: "client_invoice_connect",
            invoiceId: "invoice_123",
            stripeConnectAccountId: "acct_untrusted",
          },
        },
      },
    });

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("resolves a recognized Checkout when its payment account was deleted", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_deleted_account",
      account: "acct_deleted",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_deleted_account",
          amount_total: 12500,
          metadata: {
            source: "client_invoice_connect",
            invoiceId: "invoice_123",
            stripeConnectAccountId: "acct_deleted",
          },
        },
      },
    });
    mocks.selectResults.push([]);

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId:
        "stripe:connect:acct_deleted:checkout:cs_deleted_account",
      amountCents: 12500,
      idempotencyKey:
        "invalid:stripe:connect:acct_deleted:checkout:cs_deleted_account",
    });
  });

  it("resolves a recognized Checkout with missing invoice metadata", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_missing_invoice",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_missing_invoice",
          amount_total: 12500,
          metadata: {
            source: "client_invoice_connect",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:connect:acct_123:checkout:cs_missing_invoice",
      amountCents: 12500,
      idempotencyKey:
        "invalid:stripe:connect:acct_123:checkout:cs_missing_invoice",
    });
  });

  it("partially captures a stale manual Connect Checkout at the live balance", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_checkout",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_connect_123",
          payment_intent: "pi_connect_123",
          amount_total: 12500,
          metadata: {
            invoiceId: "invoice_123",
            captureMode: "manual_v1",
            source: "client_invoice_connect",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });
    mocks.selectResults.push(
      [{ practiceId: "practice_123", stripeAccountId: "acct_123" }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
      }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
        total: "125.00",
        paidAmount: "75.00",
        status: "sent",
        isEstimate: false,
      }],
      [],
      [],
      [{ total: "125.00" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.captureStripeCheckoutAuthorization).toHaveBeenCalledWith({
      paymentIntentId: "pi_connect_123",
      amountCents: 5000,
      checkoutSessionId: "cs_connect_123",
      connectedAccountId: "acct_123",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "50.00",
        externalId: "stripe:connect:acct_123:checkout:cs_connect_123",
      })
    );
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("settles a completed accounts-receivable closeout with a Connect payment", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_closeout",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_connect_closeout",
          payment_intent: "pi_connect_closeout",
          amount_total: 12500,
          metadata: {
            source: "client_invoice_connect",
            invoiceId: "invoice_123",
            captureMode: "manual_v1",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });
    const linkedInvoice = {
      id: "invoice_123",
      practiceId: "practice_123",
      appointmentId: APPOINTMENT_ID,
      total: "125.00",
      paidAmount: "0.00",
      status: "sent",
      isEstimate: false,
    };
    mocks.selectResults.push(
      [{ practiceId: "practice_123", stripeAccountId: "acct_123" }],
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
        revision: 8,
      }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ chargeDisposition: "paid", revision: 9 })
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "practice_123",
        userId: null,
        action: "visit_closeout_settled",
        entityId: CLOSEOUT_ID,
        changes: expect.objectContaining({
          source: "stripe_connect",
          paymentExternalId:
            "stripe:connect:acct_123:checkout:cs_connect_closeout",
          priorRevision: 8,
          nextRevision: 9,
        }),
      })
    );
  });

  it("refunds a legacy Connect Checkout when its linked visit is not ready", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_unready",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_connect_unready",
          amount_total: 12500,
          metadata: {
            source: "client_invoice_connect",
            invoiceId: "invoice_123",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });
    mocks.selectResults.push(
      [{ practiceId: "practice_123", stripeAccountId: "acct_123" }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
        appointmentId: APPOINTMENT_ID,
      }],
      [{ id: APPOINTMENT_ID }],
      [{ status: "draft" }]
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:connect:acct_123:checkout:cs_connect_unready",
      amountCents: 12500,
      idempotencyKey:
        "invalid:stripe:connect:acct_123:checkout:cs_connect_unready",
    });
  });

  it("retries Connect Checkout when readiness infrastructure fails", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_db_error",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_connect_db_error",
          amount_total: 12500,
          metadata: {
            source: "client_invoice_connect",
            invoiceId: "invoice_123",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });
    mocks.selectResults.push(
      [{ practiceId: "practice_123", stripeAccountId: "acct_123" }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
        appointmentId: APPOINTMENT_ID,
      }],
      [{ id: APPOINTMENT_ID }],
      [{ status: "clinical_finalized" }]
    );
    mocks.execute.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(stripeRequest());

    expect(response.status).toBe(500);
    expect(mocks.refundInvalidStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("does not capture a manual Connect Checkout after the invoice is voided", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_void",
      account: "acct_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_connect_void",
          payment_intent: "pi_connect_void",
          amount_total: 12500,
          metadata: {
            invoiceId: "invoice_123",
            captureMode: "manual_v1",
            source: "client_invoice_connect",
            stripeConnectAccountId: "acct_123",
          },
        },
      },
    });
    mocks.selectResults.push(
      [{ practiceId: "practice_123", stripeAccountId: "acct_123" }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
      }],
      [{
        id: "invoice_123",
        practiceId: "practice_123",
        total: "125.00",
        paidAmount: "0.00",
        status: "void",
        isEstimate: false,
      }],
      []
    );

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.captureStripeCheckoutAuthorization).not.toHaveBeenCalled();
    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:connect:acct_123:checkout:cs_connect_void",
      amountCents: 12500,
      idempotencyKey:
        "invalid:stripe:connect:acct_123:checkout:cs_connect_void",
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
        practiceId: "practice_123",
        action: "stripe_checkout_invalid_resolved",
        entityType: "stripe_checkout_resolution",
        changes: expect.objectContaining({
          eventId: "evt_connect_void",
          endpoint: "client-invoice-connect",
          sessionId: "cs_connect_void",
          externalId:
            "stripe:connect:acct_123:checkout:cs_connect_void",
          invoiceId: "invoice_123",
          practiceId: "practice_123",
          connectedAccountId: "acct_123",
          reason: "invoice_void",
          outcome: "authorization_canceled",
          refundId: null,
          refundAmountCents: null,
          checkoutAmountCents: 12500,
        }),
      })
    );
    expect(auditWrite.entityId).toBe(auditWrite.id);
    expect(mocks.insertConflict).toHaveBeenCalledWith({ target: auditLog.id });
  });

  it("locks a linked appointment before the invoice row", () => {
    expect(ROUTE_SOURCE.indexOf(".from(appointments)")).toBeGreaterThan(-1);
    expect(ROUTE_SOURCE.indexOf(".from(appointments)")).toBeLessThan(
      ROUTE_SOURCE.indexOf('.for("update", { of: invoices })')
    );
  });
});
