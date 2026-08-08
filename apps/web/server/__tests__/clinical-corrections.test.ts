import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { recordsRouter } = await import("../routers/records");
const { vitalsRouter } = await import("../routers/vitals");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const RECORD_ID = "00000000-0000-0000-0000-000000000004";
const CORRECTION_ID = "00000000-0000-0000-0000-000000000005";

function context(db: Record<string, unknown>, role = "veterinarian") {
  return {
    db,
    session: {
      user: {
        id: USER_ID,
        email: `${role}@example.com`,
        name: "Clinical User",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never;
}

function createDb(opts: {
  selectResults?: unknown[][];
  insertResults?: unknown[][];
}) {
  const selectResults = [...(opts.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(async () => result);
    builder.then = (
      resolve: (rows: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });

  const insertResults = [...(opts.insertResults ?? [])];
  const insertValues = vi.fn((values: Record<string, unknown>) => ({
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn(async () => insertResults.shift() ?? []),
    })),
    values,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const update = vi.fn();
  const remove = vi.fn();
  const db: Record<string, unknown> = {
    select,
    insert,
    update,
    delete: remove,
    execute: vi.fn(async () => undefined),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, select, insertValues, update, remove };
}

afterEach(() => vi.clearAllMocks());

describe("append-only clinical corrections", () => {
  it("allows only an active administrator or veterinarian", async () => {
    const { db, select, insertValues } = createDb({});

    for (const role of ["technician", "front_desk", "viewer"]) {
      await expect(
        recordsRouter
          .createCaller(context(db, role))
          .markSoapNoteEnteredInError({
            patientId: PATIENT_ID,
            recordId: RECORD_ID,
            reason: "Documented on the wrong visit.",
          }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        vitalsRouter.createCaller(context(db, role)).markEnteredInError({
          patientId: PATIENT_ID,
          recordId: RECORD_ID,
          reason: "Reading belongs to another patient.",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("bounds and requires a meaningful reason before querying", async () => {
    const { db, select } = createDb({});
    const caller = recordsRouter.createCaller(context(db));

    await expect(
      caller.markSoapNoteEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: " no ",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.markSoapNoteEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
  });

  it("does not leak whether a wrong-patient or cross-tenant record exists", async () => {
    const { db, insertValues } = createDb({ selectResults: [[], []] });

    await expect(
      recordsRouter.createCaller(context(db)).markSoapNoteEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "Documented on the wrong visit.",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Clinical record not found",
    });
    await expect(
      vitalsRouter.createCaller(context(db)).markEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "Reading belongs to another patient.",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Clinical record not found",
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("appends an attributed SOAP correction without mutating the original", async () => {
    const correction = { id: CORRECTION_ID, action: "entered_in_error" };
    const { db, insertValues, update, remove } = createDb({
      selectResults: [
        [
          {
            id: RECORD_ID,
            patientId: PATIENT_ID,
            appointmentId: APPOINTMENT_ID,
          },
        ],
      ],
      insertResults: [[correction]],
    });

    await expect(
      recordsRouter.createCaller(context(db)).markSoapNoteEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "Documented on the wrong visit.",
      }),
    ).resolves.toEqual(correction);
    expect(insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      recordType: "soap_note",
      action: "entered_in_error",
      soapNoteId: RECORD_ID,
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
      reason: "Documented on the wrong visit.",
      correctedBy: USER_ID,
      correctedByName: "Clinical User",
    });
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("allows correction of appointment-owned vitals after closeout", async () => {
    const correction = { id: CORRECTION_ID, action: "entered_in_error" };
    const { db, select, insertValues } = createDb({
      selectResults: [
        [
          {
            id: RECORD_ID,
            patientId: PATIENT_ID,
            appointmentId: APPOINTMENT_ID,
          },
        ],
      ],
      insertResults: [[correction]],
    });

    await expect(
      vitalsRouter.createCaller(context(db, "admin")).markEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "Monitor was attached to the wrong patient.",
      }),
    ).resolves.toEqual(correction);
    expect(select).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        vitalSignId: RECORD_ID,
        appointmentId: APPOINTMENT_ID,
      }),
    );
  });

  it("returns the existing event on an idempotent retry", async () => {
    const existing = {
      id: CORRECTION_ID,
      practiceId: PRACTICE_ID,
      soapNoteId: RECORD_ID,
    };
    const { db, select } = createDb({
      selectResults: [
        [{ id: RECORD_ID, patientId: PATIENT_ID, appointmentId: null }],
        [existing],
      ],
      insertResults: [[]],
    });

    await expect(
      recordsRouter.createCaller(context(db)).markSoapNoteEnteredInError({
        patientId: PATIENT_ID,
        recordId: RECORD_ID,
        reason: "Duplicate request after a network retry.",
      }),
    ).resolves.toEqual(existing);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
