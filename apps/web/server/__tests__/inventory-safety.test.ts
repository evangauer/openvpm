import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { inventoryRouter } = await import("../routers/inventory");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");
const { POSTGRES_INTEGER_MAX } = await import("../routers/storage-bounds");
const {
  INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH,
  INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH,
  INVENTORY_PRODUCT_NAME_MAX_LENGTH,
  INVENTORY_PRODUCT_SEARCH_MAX_LENGTH,
  INVENTORY_PRODUCT_SKU_MAX_LENGTH,
  INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH,
  INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH,
  INVENTORY_SUPPLIER_NAME_MAX_LENGTH,
  INVENTORY_SUPPLIER_NOTES_MAX_LENGTH,
  INVENTORY_SUPPLIER_PHONE_MAX_LENGTH,
} = await import("@/lib/inventory/policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000002";
const SUPPLIER_ID = "00000000-0000-0000-0000-000000000003";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Inventory",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return inventoryRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
      offset: vi.fn(() => builder),
    };
    return builder;
  });

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertedRows = [...(opts?.insertedRows ?? [])];
  const insertReturning = vi.fn(async () => {
    const row = insertedRows.shift();
    return row ? [row] : [];
  });
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

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

describe("inventory mutation safety", () => {
  it("keeps inventory writes restricted to non-viewer staff roles", async () => {
    const { db, select, insertValues, updateSet } = createDb();
    const viewer = callerWithDb(db, "viewer");

    await expect(
      viewer.create({
        name: "Carprofen",
        unitPrice: "12.50",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.update({
        id: PRODUCT_ID,
        name: "Carprofen 25mg",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.adjustStock({
        id: PRODUCT_ID,
        adjustment: 1,
        reason: "Cycle count",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.createSupplier({
        name: "Acme Veterinary Supply",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.updateSupplier({
        id: SUPPLIER_ID,
        name: "Acme Veterinary Supply",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();

    const { db: writableDb } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: PRODUCT_ID, name: "Carprofen" }],
    });

    await expect(
      callerWithDb(writableDb, "front_desk").create({
        name: "Carprofen",
        unitPrice: "12.50",
      })
    ).resolves.toMatchObject({ id: PRODUCT_ID });
  });

  it("uses the practice timezone for inventory expiration alert cutoffs", () => {
    const source = readFileSync("server/routers/inventory.ts", "utf8");

    expect(source).toContain("async function practiceTimeZone");
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("${practices.deletedAt} is null");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain(
      "const todayYmd = formatDateInputForTimeZone(\n        new Date(),\n        await practiceTimeZone(ctx)\n      )"
    );
    expect(source).toContain("const soonYmd = addDaysYmd(todayYmd, 90)");
    expect(source).toContain("inventoryAlert(p, todayYmd)");
    expect(source).not.toContain("const todayYmd = ymdFromDate(today)");
  });

  it("persists explicit product taxability inside the tenant-scoped catalog", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: PRODUCT_ID, taxable: false }],
      updatedRows: [{ id: PRODUCT_ID, taxable: true }],
    });
    const caller = callerWithDb(db);

    await caller.create({
      name: "Tax-exempt medication",
      unitPrice: "12.50",
      taxable: false,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        taxable: false,
      }),
    );

    await caller.update({ id: PRODUCT_ID, taxable: true });
    expect(updateSet).toHaveBeenCalledWith({ taxable: true });
  });

  it("requires an active practice for inventory product and supplier access", () => {
    const source = readFileSync("server/routers/inventory.ts", "utf8");

    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(6);
    expect(source).toContain("await assertActivePractice(ctx)");
    expect(source).toMatch(
      /eq\(products\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(products\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(suppliers\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(suppliers\.deletedAt\)/
    );
  });

  it("rejects invalid product list pagination before DB work", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).list({
        limit: 1.5,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        limit: 25,
        offset: LIST_OFFSET_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
  });

  it("rejects invalid product list filters before DB work", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).list({
        search: "A".repeat(INVENTORY_PRODUCT_SEARCH_MAX_LENGTH + 1),
        limit: 25,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        category: "A".repeat(INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH + 1),
        limit: 25,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
  });

  it("rejects product list requests when the practice is missing or deleted", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).list({
        limit: 25,
        offset: 0,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("rejects invalid product price and expiration inputs before DB work", async () => {
    const { db, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.345",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.50",
        expirationDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        costPrice: "100000000",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        expirationDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.50",
        stockQuantity: POSTGRES_INTEGER_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        reorderPoint: POSTGRES_INTEGER_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid product and supplier text before DB work", async () => {
    const { db, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        name: "A".repeat(INVENTORY_PRODUCT_NAME_MAX_LENGTH + 1),
        unitPrice: "12.50",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.50",
        sku: "A".repeat(INVENTORY_PRODUCT_SKU_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        category: "A".repeat(INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSupplier({
        name: "A".repeat(INVENTORY_SUPPLIER_NAME_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSupplier({
        name: "Acme",
        contactEmail: "A".repeat(INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSupplier({
        name: "Acme",
        phone: "1".repeat(INVENTORY_SUPPLIER_PHONE_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSupplier({
        name: "Acme",
        address: "A".repeat(INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSupplier({
        name: "Acme",
        notes: "A".repeat(INVENTORY_SUPPLIER_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateSupplier({
        id: SUPPLIER_ID,
        name: " ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateSupplier({
        id: SUPPLIER_ID,
        contactEmail: "not-email",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateSupplier({
        id: SUPPLIER_ID,
        notes: "A".repeat(INVENTORY_SUPPLIER_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("creates a product after validating price and expiration inputs", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: PRODUCT_ID, name: "Carprofen" }],
    });

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.50",
        costPrice: "8.25",
        expirationDate: "2027-01-31",
      })
    ).resolves.toMatchObject({ id: PRODUCT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        name: "Carprofen",
        unitPrice: "12.50",
        costPrice: "8.25",
        expirationDate: "2027-01-31",
      })
    );
  });

  it("rejects product creation before insert when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).create({
        name: "Carprofen",
        unitPrice: "12.50",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("trims product and supplier text before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PRACTICE_ID }]],
      insertedRows: [
        { id: PRODUCT_ID, name: "Carprofen" },
        { id: SUPPLIER_ID, name: "Acme", contactEmail: "orders@example.com" },
      ],
    });

    await expect(
      callerWithDb(db).create({
        name: " Carprofen ",
        sku: " RX-12 ",
        category: " Medication ",
        unitPrice: "12.50",
        lotNumber: " LOT-1 ",
      })
    ).resolves.toMatchObject({ id: PRODUCT_ID });

    await expect(
      callerWithDb(db).createSupplier({
        name: " Acme ",
        contactEmail: " ORDERS@EXAMPLE.COM ",
        phone: " 555-0100 ",
        address: " 100 Supply St ",
        notes: " Preferred vendor ",
      })
    ).resolves.toMatchObject({ id: SUPPLIER_ID });

    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: "Carprofen",
        sku: "RX-12",
        category: "Medication",
        lotNumber: "LOT-1",
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: "Acme",
        contactEmail: "orders@example.com",
        phone: "555-0100",
        address: "100 Supply St",
        notes: "Preferred vendor",
      })
    );
  });

  it("rejects supplier creation before insert when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createSupplier({
        name: "Acme Veterinary Supply",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects supplier list requests when the practice is missing or deleted", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(callerWithDb(db).listSuppliers()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("updates supplier contact details after validating and normalizing input", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [
        {
          id: SUPPLIER_ID,
          name: "Acme",
          contactEmail: "orders@example.com",
        },
      ],
    });

    await expect(
      callerWithDb(db).updateSupplier({
        id: SUPPLIER_ID,
        name: " Acme ",
        contactEmail: " ORDERS@EXAMPLE.COM ",
        phone: null,
        address: " 100 Supply St ",
        notes: " Preferred vendor ",
      })
    ).resolves.toMatchObject({
      id: SUPPLIER_ID,
      contactEmail: "orders@example.com",
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Acme",
        contactEmail: "orders@example.com",
        phone: null,
        address: "100 Supply St",
        notes: "Preferred vendor",
      })
    );
  });

  it("rejects no-op and stale supplier updates", async () => {
    const noop = createDb();

    await expect(
      callerWithDb(noop.db).updateSupplier({
        id: SUPPLIER_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(noop.updateSet).not.toHaveBeenCalled();

    const stale = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(stale.db).updateSupplier({
        id: SUPPLIER_ID,
        name: "Acme",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(stale.updateSet).toHaveBeenCalledWith({ name: "Acme" });
  });

  it("rejects product updates with no fields", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).update({ id: PRODUCT_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects direct stock quantity updates through product metadata updates", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        stockQuantity: 99,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects direct stock quantity fields mixed into product metadata updates", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        name: "Flea prevention",
        stockQuantity: 99,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale or cross-tenant product updates", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).update({
        id: PRODUCT_ID,
        name: "Flea prevention",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ name: "Flea prevention" });
  });

  it("requires a tenant-owned product before adjusting stock", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: 5,
        reason: "Cycle count",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid stock adjustment input before DB work", async () => {
    const { db, select, updateSet } = createDb();

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: 1.5,
        reason: "Correction",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: 1,
        reason: "A".repeat(INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stock adjustments that would make quantity negative", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRODUCT_ID, stockQuantity: 2 }]],
    });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: -3,
        reason: "Correction",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stock adjustments that would exceed integer storage", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRODUCT_ID, stockQuantity: POSTGRES_INTEGER_MAX }]],
    });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: 1,
        reason: "Correction",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stock adjustments that lose the race to another writer", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRODUCT_ID, stockQuantity: 2 }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: -2,
        reason: "Dispensed",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        stockQuantity: expect.anything(),
      })
    );
  });

  it("adjusts stock for a tenant-owned product", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRODUCT_ID, stockQuantity: 10 }]],
      updatedRows: [{ id: PRODUCT_ID, stockQuantity: 7 }],
    });

    await expect(
      callerWithDb(db).adjustStock({
        id: PRODUCT_ID,
        adjustment: -3,
        reason: "Dispensed",
      })
    ).resolves.toMatchObject({ id: PRODUCT_ID, stockQuantity: 7 });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        stockQuantity: expect.anything(),
      })
    );
  });
});
