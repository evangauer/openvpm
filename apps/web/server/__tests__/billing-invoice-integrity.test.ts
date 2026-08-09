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
const SERVICE_ID = "00000000-0000-0000-0000-000000000007";
const PRESCRIPTION_ID = "00000000-0000-0000-0000-000000000008";
const DISPENSE_CHARGE_ID = "00000000-0000-0000-0000-000000000009";
const UPDATED_AT = new Date("2026-08-08T12:00:00.000Z");

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
  executeResults?: unknown[];
}) {
  const selectResults = [...opts.selectResults];
  let transactionDepth = 0;
  let writeCount = 0;
  const lockCalls: Array<{
    mode: string;
    inTransaction: boolean;
    writesBeforeLock: number;
  }> = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      ...thenableRows(result),
      limit: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => afterWhere),
      for: vi.fn(async (mode: string) => {
        lockCalls.push({
          mode,
          inTransaction: transactionDepth > 0,
          writesBeforeLock: writeCount,
        });
        return result;
      }),
    };
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

  const invoiceInsert = opts.invoiceInsert ?? {
    id: INVOICE_ID,
    practiceId: PRACTICE_ID,
    clientId: CLIENT_ID,
    isEstimate: false,
  };
  const insertValues = vi.fn((values: unknown) => {
    writeCount += 1;
    return {
      returning: vi.fn(async () => [invoiceInsert]),
      values,
    };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts.updateReturns ?? [[]])];
  const updateSet = vi.fn(() => {
    writeCount += 1;
    return {
      where: vi.fn(() => ({
        returning: vi.fn(async () => updateReturns.shift() ?? []),
      })),
    };
  });
  const update = vi.fn(() => ({ set: updateSet }));

  const executeResults = [...(opts.executeResults ?? [])];
  const execute = vi.fn(async () => executeResults.shift());
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => {
      transactionDepth += 1;
      try {
        return await fn(db);
      } finally {
        transactionDepth -= 1;
      }
    },
    execute,
    select,
    insert,
    update,
  };

  return { db, select, insertValues, update, updateSet, lockCalls, execute };
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
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [],
        [{ id: PRODUCT_ID, deletedAt: null }],
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
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
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

  it("rechecks and locks the visit before creating a real invoice", async () => {
    const { db, insertValues, lockCalls } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "checked_out" }],
      ],
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
      code: "PRECONDITION_FAILED",
      message: "Start the exam before capturing visit charges.",
    });
    expect(lockCalls).toEqual([
      { mode: "update", inTransaction: true, writesBeforeLock: 0 },
    ]);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects product line references outside the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [],
      ],
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
        [{ taxRatePercent: "0.00" }],
        [{ id: PRODUCT_ID, deletedAt: null }],
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

  it("locks referenced catalog rows inside the invoice transaction before writes", async () => {
    const { db, lockCalls } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: SERVICE_ID, deletedAt: null }],
        [{ id: PRODUCT_ID, deletedAt: null }],
      ],
      invoiceInsert: { id: INVOICE_ID, isEstimate: false },
      updateReturns: [[{ id: PRODUCT_ID, stockQuantity: 8 }]],
    });

    await callerWithDb(db).createInvoice({
      clientId: CLIENT_ID,
      items: [
        {
          description: "Wellness exam",
          quantity: 1,
          unitPrice: "50.00",
          itemType: "service",
          itemId: SERVICE_ID,
        },
        productLine,
      ],
      isEstimate: false,
    });

    expect(lockCalls).toEqual([
      { mode: "share", inTransaction: true, writesBeforeLock: 0 },
      { mode: "update", inTransaction: true, writesBeforeLock: 0 },
    ]);
  });

  it("rejects invoice creation before inventory or invoice writes when the practice is inactive", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], []],
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
        [{ taxRatePercent: "0.00" }],
        [{ id: PRODUCT_ID, deletedAt: null }],
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

  it("replaces unpaid draft lines and reconciles inventory atomically", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ taxRatePercent: "10.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "draft",
            isEstimate: false,
            updatedAt: UPDATED_AT,
            appointmentId: null,
            patientId: PATIENT_ID,
          },
        ],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 1 }],
        [{ id: PRODUCT_ID, deletedAt: null }],
      ],
      updateReturns: [
        [{ id: PRODUCT_ID, stockQuantity: 9 }],
        [{ id: PRODUCT_ID, stockQuantity: 6 }],
        [
          {
            id: INVOICE_ID,
            subtotal: "45.00",
            tax: "4.50",
            total: "49.50",
            status: "draft",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [{ ...productLine, quantity: 3 }],
      })
    ).resolves.toMatchObject({
      id: INVOICE_ID,
      subtotal: "45.00",
      tax: "4.50",
      total: "49.50",
    });

    expect(db.execute).toHaveBeenCalled();
    expect(updateSet).toHaveBeenNthCalledWith(1, {
      stockQuantity: expect.anything(),
    });
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      stockQuantity: expect.anything(),
    });
    expect(updateSet).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        subtotal: "45.00",
        tax: "4.50",
        total: "49.50",
      })
    );
    expect(updateSet).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        deletedAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        itemType: "product",
        itemId: PRODUCT_ID,
        quantity: 3,
        unitPrice: "15.00",
        total: "45.00",
      }),
    ]);
  });

  it("does not remove invoice lines already confirmed against performed work", async () => {
    const { db, updateSet, insertValues, execute } = createDb({
      selectResults: [
        [{ taxRatePercent: "0.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "draft",
            isEstimate: false,
            updatedAt: UPDATED_AT,
            appointmentId: APPOINTMENT_ID,
            patientId: PATIENT_ID,
          },
        ],
      ],
      executeResults: [[], [], { rows: [{ id: "visit-work-item" }] }],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [productLine],
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("confirmed against performed work"),
    });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("allows an unchanged archived service reference already on the draft", async () => {
    const archivedAt = new Date("2026-08-01T00:00:00.000Z");
    const { db, insertValues, lockCalls } = createDb({
      selectResults: [
        [{ taxRatePercent: "0.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "draft",
            isEstimate: false,
            updatedAt: UPDATED_AT,
            appointmentId: null,
            patientId: PATIENT_ID,
          },
        ],
        [{ itemType: "service", itemId: SERVICE_ID, quantity: 2 }],
        [{ id: SERVICE_ID, deletedAt: archivedAt }],
      ],
      updateReturns: [
        [
          {
            id: INVOICE_ID,
            subtotal: "80.00",
            tax: "0.00",
            total: "80.00",
            status: "draft",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [
          {
            description: "Archived exam",
            quantity: 2,
            unitPrice: "40.00",
            itemType: "service",
            itemId: SERVICE_ID,
          },
        ],
      })
    ).resolves.toMatchObject({ id: INVOICE_ID, total: "80.00" });

    expect(lockCalls).toEqual([
      { mode: "share", inTransaction: true, writesBeforeLock: 0 },
    ]);
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        itemType: "service",
        itemId: SERVICE_ID,
        quantity: 2,
      }),
    ]);
  });

  it.each([
    { scenario: "newly adds", previousQuantity: 0, incomingQuantity: 1 },
    { scenario: "increases", previousQuantity: 1, incomingQuantity: 2 },
  ])(
    "rejects a draft edit that $scenario an archived service reference",
    async ({ previousQuantity, incomingQuantity }) => {
      const { db, insertValues, updateSet, lockCalls } = createDb({
        selectResults: [
          [{ taxRatePercent: "0.00" }],
          [
            {
              id: INVOICE_ID,
              paidAmount: "0.00",
              status: "draft",
              isEstimate: false,
              updatedAt: UPDATED_AT,
              appointmentId: null,
              patientId: PATIENT_ID,
            },
          ],
          previousQuantity === 0
            ? []
            : [
                {
                  itemType: "service",
                  itemId: SERVICE_ID,
                  quantity: previousQuantity,
                },
              ],
          [{ id: SERVICE_ID, deletedAt: new Date("2026-08-01") }],
        ],
      });

      await expect(
        callerWithDb(db).updateInvoiceItems({
          id: INVOICE_ID,
          expectedUpdatedAt: UPDATED_AT,
          items: [
            {
              description: "Archived exam",
              quantity: incomingQuantity,
              unitPrice: "40.00",
              itemType: "service",
              itemId: SERVICE_ID,
            },
          ],
        })
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "One or more services were not found",
      });

      expect(lockCalls).toEqual([
        { mode: "share", inTransaction: true, writesBeforeLock: 0 },
      ]);
      expect(updateSet).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    }
  );

  it("rejects an archived product reference before inventory or invoice writes", async () => {
    const { db, insertValues, updateSet, lockCalls } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: PRODUCT_ID, deletedAt: new Date("2026-08-01") }],
      ],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        items: [productLine],
        isEstimate: false,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "One or more products were not found",
    });

    expect(lockCalls).toEqual([
      { mode: "update", inTransaction: true, writesBeforeLock: 0 },
    ]);
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("charges a visit prescription without deducting already-dispensed stock twice", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [],
        [{ id: PRODUCT_ID, deletedAt: null }],
        [{ id: PRESCRIPTION_ID, productId: PRODUCT_ID, quantity: 2 }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        items: [
          {
            ...productLine,
            sourcePrescriptionId: PRESCRIPTION_ID,
          },
        ],
        isEstimate: false,
      })
    ).resolves.toMatchObject({ id: INVOICE_ID });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenLastCalledWith([
      expect.objectContaining({
        itemId: PRODUCT_ID,
        sourcePrescriptionId: PRESCRIPTION_ID,
        quantity: 2,
      }),
    ]);
  });

  it("charges a dispense-time snapshot without deducting stock and resolves visit work", async () => {
    const description = "Cerenia 24mg — Cerenia";
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [],
        [{ id: PRODUCT_ID, deletedAt: null }],
        [],
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            appointmentId: APPOINTMENT_ID,
            productId: PRODUCT_ID,
            quantity: 2,
            descriptionSnapshot: description,
            unitPriceSnapshot: "15.00",
            status: "pending",
            invoiceId: null,
          },
        ],
      ],
      updateReturns: [
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            appointmentId: APPOINTMENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        items: [
          {
            description,
            quantity: 2,
            unitPrice: "15.00",
            itemType: "product",
            itemId: PRODUCT_ID,
            sourceDispenseChargeId: DISPENSE_CHARGE_ID,
          },
        ],
        isEstimate: false,
      }),
    ).resolves.toMatchObject({ id: INVOICE_ID });

    expect(insertValues).toHaveBeenLastCalledWith([
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        itemId: PRODUCT_ID,
        sourceDispenseChargeId: DISPENSE_CHARGE_ID,
        quantity: 2,
        unitPrice: "15.00",
      }),
    ]);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "invoiced",
        invoiceId: INVOICE_ID,
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "charged",
        invoiceId: INVOICE_ID,
      }),
    );
    expect(updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ stockQuantity: expect.anything() }),
    );
  });

  it("rejects client-tampered dispense quantity, price, or description", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: PRODUCT_ID, deletedAt: null }],
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            appointmentId: null,
            productId: PRODUCT_ID,
            quantity: 2,
            descriptionSnapshot: "Cerenia 24mg — Cerenia",
            unitPriceSnapshot: "15.00",
            status: "pending",
            invoiceId: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        items: [
          {
            ...productLine,
            description: "Tampered medication",
            sourceDispenseChargeId: DISPENSE_CHARGE_ID,
          },
        ],
        isEstimate: false,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires the invoice to preserve the dispense appointment exactly", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: PRODUCT_ID, deletedAt: null }],
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            appointmentId: APPOINTMENT_ID,
            productId: PRODUCT_ID,
            quantity: 2,
            descriptionSnapshot: "Cerenia 24mg — Cerenia",
            unitPriceSnapshot: "15.00",
            status: "pending",
            invoiceId: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).createInvoice({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        items: [
          {
            description: "Cerenia 24mg — Cerenia",
            quantity: 2,
            unitPrice: "15.00",
            itemType: "product",
            itemId: PRODUCT_ID,
            sourceDispenseChargeId: DISPENSE_CHARGE_ID,
          },
        ],
        isEstimate: false,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates an appointment-linked draft from pending dispense work", async () => {
    const description = "Cerenia 24mg — Cerenia";
    const source = {
      id: DISPENSE_CHARGE_ID,
      prescriptionId: PRESCRIPTION_ID,
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
      appointmentId: APPOINTMENT_ID,
      productId: PRODUCT_ID,
      quantity: 2,
      descriptionSnapshot: description,
      unitPriceSnapshot: "15.00",
      status: "pending",
      invoiceId: null,
      legacyReview: false,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [source],
        [{ taxRatePercent: "0.00" }],
        [],
      ],
      updateReturns: [
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            appointmentId: APPOINTMENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).createDispenseChargeInvoice({
        id: DISPENSE_CHARGE_ID,
        acknowledgeLegacyReview: false,
      }),
    ).resolves.toEqual({ invoiceId: INVOICE_ID, replayed: false });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: APPOINTMENT_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        sourceDispenseChargeId: DISPENSE_CHARGE_ID,
      }),
    );
    expect(updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ stockQuantity: expect.anything() }),
    );
  });

  it("adds pending visit dispense work to the existing editable draft", async () => {
    const description = "Cerenia 24mg — Cerenia";
    const source = {
      id: DISPENSE_CHARGE_ID,
      prescriptionId: PRESCRIPTION_ID,
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
      appointmentId: APPOINTMENT_ID,
      productId: PRODUCT_ID,
      quantity: 2,
      descriptionSnapshot: description,
      unitPriceSnapshot: "15.00",
      status: "pending",
      invoiceId: null,
      legacyReview: false,
    };
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [source],
        [{ taxRatePercent: "10.00" }],
        [
          {
            id: INVOICE_ID,
            clientId: CLIENT_ID,
            patientId: PATIENT_ID,
            status: "draft",
            subtotal: "50.00",
            paidAmount: "0.00",
          },
        ],
      ],
      updateReturns: [
        [{ id: INVOICE_ID }],
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            appointmentId: APPOINTMENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).createDispenseChargeInvoice({
        id: DISPENSE_CHARGE_ID,
        acknowledgeLegacyReview: false,
      }),
    ).resolves.toEqual({ invoiceId: INVOICE_ID, replayed: false });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        subtotal: "80.00",
        tax: "8.00",
        total: "88.00",
      }),
    );
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        sourceDispenseChargeId: DISPENSE_CHARGE_ID,
      }),
    );
  });

  it("waives appointment-linked dispense and visit work as one decision", async () => {
    const pendingCharge = {
      id: DISPENSE_CHARGE_ID,
      prescriptionId: PRESCRIPTION_ID,
      appointmentId: APPOINTMENT_ID,
      status: "pending",
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [pendingCharge],
        [
          {
            id: "00000000-0000-0000-0000-00000000000a",
            status: "unresolved",
          },
        ],
      ],
      updateReturns: [
        [{ id: "00000000-0000-0000-0000-00000000000a" }],
        [{ id: DISPENSE_CHARGE_ID }],
      ],
    });

    await expect(
      callerWithDb(db, "admin").waiveDispenseCharge({
        id: DISPENSE_CHARGE_ID,
        reason: "Manufacturer replacement supplied",
      }),
    ).resolves.toEqual({ id: DISPENSE_CHARGE_ID });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "no_charge",
        noChargeReason: "Manufacturer replacement supplied",
        resolvedBy: USER_ID,
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "waived",
        resolutionReason: "Manufacturer replacement supplied",
        resolvedBy: USER_ID,
      }),
    );
  });

  it("reopens appointment-linked waiver and visit work as one correction", async () => {
    const waiverReason = "Manufacturer replacement supplied";
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ appointmentId: APPOINTMENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [
          {
            id: DISPENSE_CHARGE_ID,
            prescriptionId: PRESCRIPTION_ID,
            appointmentId: APPOINTMENT_ID,
            status: "waived",
            resolutionReason: waiverReason,
          },
        ],
        [],
        [
          {
            id: "00000000-0000-0000-0000-00000000000a",
            status: "no_charge",
            invoiceId: null,
            invoiceItemId: null,
            noChargeReason: waiverReason,
            voidReason: null,
            resolvedBy: USER_ID,
            resolvedAt: UPDATED_AT,
          },
        ],
      ],
      updateReturns: [
        [{ id: "00000000-0000-0000-0000-00000000000a" }],
        [{ id: DISPENSE_CHARGE_ID }],
      ],
    });

    await expect(
      callerWithDb(db, "admin").reopenDispenseCharge({
        id: DISPENSE_CHARGE_ID,
      }),
    ).resolves.toEqual({ id: DISPENSE_CHARGE_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reopened",
        entityType: "visit_work_item",
        changes: expect.objectContaining({ priorStatus: "no_charge" }),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unresolved",
        noChargeReason: null,
        resolvedBy: null,
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        resolutionReason: null,
        resolvedBy: null,
      }),
    );
  });

  it("rejects an unsourced charge for a product already dispensed by the visit prescription", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID }],
        [{ taxRatePercent: "0.00" }],
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [],
        [{ id: PRODUCT_ID, deletedAt: null }],
        [{ id: PRESCRIPTION_ID, productId: PRODUCT_ID, quantity: 2 }],
      ],
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
      code: "PRECONDITION_FAILED",
      message:
        "Charge a visit-dispensed medication from its prescription entry so stock is not deducted twice.",
    });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not edit a sent invoice or touch its inventory", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ taxRatePercent: "0.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
            updatedAt: UPDATED_AT,
            appointmentId: null,
            patientId: PATIENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [productLine],
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Only an unpaid draft invoice can have its line items changed.",
    });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("keeps estimate editing out of the visit-invoice mutation", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ taxRatePercent: "0.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "draft",
            isEstimate: true,
            updatedAt: UPDATED_AT,
            appointmentId: null,
            patientId: PATIENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [
          {
            description: "Exam",
            quantity: 1,
            unitPrice: "45.00",
            itemType: "service",
          },
        ],
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Convert or replace the estimate before editing visit invoice charges.",
    });

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("fails a stale draft edit before replacing line items", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ taxRatePercent: "0.00" }],
        [
          {
            id: INVOICE_ID,
            paidAmount: "0.00",
            status: "draft",
            isEstimate: false,
            updatedAt: UPDATED_AT,
            appointmentId: null,
            patientId: PATIENT_ID,
          },
        ],
        [],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).updateInvoiceItems({
        id: INVOICE_ID,
        expectedUpdatedAt: UPDATED_AT,
        items: [
          {
            description: "Exam",
            quantity: 1,
            unitPrice: "45.00",
            itemType: "service",
          },
        ],
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Invoice state changed while saving charges. Refresh and try again.",
    });

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

  it("rejects voiding through the generic status endpoint", async () => {
    const { db, select, updateSet } = createDb({ selectResults: [] });

    await expect(
      callerWithDb(db).updateInvoiceStatus({
        id: INVOICE_ID,
        status: "void",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires reconciled visit work before sending an invoice", async () => {
    const visitInvoice = {
      id: INVOICE_ID,
      total: "30.00",
      paidAmount: "0.00",
      status: "draft",
      isEstimate: false,
      appointmentId: APPOINTMENT_ID,
    };
    const { db, execute, updateSet } = createDb({
      selectResults: [
        [visitInvoice],
        [{ id: APPOINTMENT_ID }],
        [{ status: "clinical_finalized" }],
      ],
      executeResults: Array.from({ length: 6 }, () => [
        { id: "unresolved-work" },
      ]),
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({
        id: INVOICE_ID,
        status: "sent",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Resolve every performed vaccination, lab, procedure, and prescription before sending or collecting this visit invoice.",
    });
    expect(execute).toHaveBeenCalledTimes(6);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("sends a clinically finalized visit invoice after reconciliation", async () => {
    const visitInvoice = {
      id: INVOICE_ID,
      total: "30.00",
      paidAmount: "0.00",
      status: "draft",
      isEstimate: false,
      appointmentId: APPOINTMENT_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [visitInvoice],
        [{ id: APPOINTMENT_ID }],
        [{ status: "clinical_finalized" }],
      ],
      executeResults: [[], [], [], [], [], []],
      updateReturns: [[{ ...visitInvoice, status: "sent" }]],
    });

    await expect(
      callerWithDb(db).updateInvoiceStatus({
        id: INVOICE_ID,
        status: "sent",
      })
    ).resolves.toMatchObject({ status: "sent" });
    expect(updateSet).toHaveBeenCalledWith({ status: "sent" });
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
        [],
        [],
        [{ itemType: "product", itemId: PRODUCT_ID, quantity: 2 }],
      ],
      updateReturns: [
        [{ id: INVOICE_ID, status: "void", isEstimate: false }],
        [{ id: PRODUCT_ID, stockQuantity: 12 }],
      ],
    });

    await expect(
      callerWithDb(db).voidInvoice({
        id: INVOICE_ID,
        reason: "Duplicate invoice",
      })
    ).resolves.toMatchObject({ status: "void" });

    expect(updateSet).toHaveBeenNthCalledWith(1, { status: "void" });
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      stockQuantity: expect.anything(),
    });
  });

  it("atomically reopens charged visit work and audits a dedicated void", async () => {
    const workItemId = "00000000-0000-0000-0000-00000000000b";
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
            appointmentId: APPOINTMENT_ID,
          },
        ],
        [{ id: APPOINTMENT_ID }],
        [],
        [],
        [{ id: workItemId }],
        [],
      ],
      executeResults: [[]],
      updateReturns: [[{ id: INVOICE_ID, status: "void", isEstimate: false }]],
    });

    await callerWithDb(db).voidInvoice({
      id: INVOICE_ID,
      reason: "Duplicate invoice",
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unresolved",
        invoiceId: null,
        invoiceItemId: null,
        resolvedBy: null,
        resolvedAt: null,
      })
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "invoice_voided",
        entityType: "invoice",
        entityId: INVOICE_ID,
        changes: expect.objectContaining({
          reason: "Duplicate invoice",
          priorStatus: "sent",
          nextStatus: "void",
          reopenedVisitWorkItemIds: [workItemId],
        }),
      })
    );
  });

  it("does not void an invoice referenced by a completed visit closeout", async () => {
    const { db, updateSet, lockCalls } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "30.00",
            paidAmount: "0.00",
            status: "sent",
            isEstimate: false,
            appointmentId: APPOINTMENT_ID,
          },
        ],
        [{ id: APPOINTMENT_ID }],
        [{ id: "closeout" }],
      ],
    });

    await expect(
      callerWithDb(db).voidInvoice({
        id: INVOICE_ID,
        reason: "Duplicate invoice",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "This invoice is part of a completed visit. Reconcile it through an attributed closeout amendment.",
    });
    expect(lockCalls).toEqual([
      { mode: "update", inTransaction: true, writesBeforeLock: 0 },
    ]);
    expect(updateSet).not.toHaveBeenCalled();
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
      callerWithDb(db).voidInvoice({
        id: INVOICE_ID,
        reason: "Duplicate invoice",
      })
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
      callerWithDb(db).voidInvoice({
        id: INVOICE_ID,
        reason: "Duplicate invoice",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ status: "void" });
  });
});
