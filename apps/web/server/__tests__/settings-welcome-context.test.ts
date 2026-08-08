import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-07-08T00:00:00Z").toISOString(),
    locationCount: 1,
    billableSeatCount: 1,
  })),
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_CLIENT_ID = "00000000-0000-0000-0000-000000000010";
const DEMO_PATIENT_ID = "00000000-0000-0000-0000-000000000011";

function callerWithRole(db: Record<string, unknown>, role: string) {
  const session = {
    user: {
      id: USER_ID,
      email: "staff@example.com",
      name: "Staff",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

/** Sequenced select mock: each select() call consumes the next result set. */
function createDb(selectResults: unknown[][]) {
  const remaining = [...selectResults];
  const select = vi.fn(() => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.orderBy = vi.fn(() => query);
    query.limit = vi.fn(async () => remaining.shift() ?? []);
    return { from: vi.fn(() => query) };
  });
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };
  return { db, select };
}

const practiceRow = (settings: Record<string, unknown>) => ({
  name: "Aspen Creek Animal Hospital",
  settings,
});

const demoSettings = {
  demoData: {
    clientIds: [DEMO_CLIENT_ID],
    patientIds: [DEMO_PATIENT_ID],
    appointmentIds: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings.welcomeContext", () => {
  it("returns the live demo client and patient for a fresh trial", async () => {
    const { db } = createDb([
      [practiceRow(demoSettings)],
      [{ id: DEMO_CLIENT_ID, firstName: "Jordan", lastName: "Avery" }],
      [{ id: DEMO_PATIENT_ID, name: "Biscuit" }],
    ]);

    const result = await callerWithRole(db, "front_desk").welcomeContext();
    expect(result).toEqual({
      practiceName: "Aspen Creek Animal Hospital",
      hasDemoData: true,
      portalClient: {
        id: DEMO_CLIENT_ID,
        firstName: "Jordan",
        lastName: "Avery",
      },
      demoPatientName: "Biscuit",
      demoPatientId: DEMO_PATIENT_ID,
      // The fixture has no invoiceIds, so the tour's bill step falls back.
      demoInvoiceId: null,
    });
  });

  it("falls back to the first real client once demo rows are gone", async () => {
    const { db } = createDb([
      [practiceRow(demoSettings)],
      [], // demo client soft-deleted
      [{ id: "real-1", firstName: "Riley", lastName: "Bennett" }],
      [], // demo patient soft-deleted
    ]);

    const result = await callerWithRole(db, "admin").welcomeContext();
    expect(result.portalClient).toEqual({
      id: "real-1",
      firstName: "Riley",
      lastName: "Bennett",
    });
    expect(result.demoPatientName).toBeNull();
    expect(result.hasDemoData).toBe(true);
  });

  it("returns nulls for an empty practice with no demo data", async () => {
    const { db } = createDb([
      [practiceRow({})],
      [], // fallback client lookup finds nobody
    ]);

    const result = await callerWithRole(db, "technician").welcomeContext();
    expect(result.portalClient).toBeNull();
    expect(result.demoPatientName).toBeNull();
    expect(result.hasDemoData).toBe(false);
  });

  it("is readable by the viewer role (queries are not role-gated)", async () => {
    const { db } = createDb([[practiceRow({})], []]);
    await expect(
      callerWithRole(db, "viewer").welcomeContext()
    ).resolves.toMatchObject({
      practiceName: "Aspen Creek Animal Hospital",
    });
  });

  it("404s when the practice is missing or deleted", async () => {
    const { db } = createDb([[]]);
    await expect(
      callerWithRole(db, "admin").welcomeContext()
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("settings.onboardingStatus", () => {
  it("does not count seeded demo patients as real imported data", async () => {
    const { db } = createDb([
      [{ settings: demoSettings }],
      [{ id: DEMO_PATIENT_ID }],
      [],
      [],
      [],
      [],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({ hasDemoData: true, hasRealData: false });
  });

  it("recognizes real patients while the sample clinic remains available", async () => {
    const { db } = createDb([
      [{ settings: demoSettings }],
      [{ id: DEMO_PATIENT_ID }, { id: "real-patient-1" }],
      [],
      [],
      [],
      [],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({ hasDemoData: true, hasRealData: true });
  });

  it("does not count seeded appointments as a first live appointment", async () => {
    const demoAppointmentId = "00000000-0000-0000-0000-000000000099";
    const { db } = createDb([
      [
        {
          settings: {
            ...demoSettings,
            demoData: {
              ...demoSettings.demoData,
              appointmentIds: [demoAppointmentId],
            },
          },
        },
      ],
      [{ id: DEMO_PATIENT_ID }],
      [],
      [],
      [],
      [],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({
      hasRealAppointment: false,
      hasCompletedRealAppointment: false,
    });
  });

  it("recognizes a completed non-demo appointment", async () => {
    const { db } = createDb([
      [{ settings: demoSettings }],
      [{ id: DEMO_PATIENT_ID }],
      [{ id: "real-appointment-1" }],
      [{ id: "real-appointment-1" }],
      [],
      [],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({
      hasRealAppointment: true,
      hasCompletedRealAppointment: true,
      hasCompletedRealVisit: false,
      nextRealAppointmentId: null,
    });
  });

  it("requires a completed closeout instead of treating legacy checkout as a completed visit", async () => {
    const { db } = createDb([
      [{ settings: demoSettings }],
      [{ id: DEMO_PATIENT_ID }],
      [{ id: "real-appointment-1" }],
      [{ id: "real-appointment-1" }],
      [],
      [{ id: "real-appointment-2" }],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({
      hasCompletedRealAppointment: true,
      hasCompletedRealVisit: false,
      nextRealAppointmentId: "real-appointment-2",
    });
  });

  it("recognizes a completed closeout as the durable first-visit milestone", async () => {
    const { db } = createDb([
      [{ settings: demoSettings }],
      [{ id: DEMO_PATIENT_ID }, { id: "real-patient-1" }],
      [{ id: "real-appointment-1" }],
      [{ id: "real-appointment-1" }],
      [{ id: "closeout-1" }],
      [],
    ]);

    await expect(
      callerWithRole(db, "admin").onboardingStatus()
    ).resolves.toMatchObject({
      hasRealAppointment: true,
      hasCompletedRealAppointment: true,
      hasCompletedRealVisit: true,
      nextRealAppointmentId: null,
    });
  });
});
