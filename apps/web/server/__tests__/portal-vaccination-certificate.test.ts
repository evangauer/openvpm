import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-07-01T12:15:00Z"),
  })),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: () => false,
  hasHostedFullAccess: () => true,
}));

const { portalRouter } = await import("../routers/portal");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const VACCINATION_ID = "00000000-0000-0000-0000-000000000003";

function createDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(async () => result);
    return builder;
  });
  const db: Record<string, unknown> = {
    select,
    execute: vi.fn(async () => undefined),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return db;
}

function certificateDb(recordRows: unknown[]) {
  return createDb([
    [
      {
        id: CLIENT_ID,
        practiceId: PRACTICE_ID,
        firstName: "Alex",
        lastName: "Rivera",
      },
    ],
    [{ id: PRACTICE_ID }],
    [
      {
        name: "Veterinary Practice",
        address: "100 Clinic Way",
        phone: "555-0100",
        email: "care@example.test",
        timezone: "America/Denver",
      },
    ],
    recordRows,
  ]);
}

function portalCaller(db: ReturnType<typeof certificateDb>) {
  return portalRouter.createCaller({
    db,
    ip: "203.0.113.10",
    portalSessionId: "00000000-0000-0000-0000-000000000004",
    portalClient: {
      id: CLIENT_ID,
      practiceId: PRACTICE_ID,
      firstName: "Alex",
      lastName: "Rivera",
      email: "alex@example.test",
      phone: null,
    },
  } as never);
}

afterEach(() => vi.clearAllMocks());

describe("portal vaccination certificate authorization", () => {
  it("returns only click-time authorized patient, practice, and dose data", async () => {
    const db = certificateDb([
      {
        patientName: "Biscuit",
        species: "canine",
        breed: "Mixed",
        sex: "female_spayed",
        dob: "2020-05-01",
        color: "Brown",
        vaccinationRecordId: VACCINATION_ID,
        vaccineName: "Rabies",
        lotNumber: "LOT-1",
        manufacturer: "VaxCo",
        administeredAt: new Date("2026-06-01T16:00:00Z"),
        nextDueDate: "2027-06-01",
      },
    ]);

    await expect(
      portalCaller(db).getVaccinationCertificateData({
          token: "portal-token",
          patientId: PATIENT_ID,
          vaccinationRecordId: VACCINATION_ID,
        }),
    ).resolves.toMatchObject({
      practice: { name: "Veterinary Practice", timezone: "America/Denver" },
      clientName: "Alex Rivera",
      patient: { name: "Biscuit", species: "canine" },
      vaccination: { id: VACCINATION_ID, vaccineName: "Rabies" },
    });
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it("blocks a missing, corrected, wrong-patient, or cross-tenant dose uniformly", async () => {
    const db = certificateDb([]);

    await expect(
      portalCaller(db).getVaccinationCertificateData({
          token: "portal-token",
          patientId: PATIENT_ID,
          vaccinationRecordId: VACCINATION_ID,
        }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Vaccination certificate is not available",
    });
  });
});
