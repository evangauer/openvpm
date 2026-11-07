import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchCreated: vi.fn(async () => undefined),
  recordActivation: vi.fn(async () => undefined),
  resolveLocation: vi.fn(async () => ({
    ok: true as const,
    locationId: "00000000-0000-0000-0000-000000000010",
  })),
}));

vi.mock("@/lib/appointment-webhooks", () => ({
  appointmentCreatedWebhookPayload: (appointment: { id: string }) => ({
    id: appointment.id,
    source: "dashboard",
  }),
  dispatchAppointmentWebhookAfterCommit: mocks.dispatchCreated,
}));

vi.mock("@/lib/funnel-events-server", () => ({
  recordActivationAfterAppointmentCreated: mocks.recordActivation,
}));

vi.mock("@/lib/scheduling/location", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/scheduling/location")>();
  return { ...original, resolveAppointmentLocation: mocks.resolveLocation };
});

const { appointmentsRouter } = await import("../routers/appointments");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const CLIENT_ID = "00000000-0000-0000-0000-000000000003";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000004";
const LOCATION_ID = "00000000-0000-0000-0000-000000000010";

function callerWithDb(
  db: Record<string, unknown>,
  role: "admin" | "veterinarian" | "technician" | "front_desk" = "veterinarian",
) {
  return appointmentsRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: `${role}@example.test`,
        name: "Field Clinician",
        role,
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

function createDb(selectResults: unknown[][], insertedRows: unknown[] = []) {
  const remaining = [...selectResults];
  const select = vi.fn(() => queryChain(remaining.shift() ?? []));
  const insertValues = vi.fn(() => ({
    returning: vi.fn(async () => insertedRows),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = { select, insert, execute };
  db.transaction = vi.fn(async (run: (tx: typeof db) => unknown) => run(db));
  return { db, select, insert, insertValues, execute };
}

const enabledSettings = {
  ambulatoryWorkspace: {
    enabled: true,
    measurementSystem: "us_customary",
    bodyConditionScale: 5,
    compactCloseout: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("appointments.startFieldVisit", () => {
  it("does not reach the database while the deployment rollout is dark", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "false");
    const { db, select, insert } = createDb([]);

    await expect(
      callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed until the practice explicitly enables field workflow", async () => {
    const { db, select, insert } = createDb([[{ settings: null }]]);

    await expect(
      callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(select).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects non-clinical roles before starting a transaction", async () => {
    const { db, insert } = createDb([]);

    await expect(
      callerWithDb(db, "front_desk").startFieldVisit({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("reuses the existing open patient encounter without duplicate writes", async () => {
    const { db, insert, execute } = createDb([
      [{ settings: enabledSettings }],
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [{ id: APPOINTMENT_ID, origin: "field" }],
    ]);

    await expect(
      callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
    ).resolves.toEqual({
      appointment: { id: APPOINTMENT_ID },
      created: false,
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.recordActivation).not.toHaveBeenCalled();
    expect(mocks.dispatchCreated).not.toHaveBeenCalled();
  });

  it("refuses to relabel or silently resume an active scheduled visit", async () => {
    const { db, insert } = createDb([
      [{ settings: enabledSettings }],
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [{ id: APPOINTMENT_ID, origin: "scheduled" }],
    ]);

    await expect(
      callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(insert).not.toHaveBeenCalled();
    expect(mocks.recordActivation).not.toHaveBeenCalled();
    expect(mocks.dispatchCreated).not.toHaveBeenCalled();
  });

  it("creates a field-origin encounter with canonical visit state", async () => {
    const start = new Date("2026-09-02T14:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const appointment = {
      id: APPOINTMENT_ID,
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
      doctorId: USER_ID,
      locationId: LOCATION_ID,
      startTime: start,
      endTime: new Date("2026-09-02T14:30:00.000Z"),
      status: "in_exam",
      origin: "field",
    };
    const { db, insertValues, execute } = createDb(
      [
        [{ settings: enabledSettings }],
        [{ id: PATIENT_ID, clientId: CLIENT_ID }],
        [],
        [{ isVeterinarian: true }],
        [],
      ],
      [appointment],
    );

    try {
      await expect(
        callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
      ).resolves.toEqual({ appointment, created: true });
    } finally {
      vi.useRealTimers();
    }

    expect(execute).toHaveBeenCalledTimes(4);
    expect(mocks.resolveLocation).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        doctorId: USER_ID,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
      doctorId: USER_ID,
      locationId: LOCATION_ID,
      startTime: start,
      endTime: new Date("2026-09-02T14:30:00.000Z"),
      status: "in_exam",
      origin: "field",
    });
    expect(mocks.recordActivation).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      "appointments.startFieldVisit",
    );
    expect(mocks.dispatchCreated).toHaveBeenCalledTimes(1);
  });

  it("serializes field starts with scheduling and refuses provider overlap", async () => {
    const start = new Date("2026-09-02T14:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { db, insert, execute } = createDb([
      [{ settings: enabledSettings }],
      [{ id: PATIENT_ID, clientId: CLIENT_ID }],
      [],
      [{ isVeterinarian: true }],
      [
        {
          id: "00000000-0000-0000-0000-000000000099",
          doctorId: USER_ID,
          roomId: null,
          locationId: LOCATION_ID,
          startTime: start,
          endTime: new Date("2026-09-02T15:00:00.000Z"),
          status: "confirmed",
        },
      ],
    ]);

    try {
      await expect(
        callerWithDb(db).startFieldVisit({
          patientId: PATIENT_ID,
          locationId: LOCATION_ID,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      vi.useRealTimers();
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchCreated).not.toHaveBeenCalled();
  });

  it("does not create a visit for a missing or cross-tenant patient", async () => {
    const { db, insert } = createDb([[{ settings: enabledSettings }], []]);

    await expect(
      callerWithDb(db).startFieldVisit({ patientId: PATIENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insert).not.toHaveBeenCalled();
  });
});
