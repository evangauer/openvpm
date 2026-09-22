import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { billingRouter } = await import("../routers/billing");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId: PRACTICE_ID,
    },
  };
  return billingRouter.createCaller({ db, session } as never);
}

function createDb() {
  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute: vi.fn(async () => undefined),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  return db;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing list input validation", () => {
  it("returns the authenticated practice identity with billing config", async () => {
    const result = [
      {
        practiceName: "Harbor Veterinary Clinic",
        taxRatePercent: "8.75",
        currency: "cad",
        country: "CA",
        timezone: "America/Toronto",
      },
    ];
    const afterWhere = { limit: vi.fn(async () => result) };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    const db = createDb();
    db.select = vi.fn(() => builder);

    await expect(callerWithDb(db).getTaxConfig()).resolves.toEqual({
      practiceName: "Harbor Veterinary Clinic",
      taxRatePercent: "8.75",
      currency: "cad",
      country: "CA",
      timezone: "America/Toronto",
    });
  });

  it("rejects billing tax config reads when the practice is inactive", async () => {
    const result: unknown[] = [];
    const afterWhere = { limit: vi.fn(async () => result) };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    const db = createDb();
    db.select = vi.fn(() => builder);

    await expect(callerWithDb(db).getTaxConfig()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("rejects invalid invoice filters before DB work", async () => {
    const db = createDb();
    const caller = callerWithDb(db);

    await expect(
      caller.listInvoices({
        status: "lost",
        limit: 25,
        offset: 0,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.listInvoices({
        appointmentId: "not-an-appointment-id",
        limit: 25,
        offset: 0,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.listInvoices({
        limit: 1.5,
        offset: 0,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.listInvoices({
        limit: 25,
        offset: 0.5,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.listInvoices({
        limit: 25,
        offset: LIST_OFFSET_MAX + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects fractional product list limits before DB work", async () => {
    const db = createDb();

    await expect(
      callerWithDb(db).listProducts({ limit: 1.5 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects overlong product searches before DB work", async () => {
    const db = createDb();

    await expect(
      callerWithDb(db).listProducts({
        search: "x".repeat(121),
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("charge product search pagination", () => {
  it.each([-1, 0.5])("rejects invalid cursor %s", async (cursor) => {
    const db = createDb();
    await expect(
      callerWithDb(db).searchProducts({ cursor, limit: 50 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3])(
    "returns bounded pages and a continuation only when more rows exist (%s rows)",
    async (count) => {
      const rows = Array.from({ length: count }, (_, n) => ({
        id: String(n),
        name: `Product ${n}`,
      }));
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        offset: vi.fn(async () => rows),
      };
      const db = createDb();
      db.select = vi.fn(() => builder);
      const result = await callerWithDb(db).searchProducts({
        search: "Product",
        limit: 2,
        cursor: 100,
      });
      expect(result.items).toEqual(rows.slice(0, 2));
      expect(result.nextCursor).toBe(count > 2 ? 102 : undefined);
      expect(builder.limit).toHaveBeenCalledWith(3);
      expect(builder.offset).toHaveBeenCalledWith(100);
      expect(builder.orderBy.mock.calls[0]).toHaveLength(2);
    },
  );
});
