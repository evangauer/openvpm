import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  loadClientReceipt: vi.fn(async (): Promise<unknown> => null),
  deliverClientReceipt: vi.fn(async () => undefined),
  refundStripeCheckoutPayment: vi.fn(
    async (): Promise<{ refundId: string } | null> => null
  ),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/billing/client-receipts", () => ({
  loadClientReceipt: mocks.loadClientReceipt,
  deliverClientReceipt: mocks.deliverClientReceipt,
}));

vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: vi.fn(),
  createConnectAccount: vi.fn(),
  createConnectAccountLink: vi.fn(),
  createConnectLoginLink: vi.fn(),
  refundStripeCheckoutPayment: mocks.refundStripeCheckoutPayment,
  retrieveConnectAccount: vi.fn(),
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const INVOICE_ID = "00000000-0000-0000-0000-000000000002";
const PAYMENT_ID = "00000000-0000-0000-0000-000000000003";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000004";
const CLOSEOUT_ID = "00000000-0000-0000-0000-000000000005";

const paidInvoice = {
  id: INVOICE_ID,
  total: "100.00",
  paidAmount: "100.00",
  status: "paid",
  isEstimate: false,
};

const cardPayment = {
  id: PAYMENT_ID,
  invoiceId: INVOICE_ID,
  amount: "100.00",
  method: "online",
  externalId: "stripe:connect:acct_9:checkout:cs_456",
};

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return billingRouter.createCaller({ db, session } as never);
}

function thenableRows(result: unknown[]) {
  const rows = {
    limit: vi.fn(() => rows),
    for: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return rows;
}

function createDb(opts: {
  selectResults: unknown[][];
  refundRow?: Record<string, unknown>;
  updateReturns?: unknown[][];
}) {
  const selectResults = [...opts.selectResults];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const refundRow = opts.refundRow ?? {
    id: "00000000-0000-0000-0000-000000000009",
    invoiceId: INVOICE_ID,
    amount: "-100.00",
    notes: "Refund of recorded payment",
  };
  const insertReturning = vi.fn(async () => [refundRow]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[{ id: INVOICE_ID }]])];
  const updateWhere = vi.fn(() => ({
    returning: vi.fn(async () => updateReturns.shift() ?? []),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve([])),
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };
  return { db, select, insert, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.refundStripeCheckoutPayment.mockResolvedValue(null);
});

describe("billing refunds", () => {
  it("does not call Stripe or mutate money state while the practice is held", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);
    const { db, insertValues, updateSet } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).refundPayment({
        paymentId: PAYMENT_ID,
        reason: "Owner cancelled",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.refundStripeCheckoutPayment).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("refunds a card payment through Stripe and reopens the invoice", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [cardPayment], // payment lookup
        [paidInvoice], // invoice identity
        [], // no existing refund
        [], // adjustments
      ],
    });
    mocks.refundStripeCheckoutPayment.mockResolvedValue({
      refundId: "re_123",
    });

    await callerWithDb(db).refundPayment({
      paymentId: PAYMENT_ID,
      reason: "Owner cancelled",
    });

    expect(insertValues).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      amount: "-100.00",
      method: "online",
      receivedBy: USER_ID,
      externalId: `refund:payment:${PAYMENT_ID}`,
      notes: "Refund: Owner cancelled",
    });
    // A fully refunded paid invoice reopens for collection.
    expect(updateSet).toHaveBeenCalledWith({
      paidAmount: "0.00",
      status: "sent",
    });
    expect(mocks.refundStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: "stripe:connect:acct_9:checkout:cs_456",
      amountCents: 10000,
      idempotencyKey: `refund:payment:${PAYMENT_ID}`,
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "invoice.refunded",
      expect.objectContaining({
        id: INVOICE_ID,
        paymentId: PAYMENT_ID,
        amount: "100.00",
        paidAmount: "0.00",
      })
    );
  });

  it("audits only a due date that the refund actually persisted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[cardPayment], [paidInvoice], [], []],
    });

    await callerWithDb(db).refundPayment({
      paymentId: PAYMENT_ID,
      reason: "Owner cancelled",
      dueDate: "2026-09-15",
    });

    expect(updateSet).toHaveBeenCalledWith({
      paidAmount: "0.00",
      status: "sent",
    });
    expect(updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ dueDate: expect.anything() })
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment_refunded",
        changes: expect.objectContaining({
          priorDueDate: null,
          nextDueDate: null,
        }),
      })
    );
  });

  it("requires the admin role", async () => {
    const { db } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db, "front_desk").refundPayment({
        paymentId: PAYMENT_ID,
        reason: "Owner request",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.refundStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("refuses a second refund of the same payment before touching Stripe", async () => {
    const { db, insert } = createDb({
      selectResults: [
        [cardPayment],
        [paidInvoice],
        [{ id: "existing-refund" }], // refund already recorded
      ],
    });

    await expect(
      callerWithDb(db).refundPayment({
        paymentId: PAYMENT_ID,
        reason: "Owner request",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This payment has already been refunded.",
    });
    expect(mocks.refundStripeCheckoutPayment).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses to refund a refund row", async () => {
    const { db } = createDb({
      selectResults: [[{ ...cardPayment, amount: "-100.00" }]],
    });

    await expect(
      callerWithDb(db).refundPayment({
        paymentId: PAYMENT_ID,
        reason: "Owner request",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only payments can be refunded.",
    });
  });

  it("caps partial refunds at the original payment amount", async () => {
    const { db } = createDb({
      selectResults: [[cardPayment], [], [paidInvoice], []],
    });

    await expect(
      callerWithDb(db).refundPayment({
        paymentId: PAYMENT_ID,
        amount: "150.00",
        reason: "Owner request",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Refund exceeds the original payment.",
    });
    expect(mocks.refundStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("surfaces a Stripe refund failure and records nothing", async () => {
    const { db } = createDb({
      selectResults: [[cardPayment], [paidInvoice], [], []],
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.refundStripeCheckoutPayment.mockRejectedValue(
      new Error("stripe down")
    );

    try {
      await expect(
        callerWithDb(db).refundPayment({
          paymentId: PAYMENT_ID,
          reason: "Owner request",
        })
      ).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: "Stripe could not process the refund. Nothing was recorded.",
      });
      expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refunds manual payments without calling Stripe APIs", async () => {
    const manualPayment = {
      ...cardPayment,
      method: "cash",
      externalId: null,
    };
    const { db, insertValues } = createDb({
      selectResults: [[manualPayment], [paidInvoice], [], []],
    });

    await callerWithDb(db).refundPayment({
      paymentId: PAYMENT_ID,
      reason: "Owner request",
    });

    // The helper is still consulted, but a null externalId is not a Stripe
    // payment, so no Stripe refund happens (mock resolves null).
    expect(mocks.refundStripeCheckoutPayment).toHaveBeenCalledWith({
      externalId: null,
      amountCents: 10000,
      idempotencyKey: `refund:payment:${PAYMENT_ID}`,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "-100.00",
        method: "cash",
        externalId: `refund:payment:${PAYMENT_ID}`,
      })
    );
  });

  it("requires a due date before reopening a completed paid visit", async () => {
    const visitInvoice = {
      ...paidInvoice,
      appointmentId: APPOINTMENT_ID,
      dueDate: null,
    };
    const { db, insert } = createDb({
      selectResults: [
        [cardPayment],
        [visitInvoice],
        [{ id: APPOINTMENT_ID }],
        [],
        [visitInvoice],
        [],
        [
          {
            id: CLOSEOUT_ID,
            chargeDisposition: "paid",
            revision: 4,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).refundPayment({
        paymentId: PAYMENT_ID,
        reason: "Owner requested refund",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Choose a due date before refunding this paid visit into accounts receivable.",
    });
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.refundStripeCheckoutPayment).not.toHaveBeenCalled();
  });

  it("atomically reopens paid visit AR and audits an attributed refund", async () => {
    const visitInvoice = {
      ...paidInvoice,
      appointmentId: APPOINTMENT_ID,
      dueDate: null,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [cardPayment],
        [visitInvoice],
        [{ id: APPOINTMENT_ID }],
        [],
        [visitInvoice],
        [],
        [
          {
            id: CLOSEOUT_ID,
            chargeDisposition: "paid",
            revision: 4,
          },
        ],
      ],
      updateReturns: [[{ id: INVOICE_ID }], [{ id: CLOSEOUT_ID }]],
    });

    await callerWithDb(db).refundPayment({
      paymentId: PAYMENT_ID,
      reason: "Owner requested refund",
      dueDate: "2026-08-31",
    });

    expect(updateSet).toHaveBeenCalledWith({
      paidAmount: "0.00",
      status: "sent",
      dueDate: "2026-08-31",
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeDisposition: "accounts_receivable",
        revision: 5,
      })
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment_refunded",
        entityType: "invoice",
        entityId: INVOICE_ID,
        changes: expect.objectContaining({
          reason: "Owner requested refund",
          closeoutId: CLOSEOUT_ID,
          priorChargeDisposition: "paid",
          nextChargeDisposition: "accounts_receivable",
          priorCloseoutRevision: 4,
          nextCloseoutRevision: 5,
          nextDueDate: "2026-08-31",
        }),
      })
    );
  });
});
