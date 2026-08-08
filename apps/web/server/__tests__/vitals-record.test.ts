import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const {
  vitalsRouter,
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
} = await import("../routers/vitals");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";

function callerWithDb(db: Record<string, unknown>, role = "technician") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Vitals User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return vitalsRouter.createCaller({ db, session } as never);
}

function thenableRows(result: unknown[]) {
  const query = {
    limit: vi.fn(async () => result),
    for: vi.fn(async () => result),
    orderBy: vi.fn(() => query),
    then: (resolve: (value: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

function createDb(opts: {
  patientRows?: unknown[];
  selectResults?: unknown[][];
  inserted?: Record<string, unknown>;
}) {
  const selectResults = opts.selectResults
    ? [...opts.selectResults]
    : [opts.patientRows ?? []];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const inserted = opts.inserted ?? {
    id: "00000000-0000-0000-0000-000000000004",
    practiceId: PRACTICE_ID,
    patientId: PATIENT_ID,
  };
  const insertReturning = vi.fn(async () => [inserted]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
  };

  return { db, select, insertValues };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("vitals.record tenant safety", () => {
  it("restricts vitals recording to clinical staff before querying", async () => {
    const { db, select, insertValues } = createDb({});

    for (const role of ["front_desk", "viewer"]) {
      await expect(
        callerWithDb(db, role).record({
          patientId: PATIENT_ID,
          temperatureC: 38.6,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects fractional pagination and over-precision numerics before querying", async () => {
    const { db, select, insertValues } = createDb({});

    await expect(
      callerWithDb(db).listByPatient({
        patientId: PATIENT_ID,
        limit: 1.5,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).listByAppointment({
        appointmentId: APPOINTMENT_ID,
        limit: 1.5,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        temperatureC: 38.66,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        weightKg: 12.3456,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        capillaryRefillSec: 1.55,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects vitals text that exceeds backing columns before querying", async () => {
    const { db, select, insertValues } = createDb({});

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        mucousMembrane: "A".repeat(VITALS_MUCOUS_MEMBRANE_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        notes: "A".repeat(VITALS_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects empty vital records before querying", async () => {
    const { db, select, insertValues } = createDb({});

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects vitals for a patient outside the current practice", async () => {
    const { db, insertValues } = createDb({ patientRows: [] });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        temperatureC: 38.6,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires active practice predicates for vitals history and recording", () => {
    const source = readFileSync(
      new URL("../routers/vitals.ts", import.meta.url),
      "utf8"
    );
    const visitIntegritySource = readFileSync(
      new URL("../../lib/records/visit-integrity.ts", import.meta.url),
      "utf8"
    );

    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("${practices.deletedAt} is null");
    expect(
      source.match(/activePracticePredicate\(practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(1);
    expect(source).toContain("activePracticePredicate(ctx.practiceId)");
    expect(source).toMatch(
      /eq\(patients\.practiceId, practiceId\),\s+activePracticePredicate\(practiceId\),\s+isNull\(patients\.deletedAt\)/
    );
    expect(source).toContain("lockOpenVisitForClinicalAppend");
    expect(visitIntegritySource).toContain("from ${practices}");
    expect(visitIntegritySource).toContain("${practices.deletedAt} is null");
    expect(source).toMatch(
      /eq\(vitalSigns\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(vitalSigns\.deletedAt\)/
    );
    expect(source).toContain(
      "eq(vitalSigns.appointmentId, input.appointmentId)"
    );
    expect(source).toContain("return ctx.db.transaction(async (tx) =>");
  });

  it("lists appointment-owned vitals for the current tenant after closeout", async () => {
    const recorded = {
      id: "00000000-0000-0000-0000-000000000004",
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
      temperatureC: "38.6",
    };
    const { db, select, insertValues } = createDb({
      selectResults: [[recorded]],
    });

    await expect(
      callerWithDb(db, "front_desk").listByAppointment({
        appointmentId: APPOINTMENT_ID,
      })
    ).resolves.toEqual([recorded]);

    expect(select).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects appointment-linked vitals when the appointment is not for that patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PATIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        temperatureC: 38.6,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records vitals for a patient in the current practice", async () => {
    const { db, insertValues } = createDb({ patientRows: [{ id: PATIENT_ID }] });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        temperatureC: 38.6,
        weightKg: 12.4,
        capillaryRefillSec: 1.5,
        heartRateBpm: 110,
      })
    ).resolves.toMatchObject({ patientId: PATIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        recordedBy: USER_ID,
        patientId: PATIENT_ID,
        temperatureC: "38.6",
        weightKg: "12.4",
        capillaryRefillSec: "1.5",
        heartRateBpm: 110,
      })
    );
  });

  it("records appointment-linked vitals after validating patient and appointment", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID, doctorId: USER_ID, status: "in_exam" }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).record({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        weightKg: 12.4,
      })
    ).resolves.toMatchObject({ patientId: PATIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        recordedBy: USER_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        weightKg: "12.4",
      })
    );
  });
});
