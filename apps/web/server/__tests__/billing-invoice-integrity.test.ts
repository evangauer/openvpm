import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000004";
const INVOICE_ID = "00000000-0000-0000-0000-000000000005";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000006";

function callerWithDb(db: Record<string, unknown>, role = "front_desk") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Billing User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return billingRouter.createCaller({ db, session } as never);
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
  invoiceInsert?: Record<string, unknown>;
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

  const invoiceInsert = opts.invoiceInsert ?? {
    id: INVOICE_ID,
    practiceId: PRACTICE_ID,
    clientId: CLIENT_ID,
    isEstimate: false,
  };
  const insertValues = vi.fn((values: unknown) => ({
    returning: vi.fn(async () => [invoiceInsert]),
    values,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[]])];
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

  return { db, select, insertValues, update, updateSet };
}

const productLine = {
  description: "Medication",
  quantity: 2,
  unitPrice: "15.00",
  itemType: "product" as const,
  itemId: PRODUCT_ID,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing invoice integrity", () => {
  it("keeps estimate conversion restricted to billing manager roles", async () => {
    const { db, select, updateSet, insertValues } = createDb({
      selectResults: [],
    });

    await expect(
      callerWithDb(db, "viewer").convertEstimateToInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid line quantities and prices before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [
          {
            ...productLine,
            quantity: 1.5,
          },
        ],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [
          {
            ...productLine,
            unitPrice: "15.123",
          },
        ],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid invoice text, dates, item counts, and totals before DB work", async () => {
    const { db, select, insertValues } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [{ ...productLine, description: " ".repeat(4) }],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [{ ...productLine, description: "d".repeat(501) }],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        dueDate: "2026-02-31",
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: Array.from({ length: 201 }, () => productLine),
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [
          {
            ...productLine,
            quantity: 2,
            unitPrice: "99999999.99",
          },
        ],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invoice creation for a client outside the practice", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a patient that does not belong to the selected client", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects an appointment that does not belong to the selected client and patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [{ id: PATIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Appointment not found for this client and patient.",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("stores a verified appointment link and prevents a duplicate active visit invoice", async () => {
    const first = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ id: PRODUCT_ID }],
        [{ taxRatePercent: "0.00" }],
        [],
      ],
      invoiceInsert: { id: INVOICE_ID, isEstimate: false },
      updateReturns: [[{ id: PRODUCT_ID, stockQuantity: 8 }]],
    });

    await callerWithDb(first.db).createInvoice({
      clientId: CLIENT_ID,
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
      items: [productLine],
      isEstimate: false,
    });

    expect(first.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
      })
    );

    const duplicate = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ id: PRODUCT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: INVOICE_ID }],
      ],
    });

    await expect(
      callerWithDb(duplicate.db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "This visit already has an active invoice. Open it instead of creating a duplicate.",
    });

    expect(duplicate.db.execute).toHaveBeenCalled();
    expect(duplicate.updateSet).not.toHaveBeenCalled();
    expect(duplicate.insertValues).not.toHaveBeenCalled();
  });

  it("rejects product line references outside the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("deducts product stock when creating a real invoice", async () => {
    const { db, insertValues, update } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PRODUCT_ID }],
        [{ taxRatePercent: "0.00" }],
      ],
      invoiceInsert: { id: INVOICE_ID, isEstimate: false },
      updateReturns: [[{ id: PRODUCT_ID, stockQuantity: 8 }]],
    });

    await callerWithDb(db).createInvoice({
      clientId: CLIENT_ID,
      items: [
        {
          ...productLine,
          description: "  Medication  ",
          unitPrice: " 15.00 ",
        },
      ],
      dueDate: "2026-07-15",
      isEstimate: false,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        subtotal: "30.00",
        total: "30.00",
        dueDate: "2026-07-15",
        isEstimate: false,
      })
    );
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        description: "Medication",
        itemType: "product",
        itemId: PRODUCT_ID,
        quantity: 2,
        unitPrice: "15.00",
        total: "30.00",
      }),
    ]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("rejects invoice creation before inventory or invoice writes when the practice is inactive", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [{ id: PRODUCT_ID }], []],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects real invoice creation when product stock is insufficient", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PRODUCT_ID }],
        [{ taxRatePercent: "0.00" }],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("deducts product stock when converting an estimate to an invoice", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "draft",
            isEstimate: true,
          },
        ],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [
        [{ id: INVOICE_ID, isEstimate: false }],
        [{ id: PRODUCT_ID, stockQuantity: 8 }],
      ],
    });

    await expect(
      callerWithDb(db).convertEstimateToInvoice({ id: INVOICE_ID })
    ).resolves.toMatchObject({ isEstimate: false });

    expect(updateSet).toHaveBeenCalledWith({ isEstimate: false });
    expect(updateSet).toHaveBeenCalledTimes(2);
  });

  it("rejects void estimate conversion before inventory changes", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "void",
            isEstimate: true,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).convertEstimateToInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot convert a void estimate.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale estimate conversion before inventory changes", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "draft",
            isEstimate: true,
          },
        ],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).convertEstimateToInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ isEstimate: false });
  });

  it("rejects conversion when product stock is insufficient", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "draft",
            isEstimate: true,
          },
        ],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [[{ id: INVOICE_ID, isEstimate: false }], []],
    });

    await expect(
      callerWithDb(db).convertEstimateToInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledWith({ isEstimate: false });
    expect(updateSet).toHaveBeenCalledTimes(2);
  });

  it("restores product stock when voiding a real invoice through status updates", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
          },
        ],
        [],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [
        [{ id: INVOICE_ID, status: "void", isEstimate: false }],
        [{ id: PRODUCT_ID, stockQuantity: 12 }],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({ id: INVOICE_ID, status: "void" })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).toHaveBeenNthCalledWith(1, { status: "void" });
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      stockQuantity: expect.anything(),
    });
  });

  it("does not restore stock when a void status update is repeated", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "void",
            isEstimate: false,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({ id: INVOICE_ID, status: "void" })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not restore stock when voiding an estimate", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: true,
          },
        ],
        [],
      ],
      updateReturns: [[{ id: INVOICE_ID, status: "void", isEstimate: true }]],
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({ id: INVOICE_ID, status: "void" })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
  });

  it("restores product stock when using the dedicated void endpoint", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
          },
        ],
        [],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [
        [{ id: INVOICE_ID, status: "void", isEstimate: false }],
        [{ id: PRODUCT_ID, stockQuantity: 12 }],
      ],
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).toHaveBeenNthCalledWith(1, { status: "void" });
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      stockQuantity: expect.anything(),
    });
  });

  it("does not restore product stock when dedicated void is repeated", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "void",
            isEstimate: false,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not restore product stock when voiding loses the status race", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
          },
        ],
        [],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).voidInvoice({ id: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
  });
});
