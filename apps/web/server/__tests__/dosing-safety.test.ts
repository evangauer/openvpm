import { afterEach, describe, expect, it, vi } from "vitest";

const { DOSING_WEIGHT_MAX_KG, FORMULARY_DRUG_ID_MAX_LENGTH } = await import(
  "@/lib/dosing"
);
const { dosingRouter } = await import("../routers/dosing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

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
  return dosingRouter.createCaller({ db, session } as never);
}

function createDb() {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
  };
  return { db };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("dosing input safety", () => {
  it("rejects unknown and oversized formulary drug IDs", async () => {
    const { db } = createDb();

    await expect(
      callerWithDb(db).calculate({
        drugId: "not-in-formulary",
        species: "canine",
        weightKg: 10,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).calculate({
        drugId: "A".repeat(FORMULARY_DRUG_ID_MAX_LENGTH + 1),
        species: "canine",
        weightKg: 10,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects implausible dosing weights and non-finite concentrations at the API boundary", async () => {
    const { db } = createDb();

    await expect(
      callerWithDb(db).calculate({
        drugId: "carprofen",
        species: "canine",
        weightKg: DOSING_WEIGHT_MAX_KG + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).calculate({
        drugId: "maropitant",
        species: "canine",
        weightKg: 10,
        concentrationMgPerMl: Number.POSITIVE_INFINITY,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("normalizes valid formulary IDs before calculating", async () => {
    const { db } = createDb();

    await expect(
      callerWithDb(db).calculate({
        drugId: " carprofen ",
        species: "canine",
        weightKg: 10,
      })
    ).resolves.toMatchObject({
      drug: { id: "carprofen" },
      doseLowMg: 22,
      doseHighMg: 44,
    });
  });
});
