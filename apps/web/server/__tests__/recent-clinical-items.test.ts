import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { recentClinicalItemsRouter } =
  await import("../routers/recent-clinical-items");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const RECENT_ID = "00000000-0000-0000-0000-000000000004";

function callerWithDb(db: Record<string, unknown>) {
  return recentClinicalItemsRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "clinician@example.test",
        name: "Field Clinician",
        role: "veterinarian",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function queryChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(async () => result);
  chain.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function createDb(
  selectResults: unknown[][],
  recordedRows = [{ id: RECENT_ID }],
) {
  const remaining = [...selectResults];
  const chains: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => {
    const chain = queryChain(remaining.shift() ?? []);
    chains.push(chain);
    return chain;
  });
  const returning = vi.fn(async () => recordedRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = { select, insert, execute };
  db.transaction = vi.fn(async (run: (tx: typeof db) => unknown) => run(db));
  return {
    db,
    select,
    insert,
    insertValues,
    onConflictDoUpdate,
    chains,
  };
}

beforeEach(() => {
  vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recent clinical items", () => {
  it("keeps both new procedures dark before database work", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "false");
    const { db, select, insert } = createDb([]);

    await expect(callerWithDb(db).list()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      callerWithDb(db).record({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("validates identifiers before database work", async () => {
    const { db, select, insert } = createDb([]);

    await expect(
      callerWithDb(db).record({ patientId: "not-a-patient" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a visit that is not attached to the tenant-owned patient", async () => {
    const { db, insert } = createDb([
      [{ patientId: PATIENT_ID, appointmentId: null }],
    ]);

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insert).not.toHaveBeenCalled();
  });

  it("upserts server-side history scoped to the current clinician", async () => {
    const { db, insertValues, onConflictDoUpdate } = createDb([
      [{ patientId: PATIENT_ID, appointmentId: APPOINTMENT_ID }],
    ]);

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ id: RECENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: USER_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        viewedAt: expect.any(Date),
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          appointmentId: APPOINTMENT_ID,
          deletedAt: null,
        }),
      }),
    );
  });

  it("returns at most ten active patient links", async () => {
    const rows = [
      {
        patientId: PATIENT_ID,
        patientName: "Maple",
        patientSpecies: "bovine",
        appointmentId: APPOINTMENT_ID,
        appointmentStatus: "in_exam",
        viewedAt: new Date("2026-09-02T14:00:00.000Z"),
      },
    ];
    const { db, chains } = createDb([rows]);

    await expect(callerWithDb(db).list()).resolves.toEqual(rows);
    expect(chains[0]?.limit).toHaveBeenCalledWith(10);
  });

  it("keeps recent history tenant-, user-, patient-, and visit-scoped", () => {
    const routerSource = readFileSync(
      new URL("../routers/recent-clinical-items.ts", import.meta.url),
      "utf8",
    );
    const schemaSource = readFileSync(
      new URL(
        "../../../../packages/db/schema/recent-clinical-items.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(routerSource).toContain(
      "eq(recentClinicalItems.practiceId, ctx.practiceId)",
    );
    expect(routerSource).toContain(
      "eq(recentClinicalItems.userId, ctx.user.id)",
    );
    expect(routerSource).toContain(
      "eq(appointments.patientId, recentClinicalItems.patientId)",
    );
    expect(routerSource).toContain("activePracticePredicate(ctx.practiceId)");
    expect(schemaSource).toContain("recent_clinical_items_user_patient_uq");
    expect(schemaSource).toContain("recent_clinical_items_user_tenant_fk");
    expect(schemaSource).toContain("recent_clinical_items_patient_tenant_fk");
    expect(schemaSource).toContain(
      "recent_clinical_items_appointment_tenant_fk",
    );
  });
});
