import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const INVOICE_ID = "00000000-0000-0000-0000-000000000002";
const OPERATION_ID = "00000000-0000-0000-0000-000000000009";

const baseInvoice = {
  id: INVOICE_ID,
  total: "100.00",
  paidAmount: "20.00",
  status: "sent",
  isEstimate: false,
};

function callerWithDb(
  db: Record<string, unknown>,
  injectOperationId = true
) {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId: PRACTICE_ID,
    },
  };
  const caller = billingRouter.createCaller({ db, session } as never);
  if (!injectOperationId) return caller as any;
  return new Proxy(caller, {
    get(target, property, receiver) {
      if (property === "applyInvoiceAdjustment") {
        return (input: Record<string, unknown>) =>
          target.applyInvoiceAdjustment({
            operationId: OPERATION_ID,
            ...input,
          } as never);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as any;
}

function thenableRows(result: unknown[]) {
  return {
    limit: vi.fn(async () => result),
    orderBy: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
}

function createDb(opts: {
  selectResults: unknown[][];
  adjustmentInsert?: Record<string, unknown>;
  replayAdjustment?: Record<string, unknown>;
  includeOperationLookup?: boolean;
  updateReturns?: unknown[][];
}) {
  const selectResults = [
    ...(opts.includeOperationLookup === false
      ? []
      : [opts.replayAdjustment ? [opts.replayAdjustment] : []]),
    ...opts.selectResults,
  ];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const adjustmentInsert = opts.adjustmentInsert ?? {
    id: "00000000-0000-0000-0000-000000000003",
    invoiceId: INVOICE_ID,
    type: "write_off",
    amount: "80.00",
  };
  const insertReturning = vi.fn(async () => [adjustmentInsert]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[{ id: INVOICE_ID }]])];
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateReturns.shift() ?? []),
    })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing invoice adjustments", () => {
  it("requires an operation ID before adjustment DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db, false).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "10.00",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid adjustment amounts before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "10.123",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        type: "write_off",
        amount: "100000000",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects adjustments for an invoice outside the current practice", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "write_off",
        amount: "10.00",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects adjustments on estimates", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ ...baseInvoice, isEstimate: true }]],
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "10.00",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects adjustments on draft invoices", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ ...baseInvoice, status: "draft" }]],
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "10.00",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Mark the invoice as sent before applying an adjustment.",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects adjustments that exceed the adjusted balance", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[baseInvoice], [{ amount: "70.00", type: "credit" }]],
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "write_off",
        amount: "11.00",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records a write-off adjustment with staff attribution and closes the invoice", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice], []],
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        type: "write_off",
        amount: "80.00",
        reason: "Bad debt",
      })
    ).resolves.toMatchObject({ amount: "80.00", balanceDue: "0.00" });

    expect(updateSet).toHaveBeenCalledWith({
      updatedAt: expect.any(Date),
      status: "paid",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        type: "write_off",
        amount: "80.00",
        reason: "Bad debt",
        createdBy: USER_ID,
        operationKey: `dashboard-adjustment:${PRACTICE_ID}:${OPERATION_ID}`,
        balanceAfter: "0.00",
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "invoice.paid",
      {
        id: INVOICE_ID,
        adjustmentId: "00000000-0000-0000-0000-000000000003",
        adjustmentType: "write_off",
        paidAmount: "20.00",
        adjustedAmount: "80.00",
        total: "100.00",
        source: "dashboard",
      }
    );
  });

  it("returns the original adjustment for an exact operation retry", async () => {
    const replayAdjustment = {
      id: "00000000-0000-0000-0000-000000000003",
      invoiceId: INVOICE_ID,
      type: "write_off",
      amount: "80.00",
      reason: "Bad debt",
      createdBy: USER_ID,
      balanceAfter: "0.00",
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [],
      replayAdjustment,
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        type: "write_off",
        amount: "80.00",
        reason: "Bad debt",
      })
    ).resolves.toMatchObject({ ...replayAdjustment, balanceDue: "0.00" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects reuse of an adjustment operation ID with changed details", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [],
      replayAdjustment: {
        id: "00000000-0000-0000-0000-000000000003",
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "25.00",
        reason: null,
        balanceAfter: "55.00",
      },
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        type: "credit",
        amount: "30.00",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not insert an adjustment when the invoice balance changed concurrently", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice], []],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "write_off",
        amount: "80.00",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Invoice balance changed while applying adjustment. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({
      updatedAt: expect.any(Date),
      status: "paid",
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("records partial adjustments without closing the invoice", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice], []],
      adjustmentInsert: {
        id: "00000000-0000-0000-0000-000000000003",
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "25.00",
      },
    });

    await expect(
      callerWithDb(db).applyInvoiceAdjustment({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "25.00",
      })
    ).resolves.toMatchObject({ amount: "25.00", balanceDue: "55.00" });

    expect(updateSet).toHaveBeenCalledWith({
      updatedAt: expect.any(Date),
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        type: "credit",
        amount: "25.00",
      })
    );
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("validates invoice ownership before listing adjustments", async () => {
    const { db, select } = createDb({
      selectResults: [[]],
      includeOperationLookup: false,
    });

    await expect(
      callerWithDb(db).listAdjustments({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("voids only invoices with no payments or adjustments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ ...baseInvoice, paidAmount: "0.00" }], []],
      includeOperationLookup: false,
      updateReturns: [[{ id: INVOICE_ID, status: "void" }]],
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
  });

  it("does not void when invoice history changed concurrently", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ ...baseInvoice, paidAmount: "0.00" }], []],
      includeOperationLookup: false,
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Invoice changed while voiding. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
  });

  it("rejects voiding invoices with payment history", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[baseInvoice], []],
      includeOperationLookup: false,
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });
});
