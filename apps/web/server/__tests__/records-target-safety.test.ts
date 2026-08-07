import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SOAP_SECTION_MAX_LENGTH } from "@/lib/records/soap-content";
import {
  LAB_RESULT_VALUE_MAX_LENGTH,
  LAB_TEST_NAME_MAX_LENGTH,
  LAB_UNIT_MAX_LENGTH,
} from "@/lib/records/lab-policy";
import {
  VACCINATION_LOT_NUMBER_MAX_LENGTH,
  VACCINATION_MANUFACTURER_MAX_LENGTH,
  VACCINATION_NAME_MAX_LENGTH,
} from "@/lib/records/vaccination-policy";
import { PROBLEM_DESCRIPTION_MAX_LENGTH } from "@/lib/records/problem-policy";
import {
  PROCEDURE_ANESTHESIA_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_DURATION_MAX_MINUTES,
  PROCEDURE_NAME_MAX_LENGTH,
  PROCEDURE_NOTES_MAX_LENGTH,
} from "@/lib/records/procedure-policy";
import { CONSENT_FORM_LIBRARY } from "@/lib/consult/consent-form-library";

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

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const RECORD_ID = "00000000-0000-0000-0000-000000000004";
const FORM_ID = "00000000-0000-0000-0000-000000000005";

function callerWithDb(db: Record<string, unknown>, role = "veterinarian") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Doctor",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return recordsRouter.createCaller({ db, session } as never);
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
      orderBy: vi.fn(() => afterWhere),
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

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({
    returning: insertReturning,
    onConflictDoNothing: vi.fn(async () => undefined),
  }));
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

describe("records target safety", () => {
  const patientRow = [{ id: PATIENT_ID }];
  const appointmentRow = [{ id: APPOINTMENT_ID }];

  it("returns active practice identity for Records date rendering and PDFs", async () => {
    const { db, select } = createDb({
      selectResults: [
        [
          {
            name: "Neighborhood Veterinary",
            phone: "555-0100",
            timezone: "America/Los_Angeles",
          },
        ],
      ],
    });

    await expect(callerWithDb(db).settings()).resolves.toEqual({
      name: "Neighborhood Veterinary",
      phone: "555-0100",
      timezone: "America/Los_Angeles",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or deleted practice identity instead of using fallback settings", async () => {
    const { db, select } = createDb({ selectResults: [[]] });

    await expect(callerWithDb(db).settings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("requires an active practice predicate for clinical record ownership checks", () => {
    const source = readFileSync("server/routers/records.ts", "utf8");

    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("isNull(practices.deletedAt)");
    expect(source).toContain('practice.name?.trim() || "Veterinary Practice"');
    expect(source).not.toContain("practice?.name");
    expect(source).not.toContain("practice?.phone");
    expect(source).not.toContain("practice?.timezone");
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(15);
    expect(source).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(patients\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(problemList\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(problemList\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(labResults\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(labResults\.deletedAt\)/
    );
  });

  it("requires a tenant-owned patient before creating a SOAP note", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        subjective: "Eating well",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires appointment-linked records to use an appointment for the same patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, []],
    });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        name: "Dental cleaning",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a vaccination after validating the patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow],
      insertedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          vaccineName: "Rabies",
          administeredBy: USER_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).createVaccination({
        patientId: PATIENT_ID,
        vaccineName: "Rabies",
      })
    ).resolves.toMatchObject({ id: RECORD_ID, vaccineName: "Rabies" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: PATIENT_ID,
        practiceId: PRACTICE_ID,
        administeredBy: USER_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "vaccination.recorded",
      {
        id: RECORD_ID,
        patientId: PATIENT_ID,
        vaccineName: "Rabies",
        administeredBy: USER_ID,
        source: "dashboard",
      }
    );
  });

  it("rejects invalid vaccination and problem dates before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createVaccination({
        patientId: PATIENT_ID,
        vaccineName: "Rabies",
        nextDueDate: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProblem({
        patientId: PATIENT_ID,
        description: "Chronic otitis",
        onsetDate: "not-a-date",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects clinical record text that exceeds backing columns before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createVaccination({
        patientId: PATIENT_ID,
        vaccineName: "A".repeat(VACCINATION_NAME_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createVaccination({
        patientId: PATIENT_ID,
        vaccineName: "Rabies",
        lotNumber: "A".repeat(VACCINATION_LOT_NUMBER_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createVaccination({
        patientId: PATIENT_ID,
        vaccineName: "Rabies",
        manufacturer: "A".repeat(VACCINATION_MANUFACTURER_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProblem({
        patientId: PATIENT_ID,
        description: "A".repeat(PROBLEM_DESCRIPTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "A".repeat(LAB_TEST_NAME_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "CBC",
        resultValue: "A".repeat(LAB_RESULT_VALUE_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "CBC",
        unit: "A".repeat(LAB_UNIT_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        name: "A".repeat(PROCEDURE_NAME_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized procedure details before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        name: "Dental cleaning",
        description: "A".repeat(PROCEDURE_DESCRIPTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        name: "Dental cleaning",
        anesthesiaUsed: "A".repeat(PROCEDURE_ANESTHESIA_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        name: "Dental cleaning",
        durationMinutes: PROCEDURE_DURATION_MAX_MINUTES + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        name: "Dental cleaning",
        notes: "A".repeat(PROCEDURE_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a SOAP note after validating patient and appointment ownership", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, appointmentRow],
      insertedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          appointmentId: APPOINTMENT_ID,
          authorId: USER_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
      })
    ).resolves.toMatchObject({ id: RECORD_ID, patientId: PATIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        practiceId: PRACTICE_ID,
        authorId: USER_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "soap_note.created",
      {
        id: RECORD_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        authorId: USER_ID,
        source: "dashboard",
      }
    );
  });

  it("rejects SOAP notes with only empty rich-text markup", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow],
    });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        subjective: "<p><br></p>",
        objective: "<ul><li>&nbsp;</li></ul>",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized SOAP sections before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        subjective: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        objective: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        assessment: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapNote({
        patientId: PATIENT_ID,
        plan: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("emits a webhook after creating a problem list item", async () => {
    const { db } = createDb({
      selectResults: [patientRow],
      insertedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          status: "active",
        },
      ],
    });

    await expect(
      callerWithDb(db).createProblem({
        patientId: PATIENT_ID,
        description: "Chronic otitis",
      })
    ).resolves.toMatchObject({ id: RECORD_ID, status: "active" });

    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "problem.created",
      {
        id: RECORD_ID,
        patientId: PATIENT_ID,
        status: "active",
        source: "dashboard",
      }
    );
  });

  it("emits a webhook after creating a lab result", async () => {
    const { db } = createDb({
      selectResults: [patientRow],
      insertedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          testName: "CBC",
          status: "pending",
          orderedBy: USER_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "CBC",
      })
    ).resolves.toMatchObject({ id: RECORD_ID, testName: "CBC" });

    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "lab_result.created",
      {
        id: RECORD_ID,
        patientId: PATIENT_ID,
        testName: "CBC",
        status: "pending",
        orderedBy: USER_ID,
        source: "dashboard",
      }
    );
  });

  it("rejects invalid lab reference ranges before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "CBC",
        referenceRangeLow: "not numeric",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLabResult({
        patientId: PATIENT_ID,
        testName: "CBC",
        referenceRangeLow: "30.000",
        referenceRangeHigh: "7.000",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("emits a webhook after creating a procedure", async () => {
    const { db } = createDb({
      selectResults: [patientRow, appointmentRow],
      insertedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          appointmentId: APPOINTMENT_ID,
          name: "Dental cleaning",
          performedBy: USER_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).createProcedure({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        name: "Dental cleaning",
      })
    ).resolves.toMatchObject({ id: RECORD_ID, name: "Dental cleaning" });

    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "procedure.created",
      {
        id: RECORD_ID,
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        name: "Dental cleaning",
        performedBy: USER_ID,
        source: "dashboard",
      }
    );
  });

  it("sets resolved problem dates from the practice timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, updateSet } = createDb({
      selectResults: [
        [{ status: "active", resolvedDate: null }],
        [{ timezone: "America/Los_Angeles" }],
      ],
      updatedRows: [
        {
          id: RECORD_ID,
          patientId: PATIENT_ID,
          status: "resolved",
          resolvedDate: "2026-07-14",
        },
      ],
    });

    await expect(
      callerWithDb(db).updateProblemStatus({
        id: RECORD_ID,
        status: "resolved",
      })
    ).resolves.toMatchObject({
      id: RECORD_ID,
      status: "resolved",
      resolvedDate: "2026-07-14",
    });

    expect(updateSet).toHaveBeenCalledWith({
      status: "resolved",
      resolvedDate: "2026-07-14",
    });
  });

  it("rejects stale or cross-tenant problem status updates", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateProblemStatus({
        id: RECORD_ID,
        status: "resolved",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("preserves existing resolved dates on repeated problem status updates", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ status: "resolved", resolvedDate: "2026-07-01" }]],
      updatedRows: [
        {
          id: RECORD_ID,
          status: "resolved",
          resolvedDate: "2026-07-01",
        },
      ],
    });

    await expect(
      callerWithDb(db).updateProblemStatus({
        id: RECORD_ID,
        status: "resolved",
      })
    ).resolves.toMatchObject({
      id: RECORD_ID,
      status: "resolved",
      resolvedDate: "2026-07-01",
    });

    expect(updateSet).toHaveBeenCalledWith(
      {
        status: "resolved",
        resolvedDate: "2026-07-01",
      }
    );
  });

  it("rejects problem status updates that lose a concurrent race", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ status: "active", resolvedDate: null }], [{}]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateProblemStatus({
        id: RECORD_ID,
        status: "resolved",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Problem changed while updating. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "resolved",
      })
    );
  });

  it("rejects stale or cross-tenant lab result status updates", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateLabResultStatus({
        id: RECORD_ID,
        status: "reviewed",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires lab result status transitions to follow pending, completed, reviewed order", async () => {
    const pending = createDb({
      selectResults: [[{ status: "pending" }]],
    });

    await expect(
      callerWithDb(pending.db).updateLabResultStatus({
        id: RECORD_ID,
        status: "reviewed",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change lab result status from pending to reviewed.",
    });
    expect(pending.updateSet).not.toHaveBeenCalled();

    const reviewed = createDb({
      selectResults: [[{ status: "reviewed" }]],
    });

    await expect(
      callerWithDb(reviewed.db).updateLabResultStatus({
        id: RECORD_ID,
        status: "completed",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change lab result status from reviewed to completed.",
    });
    expect(reviewed.updateSet).not.toHaveBeenCalled();
  });

  it("reviews completed lab results and stamps the reviewer", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ status: "completed" }]],
      updatedRows: [
        {
          id: RECORD_ID,
          status: "reviewed",
          reviewedBy: USER_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).updateLabResultStatus({
        id: RECORD_ID,
        status: "reviewed",
      })
    ).resolves.toMatchObject({
      id: RECORD_ID,
      status: "reviewed",
      reviewedBy: USER_ID,
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reviewed",
        reviewedBy: USER_ID,
      })
    );
  });

  it("rejects lab status updates that lose a concurrent race", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ status: "completed" }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateLabResultStatus({
        id: RECORD_ID,
        status: "reviewed",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Lab result changed while updating. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "reviewed",
        reviewedBy: USER_ID,
      })
    );
  });
});

describe("capture sessions", () => {
  const patientRow = [{ id: PATIENT_ID }];

  it("mints a 30-minute capture link for a tenant-owned patient", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const { db, insertValues } = createDb({
      selectResults: [patientRow],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createCaptureSession({
      patientId: PATIENT_ID,
    });

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.url).toMatch(
      new RegExp(`/capture/${result.token}$`)
    );
    expect(result.expiresAt).toEqual(
      new Date("2026-07-10T12:30:00.000Z")
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: USER_ID,
        token: result.token,
        expiresAt: result.expiresAt,
      })
    );
  });

  it("stamps the open visit so captured photos attach to it", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, [{ id: APPOINTMENT_ID }]],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createCaptureSession({
      patientId: PATIENT_ID,
    });

    expect(result.appointmentId).toBe(APPOINTMENT_ID);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: APPOINTMENT_ID })
    );
  });

  it("stamps the encounter-selected visit even before check-in", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, [{ id: APPOINTMENT_ID }]],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createCaptureSession({
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
    });

    expect(result.appointmentId).toBe(APPOINTMENT_ID);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: APPOINTMENT_ID })
    );
  });

  it("rejects an encounter-selected visit outside the patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, []],
    });

    await expect(
      callerWithDb(db).createCaptureSession({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("leaves the visit blank when the patient has no open visit", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, []],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createCaptureSession({
      patientId: PATIENT_ID,
    });

    expect(result.appointmentId).toBeNull();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: null })
    );
  });

  it("keeps capture links restricted to non-viewer staff roles", async () => {
    for (const role of [
      "admin",
      "veterinarian",
      "technician",
      "front_desk",
    ]) {
      const { db } = createDb({
        selectResults: [patientRow],
        insertedRows: [{ id: RECORD_ID }],
      });
      await expect(
        callerWithDb(db, role).createCaptureSession({ patientId: PATIENT_ID })
      ).resolves.toMatchObject({ token: expect.any(String) });
    }

    const { db, insertValues } = createDb();
    await expect(
      callerWithDb(db, "viewer").createCaptureSession({
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects capture links for patients outside the practice", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createCaptureSession({ patientId: PATIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned patient before listing capture files", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).listCaptureFiles({ patientId: PATIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("consent forms", () => {
  it("seeds the starter library on first read, idempotently", async () => {
    const seeded = CONSENT_FORM_LIBRARY.map((form, i) => ({
      id: `${FORM_ID.slice(0, -2)}${String(i).padStart(2, "0")}`,
      slug: form.slug,
      title: form.title,
      body: form.body,
      sortOrder: form.sortOrder,
    }));
    const { db, insertValues } = createDb({
      selectResults: [[], seeded],
    });

    const result = await callerWithDb(db).listConsentForms();

    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = (
      insertValues.mock.calls as unknown as Array<
        [Array<{ slug: string; practiceId: string }>]
      >
    )[0]![0];
    expect(inserted).toHaveLength(CONSENT_FORM_LIBRARY.length);
    expect(inserted.every((row) => row.practiceId === PRACTICE_ID)).toBe(true);
    expect(result).toHaveLength(CONSENT_FORM_LIBRARY.length);
  });

  it("returns existing forms without reseeding", async () => {
    const existing = [
      {
        id: FORM_ID,
        slug: "treatment",
        title: "Consent to treatment",
        body: "custom body",
        sortOrder: 0,
      },
    ];
    const { db, insertValues } = createDb({ selectResults: [existing] });

    const result = await callerWithDb(db).listConsentForms();

    expect(result).toEqual(existing);
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe("consent requests", () => {
  const patientRow = [{ id: PATIENT_ID }];
  const treatmentForm = CONSENT_FORM_LIBRARY[0]!;
  const formRow = [
    { id: FORM_ID, title: treatmentForm.title, body: treatmentForm.body },
  ];

  it("mints a 60-minute consent link snapshotting the chosen form", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const { db, insertValues } = createDb({
      selectResults: [patientRow, formRow],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createConsentRequest({
      patientId: PATIENT_ID,
      formId: FORM_ID,
    });

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.url).toMatch(new RegExp(`/sign/${result.token}$`));
    expect(result.expiresAt).toEqual(new Date("2026-07-10T13:00:00.000Z"));
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: USER_ID,
        formId: FORM_ID,
        token: result.token,
        expiresAt: result.expiresAt,
        title: "Consent to treatment",
        bodyText: expect.stringContaining("I give this clinic permission"),
      })
    );
  });

  it("stamps the open visit so the signed consent attaches to it", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, formRow, [{ id: APPOINTMENT_ID }]],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createConsentRequest({
      patientId: PATIENT_ID,
      formId: FORM_ID,
    });

    expect(result.appointmentId).toBe(APPOINTMENT_ID);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: APPOINTMENT_ID })
    );
  });

  it("stamps the encounter-selected visit on a consent before check-in", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, formRow, [{ id: APPOINTMENT_ID }]],
      insertedRows: [{ id: RECORD_ID }],
    });

    const result = await callerWithDb(db).createConsentRequest({
      patientId: PATIENT_ID,
      appointmentId: APPOINTMENT_ID,
      formId: FORM_ID,
    });

    expect(result.appointmentId).toBe(APPOINTMENT_ID);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: APPOINTMENT_ID })
    );
  });

  it("rejects an encounter-selected consent visit outside the patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, formRow, []],
    });

    await expect(
      callerWithDb(db).createConsentRequest({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        formId: FORM_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("snapshots custom consent copy onto the request", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, formRow],
      insertedRows: [{ id: RECORD_ID }],
    });

    await callerWithDb(db).createConsentRequest({
      patientId: PATIENT_ID,
      formId: FORM_ID,
      title: "Dental cleaning consent",
      bodyText: "I agree to the dental cleaning we talked about.",
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        formId: FORM_ID,
        title: "Dental cleaning consent",
        bodyText: "I agree to the dental cleaning we talked about.",
      })
    );
  });

  it("rejects dispatch when the form is not in the practice library", async () => {
    const { db, insertValues } = createDb({
      selectResults: [patientRow, []],
    });

    await expect(
      callerWithDb(db).createConsentRequest({
        patientId: PATIENT_ID,
        formId: FORM_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("keeps consent links restricted to non-viewer staff roles", async () => {
    for (const role of [
      "admin",
      "veterinarian",
      "technician",
      "front_desk",
    ] as const) {
      const { db } = createDb({
        selectResults: [patientRow, formRow],
        insertedRows: [{ id: RECORD_ID }],
      });
      await expect(
        callerWithDb(db, role).createConsentRequest({
          patientId: PATIENT_ID,
          formId: FORM_ID,
        })
      ).resolves.toMatchObject({ token: expect.any(String) });
    }

    const { db, insertValues } = createDb();
    await expect(
      callerWithDb(db, "viewer").createConsentRequest({
        patientId: PATIENT_ID,
        formId: FORM_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects consent links for patients outside the practice", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createConsentRequest({
        patientId: PATIENT_ID,
        formId: FORM_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned patient before listing consents", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).listConsents({ patientId: PATIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
