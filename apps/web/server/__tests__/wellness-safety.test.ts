import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { WELLNESS_INVOICE_BATCH_MAX_TARGETS, wellnessRouter } = await import(
  "../routers/wellness"
);

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PLAN_ID = "00000000-0000-0000-0000-000000000002";
const CLIENT_ID = "00000000-0000-0000-0000-000000000003";
const PATIENT_ID = "00000000-0000-0000-0000-000000000004";
const ENROLLMENT_ID = "00000000-0000-0000-0000-000000000005";

function callerWithDb(db: Record<string, unknown>, role = "front_desk") {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return wellnessRouter.createCaller({ db, session } as never);
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
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () =>
    opts?.insertedRows ?? [{ id: ENROLLMENT_ID, planId: PLAN_ID, clientId: CLIENT_ID }]
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("wellness plan safety", () => {
  it("rejects invalid plan text, prices, and dates before DB work", async () => {
    const { db, select, insertValues } = createDb();
    const adminCaller = callerWithDb(db, "admin");

    await expect(
      adminCaller.createPlan({
        name: " ".repeat(4),
        price: 25,
        billingInterval: "monthly",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      adminCaller.createPlan({
        name: "Puppy Wellness",
        description: "d".repeat(2001),
        price: 25,
        billingInterval: "monthly",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      adminCaller.createPlan({
        name: "Puppy Wellness",
        price: 25.123,
        billingInterval: "monthly",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      adminCaller.createPlan({
        name: "Puppy Wellness",
        price: 100000000,
        billingInterval: "monthly",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
        startDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).listDue({ asOf: "2026-02-31" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).generateDueInvoices({ asOf: "2026-02-31" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).generateDueInvoices({
        enrollmentIds: Array.from(
          { length: WELLNESS_INVOICE_BATCH_MAX_TARGETS + 1 },
          () => ENROLLMENT_ID
        ),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("trims plan text and formats validated prices before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: PLAN_ID, name: "Puppy Wellness" }],
    });

    await expect(
      callerWithDb(db, "admin").createPlan({
        name: "  Puppy Wellness  ",
        description: "  Vaccines and routine care  ",
        price: 25.5,
        billingInterval: "monthly",
      })
    ).resolves.toMatchObject({ id: PLAN_ID, name: "Puppy Wellness" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        name: "Puppy Wellness",
        description: "Vaccines and routine care",
        price: "25.50",
        billingInterval: "monthly",
      })
    );
  });

  it("rejects plan reads and writes when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], []],
    });
    const adminCaller = callerWithDb(db, "admin");

    await expect(callerWithDb(db).listPlans()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      adminCaller.createPlan({
        name: "Puppy Wellness",
        price: 25,
        billingInterval: "monthly",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      adminCaller.setPlanActive({
        planId: PLAN_ID,
        active: true,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("lets admins deactivate a tenant-owned plan when no active enrollments remain", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
      updatedRows: [{ id: PLAN_ID, active: false }],
    });

    await expect(
      callerWithDb(db, "admin").setPlanActive({
        planId: PLAN_ID,
        active: false,
      })
    ).resolves.toMatchObject({ id: PLAN_ID, active: false });

    expect(updateSet).toHaveBeenCalledWith({ active: false });
  });

  it("blocks deactivating plans that still have active enrollments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: ENROLLMENT_ID }]],
    });

    await expect(
      callerWithDb(db, "admin").setPlanActive({
        planId: PLAN_ID,
        active: false,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Cancel or migrate active enrollments before deactivating this wellness plan.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("reactivates tenant-owned wellness plans without requiring enrollment checks", async () => {
    const { db, select, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updatedRows: [{ id: PLAN_ID, active: true }],
    });

    await expect(
      callerWithDb(db, "admin").setPlanActive({
        planId: PLAN_ID,
        active: true,
      })
    ).resolves.toMatchObject({ id: PLAN_ID, active: true });

    expect(select).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ active: true });
  });

  it("requires admin role before changing wellness plan availability", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db, "front_desk").setPlanActive({
        planId: PLAN_ID,
        active: false,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("wellness enrollment safety", () => {
  it("restricts wellness membership management to billing roles", async () => {
    const { db, select, insertValues, updateSet } = createDb();
    const viewer = callerWithDb(db, "viewer");

    await expect(
      viewer.enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.listDue({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(viewer.generateDueInvoices({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      viewer.markBilled({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.cancel({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires an active tenant-owned plan before enrolling", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned client before enrolling", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PLAN_ID }], []],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires an optional patient to belong to the selected client and practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PLAN_ID }],
        [{ id: CLIENT_ID }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("enrolls after validating the selected plan, client, and patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PLAN_ID }],
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        startDate: "2026-07-01",
      })
    ).resolves.toMatchObject({ id: ENROLLMENT_ID, clientId: CLIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        planId: PLAN_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        startDate: "2026-07-01",
        nextBillingDate: "2026-07-01",
      })
    );
  });

  it("defaults enrollment billing dates from the practice timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PLAN_ID }],
        [{ id: CLIENT_ID }],
        [],
        [{ timezone: "America/Los_Angeles" }],
      ],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toMatchObject({ id: ENROLLMENT_ID, clientId: CLIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        planId: PLAN_ID,
        clientId: CLIENT_ID,
        startDate: "2026-07-14",
        nextBillingDate: "2026-07-14",
      })
    );
  });

  it("rejects duplicate active enrollments for the same plan target", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PLAN_ID }],
        [{ id: CLIENT_ID }],
        [{ id: ENROLLMENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("advances only active, tenant-owned enrollments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [
          {
            id: ENROLLMENT_ID,
            nextBillingDate: "2026-07-31",
            interval: "monthly",
          },
        ],
      ],
      updatedRows: [{ id: ENROLLMENT_ID, nextBillingDate: "2026-08-31" }],
    });

    await expect(
      callerWithDb(db).markBilled({ enrollmentId: ENROLLMENT_ID })
    ).resolves.toMatchObject({ id: ENROLLMENT_ID, nextBillingDate: "2026-08-31" });

    expect(updateSet).toHaveBeenCalledWith({ nextBillingDate: "2026-08-31" });
  });

  it("rejects manual billing advances that lose the race to another update", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [
          {
            id: ENROLLMENT_ID,
            nextBillingDate: "2026-07-31",
            interval: "monthly",
          },
        ],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).markBilled({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Enrollment changed while billing. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ nextBillingDate: "2026-08-31" });
  });

  it("rejects stale, cancelled, deleted, or cross-tenant enrollments when billing", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).markBilled({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("cancels only active tenant-owned enrollments", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updatedRows: [{ id: ENROLLMENT_ID, status: "cancelled" }],
    });

    await expect(
      callerWithDb(db).cancel({ enrollmentId: ENROLLMENT_ID })
    ).resolves.toMatchObject({ id: ENROLLMENT_ID, status: "cancelled" });

    expect(updateSet).toHaveBeenCalledWith({
      status: "cancelled",
      cancelledAt: expect.any(Date),
    });
  });

  it("does not rewrite stale or already-cancelled enrollment cancellations", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).cancel({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Enrollment not found",
    });

    expect(updateSet).toHaveBeenCalledWith({
      status: "cancelled",
      cancelledAt: expect.any(Date),
    });
  });

  it("rejects enrollment billing flows when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], [], [], [], []],
    });
    const caller = callerWithDb(db);

    await expect(
      caller.enroll({
        planId: PLAN_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.listDue({ asOf: "2026-07-01" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.generateDueInvoices({ asOf: "2026-07-01" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.markBilled({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.cancel({ enrollmentId: ENROLLMENT_ID })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("keeps due membership lists scoped to billable tenant-owned rows", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");
    const listDueBlock = source.slice(
      source.indexOf("listDue:"),
      source.indexOf("generateDueInvoices:")
    );

    expect(listDueBlock).toContain("asOf: wellnessDateInput.optional()");
    expect(listDueBlock).toContain(
      "input?.asOf ?? (await practiceDateInput(ctx.db, ctx.practiceId))"
    );
    expect(listDueBlock).toContain("eq(wellnessPlans.practiceId, ctx.practiceId)");
    expect(listDueBlock).toContain("eq(wellnessPlans.active, true)");
    expect(listDueBlock).toContain("isNull(wellnessPlans.deletedAt)");
    expect(listDueBlock).toContain("eq(clients.practiceId, ctx.practiceId)");
    expect(listDueBlock).toContain("isNull(clients.deletedAt)");
    expect(listDueBlock).toContain(
      "eq(patients.clientId, wellnessEnrollments.clientId)"
    );
    expect(listDueBlock).toContain("eq(patients.practiceId, ctx.practiceId)");
    expect(listDueBlock).toContain("isNull(patients.deletedAt)");
  });

  it("uses the practice timezone helper for omitted wellness billing dates", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");
    const generateDueBlock = source.slice(
      source.indexOf("generateDueInvoices:"),
      source.indexOf("markBilled:")
    );

    expect(source).toContain("async function practiceTimeZone");
    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain("return practice.timezone ?? null");
    expect(source).not.toContain("practice?.timezone");
    expect(source).toContain("async function practiceDateInput");
    expect(source).toContain(
      "await practiceTimeZone(db, practiceId)"
    );
    expect(source).toContain(
      "input.startDate ?? (await practiceDateInput(ctx.db, ctx.practiceId))"
    );
    expect(generateDueBlock).toContain(
      "input?.asOf ?? (await practiceDateInput(ctx.db, ctx.practiceId))"
    );
    expect(source).not.toContain("const today = () => new Date().toISOString()");
  });

  it("claims the observed billing date before manually advancing it", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");
    const markBilledBlock = source.slice(
      source.indexOf("markBilled:"),
      source.indexOf("cancel:")
    );

    expect(markBilledBlock).toContain(
      "eq(wellnessEnrollments.nextBillingDate, row.nextBillingDate)"
    );
    expect(markBilledBlock).toContain(
      "Enrollment changed while billing. Refresh and try again."
    );
  });

  it("claims active enrollment state before cancelling memberships", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");
    const cancelBlock = source.slice(source.indexOf("cancel:"));

    expect(cancelBlock).toContain(
      'eq(wellnessEnrollments.status, "active")'
    );
    expect(cancelBlock).toContain("cancelledAt: new Date()");
  });

  it("keeps enrollment lists scoped to tenant-owned rows", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");
    const listEnrollmentsBlock = source.slice(
      source.indexOf("listEnrollments:"),
      source.indexOf("generateDueInvoices:")
    );

    expect(listEnrollmentsBlock).toContain(
      "eq(wellnessEnrollments.practiceId, ctx.practiceId)"
    );
    expect(listEnrollmentsBlock).toContain("isNull(wellnessEnrollments.deletedAt)");
    expect(listEnrollmentsBlock).toContain(
      "eq(wellnessPlans.practiceId, ctx.practiceId)"
    );
    expect(listEnrollmentsBlock).toContain("isNull(wellnessPlans.deletedAt)");
    expect(listEnrollmentsBlock).toContain("eq(clients.practiceId, ctx.practiceId)");
    expect(listEnrollmentsBlock).toContain("isNull(clients.deletedAt)");
    expect(listEnrollmentsBlock).toContain(
      "eq(patients.clientId, wellnessEnrollments.clientId)"
    );
    expect(listEnrollmentsBlock).toContain("patientId: patients.id");
    expect(listEnrollmentsBlock).toContain("eq(patients.practiceId, ctx.practiceId)");
    expect(listEnrollmentsBlock).toContain("isNull(patients.deletedAt)");
    expect(listEnrollmentsBlock).toContain(
      "const timezone = await practiceTimeZone(ctx.db, ctx.practiceId)"
    );
    expect(listEnrollmentsBlock).toContain("return rows.map((row) => ({");
    expect(listEnrollmentsBlock).toContain("timezone,");
  });

  it("joins enrollment plan and client display rows through active tenant predicates", () => {
    const source = readFileSync("server/routers/wellness.ts", "utf8");

    const planJoins = source.match(/innerJoin\(\s*wellnessPlans,/g);
    const clientJoins = source.match(
      /innerJoin\(\s*clients,\s*and\(\s*eq\(wellnessEnrollments\.clientId, clients\.id\),\s*eq\(clients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(clients\.deletedAt\)\s*\)\s*\)/gs
    );

    expect(planJoins?.length).toBeGreaterThanOrEqual(3);
    expect(clientJoins?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("activePracticePredicate(ctx.practiceId)");
  });
});
