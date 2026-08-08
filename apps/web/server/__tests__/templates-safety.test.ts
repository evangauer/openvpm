import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { templatesRouter } = await import("../routers/templates");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const TEMPLATE_ID = "00000000-0000-0000-0000-000000000002";
const ITEM_ID = "00000000-0000-0000-0000-000000000003";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000004";
const SERVICE_ID = "00000000-0000-0000-0000-000000000005";
const INVOICE_ID = "00000000-0000-0000-0000-000000000006";
const SECOND_SERVICE_ID = "00000000-0000-0000-0000-000000000007";
const SECOND_PRODUCT_ID = "00000000-0000-0000-0000-000000000008";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return templatesRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
  updateResults?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const lockFor = vi.fn(() => afterWhereForCurrentSelect);
  let afterWhereForCurrentSelect: {
    limit: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    for: ReturnType<typeof vi.fn>;
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown
    ) => Promise<unknown>;
  };
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(() => afterWhere),
      for: lockFor,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    afterWhereForCurrentSelect = afterWhere;
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateResults = [...(opts?.updateResults ?? [])];
  const updateReturning = vi.fn(async () =>
    updateResults.length > 0 ? updateResults.shift() : (opts?.updatedRows ?? [])
  );
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    transaction,
    execute,
    select,
    insert,
    update,
  };

  return {
    db,
    select,
    insertValues,
    updateSet,
    transaction,
    lockFor,
    execute,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("treatment template safety", () => {
  it("rejects invalid template item prices before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        name: "Dental package",
        items: [
          {
            itemType: "service",
            description: "Exam",
            defaultQuantity: 1,
            defaultUnitPrice: "75.123",
            sortOrder: 0,
          },
        ],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        description: "Exam",
        defaultQuantity: 1,
        defaultUnitPrice: "100000000",
        sortOrder: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid template text, quantities, totals, and item counts before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        name: " ".repeat(4),
        items: [],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Dental package",
        description: "d".repeat(2001),
        items: [],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Dental package",
        category: "c".repeat(129),
        items: [],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Dental package",
        items: Array.from({ length: 201 }, () => ({
          itemType: "service" as const,
          description: "Exam",
          defaultQuantity: 1,
          defaultUnitPrice: "75.00",
          sortOrder: 0,
        })),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        description: "Exam",
        defaultQuantity: 2,
        defaultUnitPrice: "99999999.99",
        sortOrder: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        description: "Exam",
        defaultQuantity: 1,
        defaultUnitPrice: "75.00",
        sortOrder: 10001,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: TEMPLATE_ID,
        name: " ".repeat(4),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it(
    "requires referenced product items to belong to the practice before creating a template",
    async () => {
      const { db, insertValues } = createDb({
        selectResults: [[{ id: PRACTICE_ID }], []],
      });

      await expect(
        callerWithDb(db).create({
          name: "Dental package",
          items: [
            {
              itemType: "product",
              itemId: PRODUCT_ID,
              description: "Dental chews",
              defaultQuantity: 1,
              defaultUnitPrice: "12.00",
              sortOrder: 0,
            },
          ],
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(insertValues).not.toHaveBeenCalled();
    }
  );

  it("creates a template after validating referenced catalog items", async () => {
    const { db, insertValues, transaction } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PRODUCT_ID }]],
      insertedRows: [{ id: TEMPLATE_ID, name: "Dental package" }],
    });

    await expect(
      callerWithDb(db).create({
        name: "  Dental package  ",
        description: "  Common oral-health estimate  ",
        category: "  Dentistry  ",
        items: [
          {
            itemType: "product",
            itemId: PRODUCT_ID,
            description: "  Dental chews  ",
            defaultQuantity: 1,
            defaultUnitPrice: " 12.00 ",
            sortOrder: 0,
          },
        ],
      })
    ).resolves.toMatchObject({ id: TEMPLATE_ID });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        name: "Dental package",
        description: "Common oral-health estimate",
        category: "Dentistry",
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        itemType: "product",
        itemId: PRODUCT_ID,
        description: "Dental chews",
        defaultUnitPrice: "12.00",
      }),
    ]);
  });

  it("trims added template item text and money before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [{ id: SERVICE_ID }],
      ],
      insertedRows: [{ id: ITEM_ID, templateId: TEMPLATE_ID }],
    });

    await expect(
      callerWithDb(db).addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        itemId: SERVICE_ID,
        description: "  Exam  ",
        defaultQuantity: 1,
        defaultUnitPrice: " 75.00 ",
        sortOrder: 1,
      })
    ).resolves.toMatchObject({ id: ITEM_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: TEMPLATE_ID,
        itemType: "service",
        itemId: SERVICE_ID,
        description: "Exam",
        defaultUnitPrice: "75.00",
      })
    );
  });

  it("requires referenced items to belong to the practice before adding an item", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: TEMPLATE_ID }], []],
    });

    await expect(
      callerWithDb(db).addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        itemId: SERVICE_ID,
        description: "Exam",
        defaultQuantity: 1,
        defaultUnitPrice: "75.00",
        sortOrder: 0,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires removed items to belong to an active tenant template", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).removeItem({ id: ITEM_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects template item removal when the item disappears after validation", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ itemId: ITEM_ID, practiceId: PRACTICE_ID }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).removeItem({ id: ITEM_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });

  it("applies a template to a tenant invoice and recalculates active items", async () => {
    const { db, insertValues, updateSet, lockFor, execute } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
        [
          {
            description: "Exam",
            defaultQuantity: 2,
            defaultUnitPrice: "75.00",
            itemType: "service",
            itemId: SERVICE_ID,
          },
        ],
        [{ id: SERVICE_ID }],
        [{ quantity: 2, unitPrice: "75.00" }],
        [{ taxRatePercent: "10.00" }],
      ],
      updatedRows: [
        {
          id: INVOICE_ID,
          subtotal: "150.00",
          tax: "15.00",
          total: "165.00",
        },
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).resolves.toMatchObject({
      id: INVOICE_ID,
      total: "165.00",
    });

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        description: "Exam",
        total: "150.00",
      }),
    ]);
    expect(updateSet).toHaveBeenCalledWith({
      subtotal: "150.00",
      tax: "15.00",
      total: "165.00",
    });
    expect(lockFor).toHaveBeenCalledTimes(1);
    expect(lockFor).toHaveBeenCalledWith("share");
    expect(execute).toHaveBeenCalled();
  });

  it("batch-locks unique service and product references before inserting", async () => {
    const templateItems = [
      {
        description: "Exam",
        defaultQuantity: 1,
        defaultUnitPrice: "60.00",
        itemType: "service" as const,
        itemId: SERVICE_ID,
      },
      {
        description: "Recheck",
        defaultQuantity: 1,
        defaultUnitPrice: "40.00",
        itemType: "service" as const,
        itemId: SECOND_SERVICE_ID,
      },
      {
        description: "Exam follow-up",
        defaultQuantity: 1,
        defaultUnitPrice: "60.00",
        itemType: "service" as const,
        itemId: SERVICE_ID,
      },
      {
        description: "Medication",
        defaultQuantity: 1,
        defaultUnitPrice: "10.00",
        itemType: "product" as const,
        itemId: PRODUCT_ID,
      },
      {
        description: "Supplement",
        defaultQuantity: 1,
        defaultUnitPrice: "15.00",
        itemType: "product" as const,
        itemId: SECOND_PRODUCT_ID,
      },
    ];
    const { db, select, insertValues, lockFor } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: true,
          },
        ],
        templateItems,
        [{ id: SERVICE_ID }, { id: SECOND_SERVICE_ID }],
        [{ id: PRODUCT_ID }, { id: SECOND_PRODUCT_ID }],
        templateItems.map((item) => ({
          quantity: item.defaultQuantity,
          unitPrice: item.defaultUnitPrice,
        })),
        [{ taxRatePercent: "0.00" }],
      ],
      updatedRows: [
        {
          id: INVOICE_ID,
          subtotal: "185.00",
          tax: "0.00",
          total: "185.00",
        },
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).resolves.toMatchObject({ id: INVOICE_ID, total: "185.00" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ itemId: SERVICE_ID }),
        expect.objectContaining({ itemId: SECOND_SERVICE_ID }),
        expect.objectContaining({ itemId: PRODUCT_ID }),
        expect.objectContaining({ itemId: SECOND_PRODUCT_ID }),
      ])
    );
    expect(lockFor).toHaveBeenCalledTimes(2);
    expect(lockFor).toHaveBeenNthCalledWith(1, "share");
    expect(lockFor).toHaveBeenNthCalledWith(2, "share");
    // Four request setup/read queries + two catalog batches + totals + tax.
    expect(select).toHaveBeenCalledTimes(8);
  });

  it("deducts product stock when applying a template to a real invoice", async () => {
    const { db, insertValues, updateSet, lockFor } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
        [
          {
            description: "Dental chews",
            defaultQuantity: 3,
            defaultUnitPrice: "12.00",
            itemType: "product",
            itemId: PRODUCT_ID,
          },
        ],
        [{ id: PRODUCT_ID }],
        [{ quantity: 3, unitPrice: "12.00" }],
        [{ taxRatePercent: "0.00" }],
      ],
      updateResults: [
        [{ id: PRODUCT_ID, stockQuantity: 7 }],
        [{ id: INVOICE_ID, subtotal: "36.00", tax: "0.00", total: "36.00" }],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).resolves.toMatchObject({
      id: INVOICE_ID,
      total: "36.00",
    });

    expect(updateSet).toHaveBeenNthCalledWith(1, {
      stockQuantity: expect.anything(),
    });
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        itemType: "product",
        itemId: PRODUCT_ID,
        quantity: 3,
      }),
    ]);
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      subtotal: "36.00",
      tax: "0.00",
      total: "36.00",
    });
    expect(lockFor).toHaveBeenCalledWith("update");
  });

  it("does not deduct product stock when applying a template to an estimate", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: true,
          },
        ],
        [
          {
            description: "Dental chews",
            defaultQuantity: 3,
            defaultUnitPrice: "12.00",
            itemType: "product",
            itemId: PRODUCT_ID,
          },
        ],
        [{ id: PRODUCT_ID }],
        [{ quantity: 3, unitPrice: "12.00" }],
        [{ taxRatePercent: "0.00" }],
      ],
      updatedRows: [
        { id: INVOICE_ID, subtotal: "36.00", tax: "0.00", total: "36.00" },
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).resolves.toMatchObject({ id: INVOICE_ID });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({
      subtotal: "36.00",
      tax: "0.00",
      total: "36.00",
    });
  });

  it("rejects template application before inserting items when product stock is insufficient", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
        [
          {
            description: "Dental chews",
            defaultQuantity: 3,
            defaultUnitPrice: "12.00",
            itemType: "product",
            itemId: PRODUCT_ID,
          },
        ],
        [{ id: PRODUCT_ID }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledWith({
      stockQuantity: expect.anything(),
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects template application after an invoice has been sent", async () => {
    const { db, insertValues, updateSet, transaction } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "sent",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects template application when an invoice already has payments", async () => {
    const { db, insertValues, updateSet, transaction } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "10.00",
            isEstimate: false,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects template application when template item totals exceed currency limits", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
        [
          {
            description: "Exam",
            defaultQuantity: 2,
            defaultUnitPrice: "99999999.99",
            itemType: "service",
            itemId: SERVICE_ID,
          },
        ],
        [{ id: SERVICE_ID }],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects a template that still references an archived service", async () => {
    const { db, insertValues, updateSet, lockFor } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: false,
          },
        ],
        [
          {
            description: "Archived exam",
            defaultQuantity: 1,
            defaultUnitPrice: "75.00",
            itemType: "service",
            itemId: SERVICE_ID,
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Service not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(lockFor).toHaveBeenCalledTimes(1);
    expect(lockFor).toHaveBeenCalledWith("share");
  });

  it("rejects product references that are not active in the tenant", async () => {
    const { db, insertValues, updateSet, lockFor } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: TEMPLATE_ID }],
        [
          {
            id: INVOICE_ID,
            status: "draft",
            paidAmount: "0.00",
            isEstimate: true,
          },
        ],
        [
          {
            description: "Other-clinic product",
            defaultQuantity: 1,
            defaultUnitPrice: "12.00",
            itemType: "product",
            itemId: PRODUCT_ID,
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Product not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(lockFor).toHaveBeenCalledTimes(1);
    expect(lockFor).toHaveBeenCalledWith("share");
  });

  it("keeps batched catalog locks active, tenant-scoped, and deterministic", () => {
    const source = readFileSync("server/routers/templates.ts", "utf8");
    const block = source.slice(
      source.indexOf("async function lockActiveTemplateCatalogItems"),
      source.indexOf("async function deductTemplateProductStock")
    );

    expect(block).toContain("inArray(services.id, serviceIds)");
    expect(block).toContain("eq(services.practiceId, ctx.practiceId)");
    expect(block).toContain("isNull(services.deletedAt)");
    expect(block).toContain(".orderBy(asc(services.id))");
    expect(block).toContain("inArray(products.id, productIds)");
    expect(block).toContain("eq(products.practiceId, ctx.practiceId)");
    expect(block).toContain("isNull(products.deletedAt)");
    expect(block).toContain(".orderBy(asc(products.id))");
    expect(block).toContain('.for("share")');
    expect(block).toContain('lockProductsForStock ? "update" : "share"');
    const applyBlock = source.slice(source.indexOf("applyToInvoice:"));
    expect(applyBlock).toContain("pg_advisory_xact_lock");
    expect(applyBlock).toContain("hashtextextended(${input.invoiceId}, 0)");
  });

  it("rejects template reads and writes when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], [], [], [], [], [], []],
    });
    const caller = callerWithDb(db);

    await expect(caller.list()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.getById({ id: TEMPLATE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.create({ name: "Dental package", items: [] })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.update({ id: TEMPLATE_ID, name: "Dental package" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.delete({ id: TEMPLATE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.addItem({
        templateId: TEMPLATE_ID,
        itemType: "service",
        description: "Exam",
        defaultQuantity: 1,
        defaultUnitPrice: "75.00",
        sortOrder: 0,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.removeItem({ id: ITEM_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.applyToInvoice({
        templateId: TEMPLATE_ID,
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("uses the checked practice row when recalculating template invoice tax", () => {
    const source = readFileSync("server/routers/templates.ts", "utf8");

    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain('parseFloat(practice.taxRatePercent ?? "8.00")');
    expect(source).not.toContain("practice?.taxRatePercent");
  });
});
