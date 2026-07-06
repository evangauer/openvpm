import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { treatmentPlansRouter } = await import("../routers/treatment-plans");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const PROBLEM_ID = "00000000-0000-0000-0000-000000000003";
const PLAN_ID = "00000000-0000-0000-0000-000000000004";
const ITEM_ID = "00000000-0000-0000-0000-000000000005";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "doctor@example.com",
      name: "Doctor",
      role: "veterinarian",
      practiceId: PRACTICE_ID,
    },
  };
  return treatmentPlansRouter.createCaller({ db, session } as never);
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

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const db: Record<string, unknown> = {
    transaction,
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet, transaction };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("treatment plan target safety", () => {
  it("requires a tenant-owned patient before creating a plan", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires optional problems to belong to the selected patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PATIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        problemId: PROBLEM_ID,
        title: "Dental plan",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid treatment plan dates before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        startDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        startDate: "2026-06-27",
        endDate: "2026-06-26",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid treatment plan text and item counts before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: " ".repeat(4),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        description: "d".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        items: [{ description: "i".repeat(501) }],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        items: [
          {
            description: "Pre-op bloodwork",
            instructions: "i".repeat(2001),
          },
        ],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
        items: Array.from({ length: 101 }, () => ({
          description: "Treatment item",
        })),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a plan with items after validating the patient and problem", async () => {
    const { db, insertValues, transaction } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PATIENT_ID }],
        [{ id: PROBLEM_ID }],
      ],
      insertedRows: [{ id: PLAN_ID, patientId: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        problemId: PROBLEM_ID,
        title: "  Dental plan  ",
        description: "  Stage care over two visits  ",
        startDate: "2026-06-27",
        endDate: "2026-07-15",
        items: [
          {
            description: "  Pre-op bloodwork  ",
            instructions: "  Fast overnight  ",
          },
        ],
      })
    ).resolves.toMatchObject({ id: PLAN_ID, patientId: PATIENT_ID });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        problemId: PROBLEM_ID,
        title: "Dental plan",
        description: "Stage care over two visits",
        startDate: "2026-06-27",
        endDate: "2026-07-15",
        createdBy: USER_ID,
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({
        planId: PLAN_ID,
        description: "Pre-op bloodwork",
        instructions: "Fast overnight",
      }),
    ]);
  });

  it("rejects list and create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], []],
    });

    await expect(
      callerWithDb(db).listByPatient({ patientId: PATIENT_ID })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        title: "Dental plan",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale or cross-tenant plan status updates before writing", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateStatus({
        id: PLAN_ID,
        status: "completed",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("updates plan status by claiming the observed lifecycle state", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PLAN_ID, status: "active" }]],
      updatedRows: [{ id: PLAN_ID, status: "completed" }],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: PLAN_ID,
        status: "completed",
      })
    ).resolves.toMatchObject({ id: PLAN_ID, status: "completed" });

    expect(updateSet).toHaveBeenCalledWith({ status: "completed" });
  });

  it("rejects plan status updates that lose a concurrent race", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PLAN_ID, status: "active" }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: PLAN_ID,
        status: "completed",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Treatment plan status changed. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "completed" });
  });

  it("requires item status updates to belong to a tenant plan", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateItemStatus({
        itemId: ITEM_ID,
        status: "done",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects item status updates for completed or discontinued plans", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ planId: PLAN_ID, planStatus: "completed", itemStatus: "pending" }],
      ],
    });

    await expect(
      callerWithDb(db).updateItemStatus({
        itemId: ITEM_ID,
        status: "done",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only active treatment plans can be updated.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects item status updates when state changes after validation", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ planId: PLAN_ID, planStatus: "active", itemStatus: "pending" }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateItemStatus({
        itemId: ITEM_ID,
        status: "done",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Treatment plan item changed. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "done" });
  });

  it("updates item status while the tenant plan remains active", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ planId: PLAN_ID, planStatus: "active", itemStatus: "pending" }],
      ],
      updatedRows: [{ id: ITEM_ID, status: "done" }],
    });

    await expect(
      callerWithDb(db).updateItemStatus({
        itemId: ITEM_ID,
        status: "done",
      })
    ).resolves.toMatchObject({ id: ITEM_ID, status: "done" });

    expect(updateSet).toHaveBeenCalledWith({ status: "done" });
  });
});

describe("treatment plan item join scoping", () => {
  const source = readFileSync(
    new URL("../routers/treatment-plans.ts", import.meta.url),
    "utf8"
  );

  it("validates item status updates through active tenant plan joins", () => {
    expect(source).toMatch(
      /innerJoin\(\s*treatmentPlans,\s*and\(\s*eq\(treatmentPlanItems\.planId, treatmentPlans\.id\),\s*eq\(treatmentPlans\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(treatmentPlans\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toContain("activeTreatmentPlanScope(ctx, row.planId)");
    expect(source).toContain("eq(treatmentPlanItems.planId, row.planId)");
    expect(source).toContain("eq(treatmentPlanItems.status, row.itemStatus)");
    expect(source).toContain("Only active treatment plans can be updated.");
  });

  it("requires an active practice for treatment plan reads and writes", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("await assertActivePractice(ctx)");
    expect(source).toContain("from ${practices}");
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(7);
    expect(source).toMatch(
      /eq\(treatmentPlans\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(treatmentPlans\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(problemList\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(problemList\.deletedAt\)/
    );
  });
});
