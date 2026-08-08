import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  loadClientReceipt: vi.fn(async (): Promise<unknown> => null),
  deliverClientReceipt: vi.fn(async () => undefined),
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
      if (property === "recordPayment") {
        return (input: Record<string, unknown>) =>
          target.recordPayment({
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
    then: (resolve: (value: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

function createDb(opts: {
  selectResults: unknown[][];
  payment?: Record<string, unknown>;
  replayPayment?: Record<string, unknown>;
  includeOperationLookup?: boolean;
  updateReturns?: unknown[][];
}) {
  const selectResults = [
    ...(opts.includeOperationLookup === false
      ? []
      : [opts.replayPayment ? [opts.replayPayment] : []]),
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

  const payment = opts.payment ?? {
    id: "00000000-0000-0000-0000-000000000003",
    invoiceId: INVOICE_ID,
    amount: "30.00",
    method: "cash",
  };
  const insertReturning = vi.fn(async () => [payment]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[{ id: INVOICE_ID }]])];
  const updateWhere = vi.fn(() => ({
    returning: vi.fn(async () => updateReturns.shift() ?? []),
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

  return { db, select, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing payments", () => {
  it("requires an operation ID before payment DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db, false).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid payment amounts before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "10.123",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "0.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid payment notes before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "10.00",
        method: "cash",
        notes: "n".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects payment for an invoice outside the current practice", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects payment on an estimate", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ ...baseInvoice, isEstimate: true }]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects payment on a draft invoice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ ...baseInvoice, status: "draft" }]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Mark the invoice as sent before recording payment.",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects overpayments server-side", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[baseInvoice]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "81.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects payments that exceed the adjusted balance", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[baseInvoice], [{ amount: "50.00", type: "write_off" }]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "31.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records a partial payment and updates paid amount without marking paid", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        amount: " 30.00 ",
        method: "cash",
        notes: "  cash drawer  ",
      })
    ).resolves.toMatchObject({ amount: "30.00" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
        receivedBy: USER_ID,
        notes: "cash drawer",
        externalId: `dashboard-payment:${PRACTICE_ID}:${OPERATION_ID}`,
      })
    );
    expect(updateSet).toHaveBeenCalledWith({ paidAmount: "50.00" });
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns the original payment for an exact operation retry", async () => {
    const replayPayment = {
      id: "00000000-0000-0000-0000-000000000003",
      invoiceId: INVOICE_ID,
      amount: "30.00",
      method: "cash",
      notes: "cash drawer",
      receivedBy: USER_ID,
      externalId: `dashboard-payment:${PRACTICE_ID}:${OPERATION_ID}`,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [],
      replayPayment,
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        amount: "30.00",
        method: "cash",
        notes: "cash drawer",
      })
    ).resolves.toMatchObject(replayPayment);

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.loadClientReceipt).not.toHaveBeenCalled();
  });

  it("rejects reuse of a payment operation ID with changed details", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [],
      replayPayment: {
        id: "00000000-0000-0000-0000-000000000003",
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
        notes: null,
      },
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        operationId: OPERATION_ID,
        amount: "35.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not insert a payment when the invoice balance changed concurrently", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice]],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledWith({ paidAmount: "50.00" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not insert a payment when adjustment history changed concurrently", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice], [{ amount: "10.00", type: "credit" }]],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).recordPayment({
        invoiceId: INVOICE_ID,
        amount: "30.00",
        method: "cash",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Invoice balance changed while recording payment. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ paidAmount: "50.00" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("marks the invoice paid when payment reaches the balance", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[baseInvoice]],
    });

    await callerWithDb(db).recordPayment({
      invoiceId: INVOICE_ID,
      amount: "80.00",
      method: "credit_card",
    });

    expect(updateSet).toHaveBeenCalledWith({
      paidAmount: "100.00",
      status: "paid",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        amount: "80.00",
        method: "credit_card",
        receivedBy: USER_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "invoice.paid",
      {
        id: INVOICE_ID,
        paymentId: "00000000-0000-0000-0000-000000000003",
        paidAmount: "100.00",
        total: "100.00",
        source: "dashboard",
      }
    );
  });

  it("requires a payment or adjustment to settle an invoice", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[baseInvoice]],
      includeOperationLookup: false,
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({
        id: INVOICE_ID,
        status: "paid",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Record a payment or apply an adjustment to settle this invoice.",
    });

    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("does not void an invoice when history changed concurrently", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ ...baseInvoice, paidAmount: "0.00" }], []],
      includeOperationLookup: false,
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({
        id: INVOICE_ID,
        status: "void",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Invoice status changed while updating. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("validates invoice ownership before listing payments", async () => {
    const { db, select } = createDb({
      selectResults: [[]],
      includeOperationLookup: false,
    });

    await expect(
      callerWithDb(db).listPayments({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(select).toHaveBeenCalledTimes(1);
  });
});
