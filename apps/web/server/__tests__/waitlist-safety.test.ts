import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { waitlistRouter } = await import("../routers/waitlist");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const TYPE_ID = "00000000-0000-0000-0000-000000000004";
const WAITLIST_ID = "00000000-0000-0000-0000-000000000005";

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
  return waitlistRouter.createCaller({ db, session } as never);
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
      orderBy: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () =>
    opts?.insertedRows ?? [{ id: WAITLIST_ID, clientId: CLIENT_ID }]
  );
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
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

describe("waitlist add safety", () => {
  it("rejects invalid preferred and slot dates before querying", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        preferredFrom: "2026-02-30",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        notes: "n".repeat(1001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).matchesForSlot({
        date: "2026-02-30",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects an inverted preferred date window before querying", async () => {
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        preferredFrom: "2026-07-10",
        preferredTo: "2026-07-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned client before adding an entry", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).add({ clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires an optional patient to belong to the selected client and practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires an optional appointment type to belong to the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        typeId: TYPE_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("adds a waitlist entry after validating all selected targets", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [{ id: TYPE_ID }],
      ],
    });

    await expect(
      callerWithDb(db).add({
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredFrom: "2026-07-01",
        preferredTo: "2026-07-10",
        notes: " Call if anything opens before noon. ",
      })
    ).resolves.toMatchObject({ id: WAITLIST_ID, clientId: CLIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredFrom: "2026-07-01",
        preferredTo: "2026-07-10",
        notes: "Call if anything opens before noon.",
        createdBy: USER_ID,
      })
    );
  });

  it("rejects list, add, and slot matching when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], []],
    });

    await expect(callerWithDb(db).list()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(callerWithDb(db).add({ clientId: CLIENT_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).matchesForSlot({ date: "2026-07-10" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("waitlist status safety", () => {
  it("rejects missing or cross-tenant status updates before writing", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).setStatus({
        id: WAITLIST_ID,
        status: "scheduled",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects reopening resolved waitlist entries before writing", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: WAITLIST_ID, status: "scheduled" }]],
    });

    await expect(
      callerWithDb(db).setStatus({
        id: WAITLIST_ID,
        status: "waiting",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change waitlist status from scheduled to waiting.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("updates waiting entries to a resolved status", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: WAITLIST_ID, status: "waiting" }]],
      updatedRows: [{ id: WAITLIST_ID, status: "scheduled" }],
    });

    await expect(
      callerWithDb(db).setStatus({
        id: WAITLIST_ID,
        status: "scheduled",
      })
    ).resolves.toMatchObject({ id: WAITLIST_ID, status: "scheduled" });

    expect(updateSet).toHaveBeenCalledWith({ status: "scheduled" });
  });

  it("rejects status updates that lose a concurrent race", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: WAITLIST_ID, status: "waiting" }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).setStatus({
        id: WAITLIST_ID,
        status: "scheduled",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Waitlist status changed. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "scheduled" });
  });
});

describe("waitlist display join scoping", () => {
  const source = readFileSync(
    new URL("../routers/waitlist.ts", import.meta.url),
    "utf8"
  );

  it("fails closed when the active practice row is missing", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(10);
    expect(source).toContain("await assertActivePractice(ctx.db, ctx.practiceId)");
  });

  it("keeps joined client, patient, and type display rows tenant scoped and active", () => {
    for (const [table, foreignKey] of [
      ["clients", "appointmentWaitlist.clientId"],
      ["appointmentTypes", "appointmentWaitlist.typeId"],
    ]) {
      const joins = source.match(
        new RegExp(
          `leftJoin\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
            ".",
            "\\."
          )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, ctx\\.practiceId\\),\\s*activePracticePredicate\\(ctx\\.practiceId\\),\\s*isNull\\(${table}\\.deletedAt\\)\\s*\\)\\s*\\)`,
          "gs"
        )
      );
      expect(joins?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps displayed patients tied to the waitlist client", () => {
    const joins = source.match(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(appointmentWaitlist\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointmentWaitlist\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/gs
    );

    expect(joins?.length).toBeGreaterThanOrEqual(2);
  });

  it("claims the observed waitlist status before resolving entries", () => {
    expect(source).toContain("canTransitionWaitlistStatus");
    expect(source).toContain("eq(appointmentWaitlist.status, current.status)");
    expect(source).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(appointmentWaitlist\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointmentWaitlist\.practiceId, ctx\.practiceId\),\s*eq\(appointmentWaitlist\.status, current\.status\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(appointmentWaitlist\.deletedAt\)/
    );
    expect(source).toContain("Waitlist status changed. Refresh and try again.");
  });
});
