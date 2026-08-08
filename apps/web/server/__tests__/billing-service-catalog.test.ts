import { readFileSync } from "node:fs";
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
const SERVICE_ID = "00000000-0000-0000-0000-000000000002";
const UPDATED_AT = new Date("2026-08-07T15:00:00.000Z");
const EXPECTED_SERVICE = {
  name: "Exam",
  defaultPrice: "65.00",
};

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  return billingRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: `${role}@example.com`,
        name: "Catalog User",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(
  options: {
    selectResults?: unknown[][];
    updateResults?: unknown[][];
    insertResult?: Record<string, unknown>;
  } = {}
) {
  const selectResults = [...(options.selectResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];

  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => rows),
      limit: vi.fn(async () => rows),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  });

  const insertValues = vi.fn((values: unknown) => ({
    returning: vi.fn(async () =>
      options.insertResult ? [options.insertResult] : []
    ),
    values,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateSet = vi.fn((values: unknown) => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateResults.shift() ?? []),
    })),
    values,
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn(async () => undefined);

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet, execute };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing service catalog", () => {
  it.each(["veterinarian", "technician", "front_desk", "viewer"])(
    "keeps catalog mutations admin-only for %s users",
    async (role) => {
      const { db, select, insertValues, updateSet } = createDb();
      const caller = callerWithDb(db, role);

      await expect(
        caller.createService({
          name: "Wellness exam",
          defaultPrice: "65.00",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(select).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
      expect(updateSet).not.toHaveBeenCalled();
    }
  );

  it("rejects service input bounds before database work", async () => {
    const { db, select, insertValues } = createDb();
    const caller = callerWithDb(db);

    for (const input of [
      { name: " ", defaultPrice: "1.00" },
      { name: "n".repeat(256), defaultPrice: "1.00" },
      { name: "Exam", code: "c".repeat(33), defaultPrice: "1.00" },
      { name: "Exam", category: "c".repeat(129), defaultPrice: "1.00" },
      { name: "Exam", defaultPrice: "-1.00" },
      { name: "Exam", defaultPrice: "1.001" },
      { name: "Exam", defaultPrice: "100000000" },
    ]) {
      await expect(caller.createService(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("normalizes optional text and money before creating a tenant service", async () => {
    const created = {
      id: SERVICE_ID,
      practiceId: PRACTICE_ID,
      name: "Wellness Exam",
      code: null,
      category: null,
      defaultPrice: "65.00",
      updatedAt: UPDATED_AT,
    };
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertResult: created,
    });

    await expect(
      callerWithDb(db).createService({
        name: "  Wellness Exam  ",
        code: "   ",
        category: "   ",
        defaultPrice: "65",
      })
    ).resolves.toEqual(created);

    expect(insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      name: "Wellness Exam",
      code: null,
      category: null,
      defaultPrice: "65.00",
    });
  });

  it("serializes catalog writes and rejects duplicate active names or codes", async () => {
    const { db, insertValues, execute } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: SERVICE_ID }]],
    });

    await expect(
      callerWithDb(db).createService({
        name: "exam",
        code: "EXAM",
        defaultPrice: "65.00",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("name or code"),
    });

    expect(execute).toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("fails closed when the practice is missing", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createService({
        name: "Exam",
        defaultPrice: "65.00",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("lists active and archived catalog rows separately", async () => {
    const active = [{ id: SERVICE_ID, name: "Exam" }];
    const archived = [{ id: SERVICE_ID, name: "Old exam" }];
    const activeDb = createDb({
      selectResults: [[{ id: PRACTICE_ID }], active],
    });
    const archivedDb = createDb({
      selectResults: [[{ id: PRACTICE_ID }], archived],
    });

    await expect(callerWithDb(activeDb.db).listServices()).resolves.toEqual(
      active
    );
    await expect(
      callerWithDb(archivedDb.db).listArchivedServices()
    ).resolves.toEqual(archived);
  });

  it("updates only the browser version of an active service", async () => {
    const updated = {
      id: SERVICE_ID,
      name: "Herd pregnancy check",
      defaultPrice: "18.00",
      updatedAt: new Date("2026-08-07T16:00:00.000Z"),
    };
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updateResults: [[updated]],
    });

    await expect(
      callerWithDb(db).updateService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
        name: " Herd pregnancy check ",
        code: "PREG",
        category: "Herd",
        defaultPrice: "18",
      })
    ).resolves.toEqual(updated);

    expect(updateSet).toHaveBeenCalledWith({
      name: "Herd pregnancy check",
      code: "PREG",
      category: "Herd",
      defaultPrice: "18.00",
    });
  });

  it("returns a conflict when a browser tries to edit a newer service", async () => {
    const { db } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [], [{ id: SERVICE_ID }]],
      updateResults: [[]],
    });

    await expect(
      callerWithDb(db).updateService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
        name: "Exam",
        defaultPrice: "70.00",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not reveal cross-tenant or deleted service IDs", async () => {
    const { db } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [], []],
      updateResults: [[]],
    });

    await expect(
      callerWithDb(db).updateService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
        name: "Exam",
        defaultPrice: "70.00",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("archives and restores only the expected browser version", async () => {
    const archiveDb = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updateResults: [[{ id: SERVICE_ID }]],
    });
    await expect(
      callerWithDb(archiveDb.db).archiveService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
      })
    ).resolves.toEqual({ success: true });
    expect(archiveDb.updateSet).toHaveBeenCalledWith({
      deletedAt: expect.any(Date),
    });

    const restoreDb = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updateResults: [[{ id: SERVICE_ID }]],
    });
    await expect(
      callerWithDb(restoreDb.db).restoreService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
      })
    ).resolves.toEqual({ success: true });
    expect(restoreDb.updateSet).toHaveBeenCalledWith({ deletedAt: null });
  });

  it("does not restore an archived service over a duplicate active identity", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: "active-service" }]],
    });

    await expect(
      callerWithDb(db).restoreService({
        id: SERVICE_ID,
        expected: EXPECTED_SERVICE,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("keeps every catalog query tenant- and lifecycle-scoped", () => {
    const source = readFileSync("server/routers/billing.ts", "utf8");
    const catalogBlock = source.slice(
      source.indexOf("listServices:"),
      source.indexOf("patientsByClient:")
    );

    expect(catalogBlock).toContain("eq(services.practiceId, ctx.practiceId)");
    expect(catalogBlock).toContain("isNull(services.deletedAt)");
    expect(catalogBlock).toContain("isNotNull(services.deletedAt)");
    expect(catalogBlock).toContain(
      "...serviceSnapshotConditions(input.expected)"
    );
    expect(catalogBlock).toContain("lockServiceCatalog");
    expect(catalogBlock).toContain("assertServiceIdentityAvailable");
    expect(catalogBlock).not.toContain("taxable: input.taxable");
  });
});
