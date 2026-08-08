import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SOAP_SECTION_MAX_LENGTH } from "@/lib/records/soap-content";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { AI_SOURCE_MAX_LENGTH, aiRouter } = await import("../routers/ai");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const NOTE_ID = "00000000-0000-0000-0000-000000000004";

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
  return aiRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      for: vi.fn(async () => result),
      groupBy: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
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
      orderBy: vi.fn(async () => result),
      groupBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AI SOAP note safety", () => {
  it("rejects a patient-only live AI SOAP note before querying", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        subjective: "Eating well",
        source: "scribe",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned patient before creating an AI SOAP note", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires the appointment to belong to the selected patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PATIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates an AI SOAP note after validating patient and appointment", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PATIENT_ID }],
        [{ id: APPOINTMENT_ID, doctorId: USER_ID, status: "in_exam" }],
        [],
      ],
      insertedRows: [{ id: NOTE_ID, patientId: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
        source: "scribe",
      })
    ).resolves.toMatchObject({
      id: NOTE_ID,
      patientId: PATIENT_ID,
      source: "scribe",
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        practiceId: PRACTICE_ID,
        authorId: USER_ID,
      })
    );
  });

  it("rejects AI SOAP notes with only empty rich-text markup", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: PATIENT_ID }]],
    });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "<p><br></p>",
        plan: "&nbsp;",
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized AI SOAP sections before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        objective: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        assessment: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        plan: "A".repeat(SOAP_SECTION_MAX_LENGTH + 1),
        source: "scribe",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized AI SOAP sources before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
        source: "A".repeat(AI_SOURCE_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects AI SOAP note creation when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createSoapFromAI({
        patientId: PATIENT_ID,
        appointmentId: APPOINTMENT_ID,
        subjective: "Eating well",
        source: "scribe",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe("AI recommendation query safety", () => {
  const source = readFileSync(
    new URL("../routers/ai.ts", import.meta.url),
    "utf8"
  );

  function scopedJoinPattern(
    joinMethod: "innerJoin" | "leftJoin",
    table: string,
    foreignKey: string
  ) {
    return new RegExp(
      `${joinMethod}\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
        ".",
        "\\."
      )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, ctx\\.practiceId\\),\\s*activePracticePredicate\\(ctx\\.practiceId\\),\\s*isNull\\(${table}\\.deletedAt\\)\\s*\\)\\s*\\)`,
      "gs"
    );
  }

  it("scopes vaccination recommendation display joins to active tenant rows", () => {
    expect(
      source.match(
        scopedJoinPattern(
          "innerJoin",
          "patients",
          "vaccinationRecords.patientId"
        )
      )?.length
    ).toBeGreaterThanOrEqual(1);

    expect(
      source.match(scopedJoinPattern("leftJoin", "clients", "patients.clientId"))
        ?.length
    ).toBeGreaterThanOrEqual(1);
  });

  it("uses the practice timezone for overdue vaccination cutoffs", () => {
    const vaccinationBlock = source.slice(
      source.indexOf("patientsOverdueVaccinations:"),
      source.indexOf("patientsNeedingFollowUp:")
    );

    expect(source).toContain("async function practiceDateInput");
    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain("return practice.timezone ?? null");
    expect(source).not.toContain("practice?.timezone");
    expect(source).toContain(
      "formatDateInputForTimeZone(new Date(), await practiceTimeZone(ctx))"
    );
    expect(vaccinationBlock).toContain(
      "const today = await practiceDateInput(ctx)"
    );
    expect(source).not.toContain("new Date().toISOString().slice(0, 10)");
  });

  it("lists overdue vaccinations against the practice-local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db } = createDb({
      selectResults: [
        [{ timezone: "America/Los_Angeles" }],
        [
          {
            patientId: PATIENT_ID,
            patientName: "Miso",
            species: "canine",
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            vaccineName: "Rabies",
            nextDueDate: "2026-07-13",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).patientsOverdueVaccinations()
    ).resolves.toEqual([
      expect.objectContaining({
        patientId: PATIENT_ID,
        patientName: "Miso",
        clientName: "Ada Lovelace",
        vaccineName: "Rabies",
        nextDueDate: "2026-07-13",
      }),
    ]);
  });

  it("rejects overdue vaccination queries when the practice is missing or deleted", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).patientsOverdueVaccinations()
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("uses the practice timezone bounds for daily summaries", () => {
    const summaryBlock = source.slice(source.indexOf("dailySummary:"));

    expect(source).toContain("async function practiceDayRange");
    expect(source).toContain(
      "dateInputUtcRangeForTimeZone(new Date(), await practiceTimeZone(ctx))"
    );
    expect(summaryBlock).toContain("const today = await practiceDayRange(ctx)");
    expect(summaryBlock).toContain("gte(appointments.startTime, today.start)");
    expect(summaryBlock).toContain("lt(appointments.startTime, today.end)");
    expect(summaryBlock).toContain("gte(soapNotes.createdAt, today.start)");
    expect(summaryBlock).toContain("lt(soapNotes.createdAt, today.end)");
    expect(summaryBlock).toContain("gte(invoices.updatedAt, today.start)");
    expect(summaryBlock).toContain("lt(invoices.updatedAt, today.end)");
    expect(summaryBlock).toContain("date: today.date");
    expect(summaryBlock).not.toContain("todayStart.toISOString()");
  });

  it("summarizes daily activity against the practice-local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, select } = createDb({
      selectResults: [
        [{ timezone: "America/Los_Angeles" }],
        [
          { status: "checked_out", count: 2 },
          { status: "scheduled", count: 1 },
        ],
        [{ count: 4 }],
        [{ count: 3 }],
      ],
    });

    await expect(callerWithDb(db).dailySummary()).resolves.toEqual({
      date: "2026-07-14",
      appointments: {
        total: 3,
        byStatus: {
          checked_out: 2,
          scheduled: 1,
        },
      },
      patientsSeen: 2,
      soapNotesCreated: 4,
      invoicesPaid: 3,
    });

    expect(select).toHaveBeenCalledTimes(4);
  });

  it("rejects follow-up and daily summary queries when the practice is missing or deleted", async () => {
    const { db } = createDb({ selectResults: [[], []] });
    const caller = callerWithDb(db);

    await expect(caller.patientsNeedingFollowUp()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.dailySummary()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("scopes follow-up recommendation display joins to active tenant rows", () => {
    expect(
      source.match(
        scopedJoinPattern("leftJoin", "clients", "appointments.clientId")
      )?.length
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps follow-up recommendation patients tied to the appointment client", () => {
    const followUpBlock = source.slice(
      source.indexOf("patientsNeedingFollowUp:"),
      source.indexOf("dailySummary:")
    );

    expect(followUpBlock).toMatch(
      /innerJoin\(\s*patients,\s*and\(\s*eq\(appointments\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointments\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/s
    );
  });

  it("filters future appointment checks with a structured inArray predicate", () => {
    expect(source).toContain("inArray(appointments.patientId, patientIds)");
  });
});
