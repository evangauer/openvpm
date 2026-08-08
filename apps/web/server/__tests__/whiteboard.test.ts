import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

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

const { whiteboardRouter } = await import("../routers/whiteboard");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000002";

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
  return whiteboardRouter.createCaller({ db, session } as never);
}

function createSelectDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, select };
}

function createStatusDb(opts?: {
  selectResults?: unknown[][];
  updatedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      for: vi.fn(async () => result),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    return builder;
  });

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
  };
  return { db, select, updateSet };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("whiteboard workflows", () => {
  const startTime = "2026-07-01T14:00:00.000Z";
  const endTime = "2026-07-01T14:30:00.000Z";

  it("lists active appointments for the practice-local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, select } = createSelectDb([
      [
        {
          name: "Neighborhood Veterinary",
          phone: "555-0100",
          timezone: "America/Los_Angeles",
        },
      ],
      [
        {
          id: APPOINTMENT_ID,
          status: "checked_in",
          startTime: new Date("2026-07-15T01:30:00.000Z"),
          notes: "Needs room",
          patientName: "Miso",
          patientSpecies: "canine",
          patientPhotoUrl: null,
          clientFirstName: "Ada",
          clientLastName: "Lovelace",
          doctorName: "Dr. Ames",
          roomName: "Exam 1",
          typeName: "Wellness",
          typeColor: "#0f766e",
        },
      ],
    ]);

    await expect(callerWithDb(db).getActive()).resolves.toEqual([
      expect.objectContaining({
        id: APPOINTMENT_ID,
        status: "checked_in",
        patientName: "Miso",
        clientFirstName: "Ada",
        clientLastName: "Lovelace",
      }),
    ]);

    expect(select).toHaveBeenCalledTimes(2);
  });

  it("returns active practice identity for whiteboard rendering and PDFs", async () => {
    const { db, select } = createSelectDb([
      [
        {
          name: "Neighborhood Veterinary",
          phone: "555-0100",
          timezone: "America/Los_Angeles",
        },
      ],
    ]);

    await expect(callerWithDb(db).settings()).resolves.toEqual({
      name: "Neighborhood Veterinary",
      phone: "555-0100",
      timezone: "America/Los_Angeles",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or deleted practice settings before rendering whiteboard data", async () => {
    const { db, select } = createSelectDb([[]]);

    await expect(callerWithDb(db).settings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects active whiteboard reads when the practice is missing or deleted", async () => {
    const { db, select } = createSelectDb([[]]);

    await expect(callerWithDb(db).getActive()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("updates appointment status through allowed workflow transitions", async () => {
    const { db, updateSet } = createStatusDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "confirmed" }]],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "checked_in",
          patientId: "00000000-0000-0000-0000-000000000003",
          clientId: "00000000-0000-0000-0000-000000000004",
          doctorId: "00000000-0000-0000-0000-000000000005",
          typeId: "00000000-0000-0000-0000-000000000006",
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
    ).resolves.toMatchObject({ id: APPOINTMENT_ID, status: "checked_in" });

    expect(updateSet).toHaveBeenCalledWith({ status: "checked_in" });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.checked_in",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        status: "checked_in",
        previousStatus: "confirmed",
        patientId: "00000000-0000-0000-0000-000000000003",
        clientId: "00000000-0000-0000-0000-000000000004",
        doctorId: "00000000-0000-0000-0000-000000000005",
        source: "dashboard",
      })
    );
  });

  it("emits appointment.cancelled when whiteboard status cancels an appointment", async () => {
    const { db, updateSet } = createStatusDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "confirmed" }]],
      updatedRows: [
        {
          id: APPOINTMENT_ID,
          status: "cancelled",
          patientId: "00000000-0000-0000-0000-000000000003",
          clientId: "00000000-0000-0000-0000-000000000004",
          doctorId: "00000000-0000-0000-0000-000000000005",
          typeId: "00000000-0000-0000-0000-000000000006",
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
    ).resolves.toMatchObject({ id: APPOINTMENT_ID, status: "cancelled" });

    expect(updateSet).toHaveBeenCalledWith({ status: "cancelled" });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.cancelled",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        appointmentId: APPOINTMENT_ID,
        status: "cancelled",
        previousStatus: "confirmed",
        patientId: "00000000-0000-0000-0000-000000000003",
        clientId: "00000000-0000-0000-0000-000000000004",
        doctorId: "00000000-0000-0000-0000-000000000005",
        source: "dashboard",
      })
    );
  });

  it("does not dispatch checked-in webhooks after the check-in transition", async () => {
    const { db, updateSet } = createStatusDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "checked_in" }]],
      updatedRows: [{ id: APPOINTMENT_ID, status: "in_exam" }],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "in_exam",
      })
    ).resolves.toMatchObject({ id: APPOINTMENT_ID, status: "in_exam" });

    expect(updateSet).toHaveBeenCalledWith({ status: "in_exam" });
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects missing, deleted, or cross-tenant appointments", async () => {
    const { db, updateSet } = createStatusDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects invalid appointment status transitions before writing", async () => {
    const { db, updateSet } = createStatusDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "checked_out" }]],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "scheduled",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot change appointment status from checked_out to scheduled.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects direct checkout so closeout gates cannot be bypassed", async () => {
    const { db, updateSet } = createStatusDb({
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

  it("rejects appointment status races after transition validation", async () => {
    const { db, updateSet } = createStatusDb({
      selectResults: [[{ id: APPOINTMENT_ID, status: "confirmed" }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).updateStatus({
        id: APPOINTMENT_ID,
        status: "checked_in",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Appointment status changed; try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "checked_in" });
  });
});

describe("whiteboard query scoping", () => {
  const source = readFileSync(
    new URL("../routers/whiteboard.ts", import.meta.url),
    "utf8"
  );

  it("fails closed when the active practice row is missing", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("if (!practice)");
    expect(source).not.toContain("practice?.name");
    expect(source).not.toContain("practice?.timezone");
  });

  it("keeps joined appointment display rows tenant scoped and active", () => {
    for (const [table, foreignKey] of [
      ["clients", "appointments.clientId"],
      ["users", "appointments.doctorId"],
      ["appointmentTypes", "appointments.typeId"],
      ["rooms", "appointments.roomId"],
    ]) {
      expect(source).toMatch(
        new RegExp(
          `leftJoin\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
            ".",
            "\\."
          )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, ctx\\.practiceId\\),\\s*activePracticePredicate\\(ctx\\.practiceId\\),\\s*isNull\\(${table}\\.deletedAt\\)\\s*\\)\\s*\\)`,
          "s"
        )
      );
    }
  });

  it("keeps displayed patients tied to the appointment client", () => {
    expect(source).toMatch(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(appointments\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointments\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/s
    );
  });

  it("requires staff roles for whiteboard status updates", () => {
    expect(source).toContain(
      '.use(requireRole("admin", "veterinarian", "technician", "front_desk"))'
    );
  });

  it("uses the shared appointment status workflow guard for updates", () => {
    expect(source).toContain("canTransitionAppointmentStatus");
    expect(source).toContain("eq(appointments.status, current.status)");
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s*eq\(appointments\.status, current\.status\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(appointments\.deletedAt\)/
    );
    expect(source).toContain("Appointment status changed; try again.");
  });

  it("uses the practice timezone for the active whiteboard day", () => {
    expect(source).toContain("async function practiceTimeZone");
    expect(source).toContain("async function practiceDayRange");
    expect(source).toContain(
      "dateInputUtcRangeForTimeZone(new Date(), await practiceTimeZone(ctx))"
    );
    expect(source).toContain("async function practiceSettings");
    expect(source).toContain("settings: protectedProcedure.query");
    expect(source).toContain("settings: protectedProcedure.query(async ({ ctx }) => practiceSettings(ctx))");
    expect(source).toContain("const today = await practiceDayRange(ctx)");
    expect(source).toContain("gte(appointments.startTime, today.start)");
    expect(source).toContain("lt(appointments.startTime, today.end)");
    expect(source).not.toContain("setHours(0, 0, 0, 0)");
    expect(source).not.toContain("setHours(23, 59, 59, 999)");
  });
});
