import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { visitTreatmentPlansRouter } =
  await import("../routers/visit-treatment-plans");

const ROUTER_SOURCE = readFileSync(
  new URL("../routers/visit-treatment-plans.ts", import.meta.url),
  "utf8",
);
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const SERVICE_ID = "00000000-0000-0000-0000-000000000004";
const OPERATION_ID = "00000000-0000-0000-0000-000000000005";

function callerFor(role: string) {
  const tx = {
    execute: vi.fn(async () => undefined),
  };
  const db = {
    transaction: vi.fn(async (fn: (database: unknown) => unknown) => fn(tx)),
  };
  const session = {
    user: {
      id: USER_ID,
      email: "staff@example.com",
      name: "Staff",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return {
    caller: visitTreatmentPlansRouter.createCaller({ db, session } as never),
    db,
    tx,
  };
}

const validCreateInput = {
  operationId: OPERATION_ID,
  clientId: CLIENT_ID,
  patientId: PATIENT_ID,
  title: "Dental treatment plan",
  items: [
    {
      itemType: "service" as const,
      itemId: SERVICE_ID,
      quantity: "1",
    },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("visit treatment-plan authoring safety", () => {
  it("keeps the registered production API dark by default", async () => {
    const { caller, db } = callerFor("admin");
    await expect(caller.create(validCreateInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Treatment plan authoring is not available.",
    });

    // Only protectedProcedure's tenant wrapper ran; no nested authoring
    // transaction or write path was reached.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it.each(["front_desk", "viewer"])(
    "rejects the %s role before authoring",
    async (role) => {
      vi.stubEnv("TREATMENT_PLAN_AUTHORING_ENABLED", "true");
      const { caller } = callerFor(role);
      await expect(caller.create(validCreateInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );

  it("uses a nested savepoint and surfaces deferred constraints before returning", () => {
    expect(ROUTER_SOURCE).toContain("await ctx.db.transaction(async (tx) =>");
    expect(ROUTER_SOURCE).toContain(
      "await database.execute(sql`set constraints all immediate`)",
    );
  });

  it("locks the plan root before checking and staging a new revision", () => {
    const reviseStart = ROUTER_SOURCE.indexOf("revise: protectedProcedure");
    const reviseSource = ROUTER_SOURCE.slice(reviseStart);
    const lock = reviseSource.indexOf('.for("update")');
    const latest = reviseSource.indexOf("const [latest]");
    const stage = reviseSource.indexOf("return stageAndSealRevision");
    expect(lock).toBeGreaterThan(0);
    expect(latest).toBeGreaterThan(lock);
    expect(stage).toBeGreaterThan(latest);
  });

  it("requires active tenant-owned context and catalog rows", () => {
    expect(ROUTER_SOURCE).toContain("eq(patients.practiceId, practiceId)");
    expect(ROUTER_SOURCE).toContain("eq(patients.clientId, input.clientId)");
    expect(ROUTER_SOURCE).toContain("eq(appointments.practiceId, practiceId)");
    expect(ROUTER_SOURCE).toContain("eq(services.practiceId, practiceId)");
    expect(ROUTER_SOURCE).toContain("eq(products.practiceId, practiceId)");
    expect(ROUTER_SOURCE).toContain("isNull(services.deletedAt)");
    expect(ROUTER_SOURCE).toContain("isNull(products.deletedAt)");
  });

  it("does not import or mutate downstream billing, inventory, queue, or consent surfaces", () => {
    expect(ROUTER_SOURCE).not.toMatch(
      /invoiceItems|invoices|whiteboard|consent/i,
    );
    expect(ROUTER_SOURCE).not.toMatch(/stockQuantity|inventoryTracked/);
    expect(ROUTER_SOURCE).not.toContain("postCommitEffect");
  });
});
