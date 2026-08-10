import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  recordActivationAfterAppointmentCreated: vi.fn(async () => true),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/funnel-events-server", () => ({
  recordActivationAfterAppointmentCreated:
    mocks.recordActivationAfterAppointmentCreated,
}));

const { appointmentsRouter } = await import("../routers/appointments");
const {
  APPOINTMENT_DURATION_MAX_MINUTES,
  APPOINTMENT_DURATION_MIN_MINUTES,
  APPOINTMENT_NOTES_MAX_LENGTH,
  APPOINTMENT_RECURRENCE_INTERVAL_MAX,
  APPOINTMENT_RECURRENCE_INTERVAL_MIN,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MAX,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MIN,
  isAppointmentDateTimeRangeValid,
} = await import("@/lib/scheduling/appointment-policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_CLIENT_ID = "00000000-0000-0000-0000-000000000099";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const TYPE_ID = "00000000-0000-0000-0000-000000000004";
const DOCTOR_ID = "00000000-0000-0000-0000-000000000005";
const ROOM_ID = "00000000-0000-0000-0000-000000000006";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000007";
const SERIES_ID = "00000000-0000-0000-0000-000000000008";
const FUTURE_APPOINTMENT_ID = "00000000-0000-0000-0000-000000000009";
const LOCATION_ID = "00000000-0000-0000-0000-00000000000a";

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
  return appointmentsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
  updateResults?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn((fields?: Record<string, unknown>) => {
    const fieldNames = Object.keys(fields ?? {})
      .sort()
      .join(",");
    const result =
      fieldNames === "address,id,isPrimary,name,phone"
        ? [
            {
              id: LOCATION_ID,
              name: "Main Clinic",
              address: "1 Main St",
              phone: null,
              isPrimary: true,
            },
          ]
        : fieldNames === "id,locationId"
          ? [{ id: ROOM_ID, locationId: LOCATION_ID }]
          : fieldNames === "locationId"
            ? [{ locationId: LOCATION_ID }]
            : (selectResults.shift() ?? []);
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      for: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
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

  const updateResults = opts?.updateResults ? [...opts.updateResults] : null;
  const updateReturning = vi.fn(
    async () => updateResults?.shift() ?? opts?.updatedRows ?? []
  );
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

  return { db, select, insertValues, transaction, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("appointments target safety", () => {
  const startTime = "2026-07-01T14:00:00.000Z";
  const endTime = "2026-07-01T14:30:00.000Z";

  it("accepts date-only list ranges for dashboard appointment summaries", async () => {
    const row = { id: APPOINTMENT_ID, startTime: new Date(startTime) };
    const { db, select } = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }], [row]],
    });

    await expect(
      callerWithDb(db).list({
        startDate: "2026-07-01",
        endDate: "2026-07-02",
      })
    ).resolves.toEqual([row]);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid appointment date inputs before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    expect(APPOINTMENT_NOTES_MAX_LENGTH).toBe(2000);
    expect(APPOINTMENT_DURATION_MIN_MINUTES).toBe(5);
    expect(APPOINTMENT_DURATION_MAX_MINUTES).toBe(480);
    expect(APPOINTMENT_RECURRENCE_INTERVAL_MIN).toBe(1);
    expect(APPOINTMENT_RECURRENCE_INTERVAL_MAX).toBe(12);
    expect(APPOINTMENT_RECURRENCE_OCCURRENCES_MIN).toBe(1);
    expect(APPOINTMENT_RECURRENCE_OCCURRENCES_MAX).toBe(52);
    expect(isAppointmentDateTimeRangeValid(startTime, endTime)).toBe(true);
    expect(isAppointmentDateTimeRangeValid(startTime, startTime)).toBe(false);
    expect(
      isAppointmentDateTimeRangeValid(
        startTime,
        "2026-07-01T14:04:00.000Z"
      )
    ).toBe(false);
    expect(
      isAppointmentDateTimeRangeValid(
        startTime,
        "2026-07-01T22:01:00.000Z"
      )
    ).toBe(false);

    await expect(
      callerWithDb(db).list({
        startDate: "2026-02-31",
        endDate: endTime,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        startTime: "not-a-date",
        endTime,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        startTime,
        endTime,
        notes: "n".repeat(APPOINTMENT_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        startTime,
        endTime: "2026-07-01T14:04:00.000Z",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        startTime,
        endTime: "2026-07-01T22:01:00.000Z",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        startTime,
        endTime: startTime,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).availableSlots({
        date: "2026-02-31",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime: "2026-07-01T13:30:00.000Z",
        frequency: "weekly",
        interval: 1,
        occurrences: 3,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: APPOINTMENT_RECURRENCE_INTERVAL_MAX + 1,
        occurrences: 3,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: 1,
        occurrences: APPOINTMENT_RECURRENCE_OCCURRENCES_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: 1,
        occurrences: 3,
        notes: "n".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned client before creating an appointment", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires an active practice before creating a targetless appointment block", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).create({
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires the selected patient to belong to the selected client", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PATIENT_ID, clientId: OTHER_CLIENT_ID }]],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires an optional appointment type to belong to the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: CLIENT_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        typeId: TYPE_ID,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates an appointment after validating all selected targets", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [{ id: CLIENT_ID }],
        [{ id: TYPE_ID }],
        [{ id: DOCTOR_ID }],
        [{ id: ROOM_ID }],
        [],
      ],
      insertedRows: [
        {
          id: APPOINTMENT_ID,
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          typeId: TYPE_ID,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          status: "scheduled",
        },
      ],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        typeId: TYPE_ID,
        doctorId: DOCTOR_ID,
        roomId: ROOM_ID,
        startTime,
        endTime,
        notes: " Bring stool sample ",
      })
    ).resolves.toMatchObject({ id: APPOINTMENT_ID, patientId: PATIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        typeId: TYPE_ID,
        doctorId: DOCTOR_ID,
        roomId: ROOM_ID,
        notes: "Bring stool sample",
        practiceId: PRACTICE_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        source: "dashboard",
      })
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      "appointments.create"
    );
  });

  it("infers and persists the client when creating a patient-only appointment", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [{ id: CLIENT_ID }],
      ],
      insertedRows: [
        {
          id: APPOINTMENT_ID,
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          status: "scheduled",
        },
      ],
    });

    await expect(
      callerWithDb(db).create({
        patientId: PATIENT_ID,
        startTime,
        endTime,
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        source: "dashboard",
      })
    );
  });

  it("rejects stale or cross-tenant status updates", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid appointment status transitions before writing", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "checked_out" }]],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "scheduled",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("refuses to restore a cancelled appointment into an occupied resource", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "cancelled",
            doctorId: DOCTOR_ID,
            roomId: ROOM_ID,
            locationId: LOCATION_ID,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
          },
        ],
        [
          {
            id: FUTURE_APPOINTMENT_ID,
            status: "confirmed",
            doctorId: DOCTOR_ID,
            roomId: null,
            locationId: LOCATION_ID,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "scheduled",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects direct checkout so closeout gates cannot be bypassed", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "in_exam" }]],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_out",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Review and complete the visit closeout before checking out this appointment.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("blocks confirmation when the appointment type requires an unassigned doctor", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            doctorId: null,
            typeRequiresDoctor: 1,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "confirmed",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Assign a doctor before confirming this appointment.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("blocks direct check-in when the appointment type requires an unassigned doctor", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            doctorId: null,
            typeRequiresDoctor: 1,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Assign a doctor before checking in this appointment.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("confirms a doctor-required appointment after a doctor is assigned", async () => {
    const scheduledStateUpdatedAt = new Date("2026-06-30T18:00:00.000Z");
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            doctorId: DOCTOR_ID,
            clientId: CLIENT_ID,
            startTime: new Date(startTime),
            updatedAt: scheduledStateUpdatedAt,
            typeRequiresDoctor: 1,
          },
        ],
        [{ id: CLIENT_ID, phone: "555-0100", email: "client@example.com" }],
        [],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "confirmed",
          doctorId: DOCTOR_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "confirmed",
        confirmationContactMethod: "phone",
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "confirmed",
      doctorId: DOCTOR_ID,
    });
    expect(updateSet).toHaveBeenCalledWith({ status: "confirmed" });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "phone",
        direction: "outbound",
        subject: "Appointment confirmation recorded",
        status: "sent",
        assignedTo: USER_ID,
        dedupeKey: `appointment-confirmation:v1:${PRACTICE_ID}:${APPOINTMENT_ID}:${scheduledStateUpdatedAt.getTime()}`,
      })
    );
  });

  it("requires an explicit client contact record before confirming", async () => {
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            doctorId: DOCTOR_ID,
            clientId: CLIENT_ID,
            startTime: new Date(startTime),
            updatedAt: new Date("2026-06-30T18:00:00.000Z"),
            typeRequiresDoctor: 0,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "confirmed",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Contact the client and record phone or email confirmation before confirming this appointment.",
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires the selected confirmation channel to exist on the active client", async () => {
    const { db, updateSet, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            doctorId: DOCTOR_ID,
            clientId: CLIENT_ID,
            startTime: new Date(startTime),
            updatedAt: new Date("2026-06-30T18:00:00.000Z"),
            typeRequiresDoctor: 0,
          },
        ],
        [{ id: CLIENT_ID, phone: null, email: "client@example.com" }],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "confirmed",
        confirmationContactMethod: "phone",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Add a client phone number or record email confirmation instead.",
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not cancel or reopen a clinically finalized visit", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: APPOINTMENT_ID, status: "in_exam" }],
        [{ id: "closeout", status: "clinical_finalized" }],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "cancelled",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Clinical handoff is finalized. Complete the visit through closeout instead of changing its status.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("updates appointment status through allowed workflow transitions", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "scheduled" }]],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "checked_in",
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          typeId: TYPE_ID,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
        },
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "checked_in",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "checked_in" });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.checked_in",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        status: "checked_in",
        previousStatus: "scheduled",
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        doctorId: DOCTOR_ID,
        source: "dashboard",
      })
    );
  });

  it("emits appointment.cancelled for cancellation status transitions", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "confirmed" }]],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "cancelled",
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          typeId: TYPE_ID,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
        },
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "cancelled",
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "cancelled",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "cancelled" });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.cancelled",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        status: "cancelled",
        previousStatus: "confirmed",
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        doctorId: DOCTOR_ID,
        source: "dashboard",
      })
    );
  });

  it("does not dispatch checked-in webhooks for later workflow transitions", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            activePatientId: PATIENT_ID,
            activeClientId: CLIENT_ID,
          },
        ],
      ],
      updatedRows: [{ id: APPOINTMENT_ID, status: "in_exam" }],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "in_exam",
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "in_exam",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "in_exam" });
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("blocks an exam from starting without an active matched patient and client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: null,
            clientId: CLIENT_ID,
            activePatientId: null,
            activeClientId: CLIENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "in_exam",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Attach an active patient and matching client before starting the exam.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("attaches an active patient and its matching client under the appointment lock", async () => {
    const updated = {
      id: APPOINTMENT_ID,
      status: "checked_in",
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
    };
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: null,
            clientId: CLIENT_ID,
          },
        ],
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      ],
      updatedRows: [updated],
    });

    await expect(
      callerWithDb(db).attachPatient({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
      })
    ).resolves.toEqual(updated);
    expect(updateSet).toHaveBeenCalledWith({
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
    });
  });

  it("does not attach a patient owned by a different appointment client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: null,
            clientId: CLIENT_ID,
          },
        ],
        [{ id: PATIENT_ID, clientId: OTHER_CLIENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).attachPatient({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Choose a patient belonging to the client already attached to this appointment.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not silently retarget an appointment that already has a patient", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: "00000000-0000-0000-0000-000000000044",
            clientId: CLIENT_ID,
          },
        ],
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).attachPatient({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "This appointment already has a patient. Do not silently retarget a clinical visit.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not attach a patient to a terminal appointment", async () => {
    const { db, select, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "cancelled",
            patientId: null,
            clientId: CLIENT_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).attachPatient({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("fails closed if the appointment changes while attaching a patient", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "checked_in",
            patientId: null,
            clientId: CLIENT_ID,
          },
        ],
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).attachPatient({
        id: APPOINTMENT_ID,
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Appointment changed while attaching the patient. Refresh and retry.",
    });
    expect(updateSet).toHaveBeenCalledTimes(1);
  });

  it("rejects appointment status races after transition validation", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "scheduled" }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).toHaveBeenCalledWith({ status: "checked_in" });
  });

  it("rejects missing or cross-tenant recurring series cancellations", async () => {
    const { db, updateSet } = createDb({
      updateResults: [[]],
    });

    await expect(
      callerWithDb(db).cancelRecurringSeries({
        seriesId: SERIES_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({
      deletedAt: expect.any(Date),
    });
  });

  it("cancels active future appointments when ending a recurring series", async () => {
    const { db, transaction, updateSet } = createDb({
      updateResults: [
        [{ id: SERIES_ID }],
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            status: "cancelled",
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: DOCTOR_ID,
            typeId: TYPE_ID,
            recurringSeriesId: SERIES_ID,
          },
          {
            id: FUTURE_APPOINTMENT_ID,
            startTime: new Date("2026-07-08T14:00:00.000Z"),
            endTime: new Date("2026-07-08T14:30:00.000Z"),
            status: "cancelled",
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: DOCTOR_ID,
            typeId: TYPE_ID,
            recurringSeriesId: SERIES_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).cancelRecurringSeries({
        seriesId: SERIES_ID,
      })
    ).resolves.toEqual({ seriesId: SERIES_ID, cancelledCount: 2 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenNthCalledWith(1, {
      deletedAt: expect.any(Date),
    });
    expect(updateSet).toHaveBeenNthCalledWith(2, {
      status: "cancelled",
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.cancelled",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        recurringSeriesId: SERIES_ID,
        source: "recurring_series",
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.cancelled",
      expect.objectContaining({
        id: FUTURE_APPOINTMENT_ID,
        appointmentId: FUTURE_APPOINTMENT_ID,
        recurringSeriesId: SERIES_ID,
        source: "recurring_series",
      })
    );
  });

  it("emits appointment.rescheduled after moving an active appointment", async () => {
    const previousStartTime = new Date("2026-07-01T13:00:00.000Z");
    const previousEndTime = new Date("2026-07-01T13:30:00.000Z");
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            startTime: previousStartTime,
            endTime: previousEndTime,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: null,
            roomId: null,
            typeId: TYPE_ID,
          },
        ],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "scheduled",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: null,
          roomId: null,
          typeId: TYPE_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        startTime,
        endTime,
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "scheduled",
      startTime: new Date(startTime),
      endTime: new Date(endTime),
    });

    expect(updateSet).toHaveBeenCalledWith({
      startTime: expect.any(Date),
      endTime: expect.any(Date),
      doctorId: null,
      roomId: null,
      locationId: LOCATION_ID,
      status: "scheduled",
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.rescheduled",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        previousStartTime,
        previousEndTime,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        status: "scheduled",
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        typeId: TYPE_ID,
        source: "dashboard",
      })
    );
  });

  it("requires replacement doctors to belong to the practice when rescheduling", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            doctorId: null,
            roomId: null,
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        doctorId: DOCTOR_ID,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("assigns a practice doctor and room while reviewing a scheduled request", async () => {
    const previousStartTime = new Date("2026-07-01T13:00:00.000Z");
    const previousEndTime = new Date("2026-07-01T13:30:00.000Z");
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            startTime: previousStartTime,
            endTime: previousEndTime,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: null,
            roomId: null,
            typeId: TYPE_ID,
          },
        ],
        [{ id: DOCTOR_ID }],
        [{ id: ROOM_ID }],
        [],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "scheduled",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          roomId: ROOM_ID,
          typeId: TYPE_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        doctorId: DOCTOR_ID,
        roomId: ROOM_ID,
        startTime,
        endTime,
      })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      doctorId: DOCTOR_ID,
      roomId: ROOM_ID,
    });
    expect(updateSet).toHaveBeenCalledWith({
      startTime: expect.any(Date),
      endTime: expect.any(Date),
      doctorId: DOCTOR_ID,
      roomId: ROOM_ID,
      locationId: LOCATION_ID,
      status: "scheduled",
    });
  });

  it("does not unassign the doctor from a confirmed doctor-required appointment", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            doctorId: DOCTOR_ID,
            roomId: ROOM_ID,
            typeId: TYPE_ID,
            typeRequiresDoctor: 1,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        doctorId: null,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Assign a doctor before saving a confirmed appointment.",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("returns a moved confirmed appointment to requested status", async () => {
    const previousStartTime = new Date("2026-07-01T13:00:00.000Z");
    const previousEndTime = new Date("2026-07-01T13:30:00.000Z");
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: previousStartTime,
            endTime: previousEndTime,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: DOCTOR_ID,
            roomId: ROOM_ID,
            typeId: TYPE_ID,
            typeRequiresDoctor: 1,
          },
        ],
        [],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "scheduled",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          roomId: ROOM_ID,
          typeId: TYPE_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).reschedule({ id: APPOINTMENT_ID, startTime, endTime })
    ).resolves.toMatchObject({
      id: APPOINTMENT_ID,
      status: "scheduled",
      confirmationRequired: true,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "scheduled" })
    );
  });

  it("requires fresh confirmation when a confirmed visit changes clinic location", async () => {
    const previousLocationId = "00000000-0000-0000-0000-00000000000b";
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            locationId: previousLocationId,
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: DOCTOR_ID,
            roomId: null,
            typeId: TYPE_ID,
            typeRequiresDoctor: 1,
          },
        ],
        [],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "scheduled",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          locationId: LOCATION_ID,
          doctorId: DOCTOR_ID,
          roomId: null,
        },
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        locationId: LOCATION_ID,
        startTime,
        endTime,
      })
    ).resolves.toMatchObject({
      status: "scheduled",
      locationId: LOCATION_ID,
      confirmationRequired: true,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "scheduled",
        locationId: LOCATION_ID,
      })
    );
  });

  it("keeps confirmation for a resource-only edit", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            patientId: PATIENT_ID,
            clientId: CLIENT_ID,
            doctorId: DOCTOR_ID,
            roomId: null,
            typeId: TYPE_ID,
            typeRequiresDoctor: 1,
          },
        ],
        [{ id: ROOM_ID }],
        [],
      ],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "confirmed",
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          patientId: PATIENT_ID,
          clientId: CLIENT_ID,
          doctorId: DOCTOR_ID,
          roomId: ROOM_ID,
          typeId: TYPE_ID,
        },
      ],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        roomId: ROOM_ID,
        startTime,
        endTime,
      })
    ).resolves.toMatchObject({
      status: "confirmed",
      confirmationRequired: false,
    });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "confirmed", roomId: ROOM_ID })
    );
  });

  it.each(["checked_in", "in_exam", "checked_out", "no_show", "cancelled"] as const)(
    "rejects rescheduling %s appointments",
    async (status) => {
      const { db, updateSet } = createDb({
        selectResults: [
          [{ id: APPOINTMENT_ID, status, doctorId: DOCTOR_ID, roomId: ROOM_ID }],
        ],
      });

      await expect(
        callerWithDb(db).reschedule({
          id: APPOINTMENT_ID,
          startTime,
          endTime,
        })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only scheduled or confirmed appointments can be rescheduled.",
      });

      expect(updateSet).not.toHaveBeenCalled();
    }
  );

  it("rejects reschedule races when appointment status changes after validation", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            doctorId: null,
            roomId: null,
          },
        ],
        [],
      ],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).reschedule({
        id: APPOINTMENT_ID,
        doctorId: null,
        startTime,
        endTime,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).toHaveBeenCalledWith({
      startTime: expect.any(Date),
      endTime: expect.any(Date),
      doctorId: null,
      roomId: null,
      locationId: LOCATION_ID,
      status: "scheduled",
    });
  });

  it("requires selected availability resources to belong before calculating slots", async () => {
    const doctorDb = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }], []],
    });
    await expect(
      callerWithDb(doctorDb.db).availableSlots({
        date: "2026-07-01",
        doctorId: DOCTOR_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const roomDb = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }], []],
    });
    await expect(
      callerWithDb(roomDb.db).availableSlots({
        date: "2026-07-01",
        roomId: ROOM_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("calculates available slots from the practice-local workday", async () => {
    const { db } = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }], []],
    });

    const slots = await callerWithDb(db).availableSlots({
      date: "2026-07-14",
      dayStartHour: 8,
      dayEndHour: 10,
      durationMinutes: 60,
      stepMinutes: 60,
    });

    expect(slots.map((slot) => slot.start.toISOString())).toEqual([
      "2026-07-14T15:00:00.000Z",
      "2026-07-14T16:00:00.000Z",
    ]);
    expect(slots.map((slot) => slot.end.toISOString())).toEqual([
      "2026-07-14T16:00:00.000Z",
      "2026-07-14T17:00:00.000Z",
    ]);
  });

  it("returns the practice timezone for calendar booking controls", async () => {
    const { db } = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }]],
    });

    await expect(callerWithDb(db).calendarSettings()).resolves.toEqual({
      timezone: "America/Los_Angeles",
    });
  });

  it("rejects missing or deleted practice settings for calendar controls", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(callerWithDb(db).calendarSettings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("requires recurring appointments to validate targets before creating a series", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: 1,
        occurrences: 3,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("infers the client when creating recurring patient-only appointments", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [{ id: CLIENT_ID }],
        [{ timezone: "America/Los_Angeles" }],
      ],
      insertedRows: [{ id: SERIES_ID }],
    });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: 1,
        occurrences: 1,
      })
    ).resolves.toEqual({ seriesId: SERIES_ID, created: 1, skipped: 0 });

    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        recurringSeriesId: SERIES_ID,
      })
    );
  });

  it("creates recurring appointments with normalized notes", async () => {
    const { db, insertValues, transaction } = createDb({
      selectResults: [
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [{ id: CLIENT_ID }],
        [{ timezone: "America/Los_Angeles" }],
      ],
      insertedRows: [{ id: SERIES_ID }],
    });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime,
        endTime,
        frequency: "weekly",
        interval: 1,
        occurrences: 2,
        notes: " Follow-up recheck ",
      })
    ).resolves.toEqual({ seriesId: SERIES_ID, created: 2, skipped: 0 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        frequency: "weekly",
        interval: 1,
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        notes: "Follow-up recheck",
        recurringSeriesId: SERIES_ID,
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        notes: "Follow-up recheck",
        recurringSeriesId: SERIES_ID,
      })
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      "appointments.createRecurring"
    );
  });

  it("creates recurring appointments from the practice wall clock across DST", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [{ id: CLIENT_ID }],
        [{ timezone: "America/Los_Angeles" }],
      ],
      insertedRows: [{ id: SERIES_ID }],
    });

    await expect(
      callerWithDb(db).createRecurring({
        patientId: PATIENT_ID,
        clientId: CLIENT_ID,
        startTime: "2026-03-08T07:30:00.000Z",
        endTime: "2026-03-08T08:00:00.000Z",
        frequency: "weekly",
        interval: 1,
        occurrences: 2,
      })
    ).resolves.toEqual({ seriesId: SERIES_ID, created: 2, skipped: 0 });

    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        endDate: "2026-03-14",
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        startTime: new Date("2026-03-08T07:30:00.000Z"),
        endTime: new Date("2026-03-08T08:00:00.000Z"),
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        startTime: new Date("2026-03-15T06:30:00.000Z"),
        endTime: new Date("2026-03-15T07:00:00.000Z"),
      })
    );
  });
});

describe("appointments display join scoping", () => {
  const source = readFileSync(
    new URL("../routers/appointments.ts", import.meta.url),
    "utf8"
  );

  it("keeps joined patient, client, type, and room rows tenant scoped and active", () => {
    for (const [table, foreignKey] of [
      ["clients", "appointments.clientId"],
      ["appointmentTypes", "appointments.typeId"],
      ["rooms", "appointments.roomId"],
    ]) {
      expect(source).toMatch(
        new RegExp(
          `leftJoin\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
            ".",
            "\\."
          )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, ctx\\.practiceId\\),\\s*isNull\\(${table}\\.deletedAt\\)\\s*\\)\\s*\\)`,
          "s"
        )
      );
    }
  });

  it("keeps historical doctor attribution tenant scoped after deactivation", () => {
    expect(source).toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(appointments\.doctorId, users\.id\),\s*eq\(users\.practiceId, ctx\.practiceId\)\s*\)\s*\)/s
    );
    expect(source).not.toMatch(
      /eq\(appointments\.doctorId, users\.id\)[\s\S]{0,120}?isNull\(users\.deletedAt\)/s
    );
  });

  it("keeps displayed patients tied to the appointment client", () => {
    const joins = source.match(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(appointments\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointments\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/gs
    );

    expect(joins?.length).toBeGreaterThanOrEqual(2);
  });

  it("locks only the appointment row during joined status transitions", () => {
    expect(source).toMatch(
      /updateStatus:[\s\S]*?leftJoin\([\s\S]*?appointmentTypes[\s\S]*?\.for\("update", \{ of: appointments \}\)/,
    );
  });

  it("uses the practice timezone when calculating available slots", () => {
    expect(source).toContain("const timezone = await practiceTimeZone(ctx)");
    expect(source).toContain("return practice.timezone ?? null");
    expect(source).not.toContain("practice?.timezone");
    expect(source).toContain("dateInputTimeUtcInstant(");
    expect(source).not.toContain("dateAtUtcHour");
  });

  it("uses the practice timezone for date-only list ranges", () => {
    expect(source).toContain("const range = await appointmentListRange(ctx, input)");
    expect(source).toContain("dateInputDayUtcRange(value, timeZone).start");
    expect(source).toContain("return new Date(end.getTime() - 1)");
  });

  it("requires an active practice for schedule reads, writes, and resource lookups", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain('message: "Practice not found"');
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(14);
    expect(source).toContain("activePracticePredicate(practiceId)");
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(recurringSeries\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(recurringSeries\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(clients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(clients\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(users\.practiceId, ctx\.practiceId\),\s+eq\(users\.isVeterinarian, true\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(users\.deletedAt\)/
    );
  });

  it("exposes and safely cancels recurring series from schedule appointments", () => {
    const recurringSeriesSelects = source.match(
      /recurringSeriesId: appointments\.recurringSeriesId/g
    );

    expect(recurringSeriesSelects?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("cancelRecurringSeries: protectedProcedure");
    expect(source).toContain("eq(recurringSeries.practiceId, ctx.practiceId)");
    expect(source).toContain("eq(appointments.recurringSeriesId, input.seriesId)");
    expect(source).toContain(
      'inArray(appointments.status, ["scheduled", "confirmed"])'
    );
    expect(source).toContain("gte(appointments.startTime, now)");
  });

  it("creates recurring appointments from the practice timezone wall clock", () => {
    expect(source).toContain("const timezone = await practiceTimeZone(txCtx)");
    expect(source).toContain("resolveRecurrenceTimeZone");
    expect(source).toContain("recurrenceBaseParts");
    expect(source).toContain("dateInputTimeUtcInstant(");
    expect(source).toContain(
      "formatDateInputForTimeZone(\n              lastOccurrenceDate"
    );
    expect(source).not.toContain(
      'lastOccurrenceDate.toISOString().split("T")[0]'
    );
  });
});
