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

const { patientsRouter } = await import("../routers/patients");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");
const {
  PATIENT_WEIGHT_MAX_KG,
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_STEP,
  isPatientWeightInputValid,
} = await import("@/lib/records/patient-weight-policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const MERGE_PATIENT_ID = "00000000-0000-0000-0000-000000000004";
const OTHER_CLIENT_ID = "00000000-0000-0000-0000-000000000005";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000006";
const WAITLIST_ID = "00000000-0000-0000-0000-000000000007";
const ALLERGY_ID = "00000000-0000-0000-0000-000000000008";
const MERGE_OPERATION_ID = "00000000-0000-0000-0000-000000000009";
const MERGE_EVENT_ID = "00000000-0000-0000-0000-000000000010";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Patient User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return patientsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
  updatedResults?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(async () => result);
    builder.for = vi.fn(async () => result);
    return builder;
  });

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updatedResults = [...(opts?.updatedResults ?? [])];
  const updateReturning = vi.fn(async () =>
    updatedResults.length > 0
      ? updatedResults.shift()!
      : (opts?.updatedRows ?? []),
  );
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    transaction,
    execute,
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet, transaction, execute };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("patients mutation safety", () => {
  it("keeps patient write actions restricted to non-viewer staff roles", async () => {
    const { db, select, insertValues, updateSet } = createDb();
    const viewer = callerWithDb(db, "viewer");

    await expect(
      viewer.create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.update({
        id: PATIENT_ID,
        name: "Biscuit",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.addWeight({
        patientId: PATIENT_ID,
        weightKg: "12.5",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.addAllergy({
        patientId: PATIENT_ID,
        allergen: "Chicken",
        severity: "mild",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();

    const { db: writableDb } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: CLIENT_ID }]],
      insertedRows: [{ id: PATIENT_ID, name: "Biscuit" }],
    });

    await expect(
      callerWithDb(writableDb, "front_desk").create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
      })
    ).resolves.toMatchObject({ id: PATIENT_ID });
  });

  it("rejects invalid DOB, text, filters, and weights before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "   ",
        species: "canine",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
        dob: "2026-02-30",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
        breed: "b".repeat(129),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        dob: "not-a-date",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        name: "   ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        color: "c".repeat(65),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        photoUrl: "p".repeat(513),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        species: "dragon",
        limit: 25,
        offset: 0,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        limit: 1.5,
        offset: 0,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        search: "s".repeat(129),
        limit: 25,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        limit: 25,
        offset: LIST_OFFSET_MAX + 1,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).search({
        query: "   ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addWeight({
        patientId: PATIENT_ID,
        weightKg: "12.3456",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(PATIENT_WEIGHT_MIN_KG).toBe(0.001);
    expect(PATIENT_WEIGHT_MAX_KG).toBe(99999.999);
    expect(PATIENT_WEIGHT_STEP).toBe(0.001);
    expect(isPatientWeightInputValid("12.345")).toBe(true);
    expect(isPatientWeightInputValid("12.3456")).toBe(false);
    expect(isPatientWeightInputValid("0")).toBe(false);
    expect(isPatientWeightInputValid("100000")).toBe(false);

    await expect(
      callerWithDb(db).addWeight({
        patientId: PATIENT_ID,
        weightKg: "0",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addWeight({
        patientId: PATIENT_ID,
        weightKg: "100000",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addAllergy({
        patientId: PATIENT_ID,
        allergen: "   ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).addAllergy({
        patientId: PATIENT_ID,
        allergen: "Chicken",
        reaction: "r".repeat(2001),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires a tenant-owned client before creating a patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects patient creation before insert when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "Biscuit",
        species: "canine",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("creates a patient only after validating the client belongs to the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], [{ id: CLIENT_ID }]],
      insertedRows: [
        {
          id: PATIENT_ID,
          clientId: CLIENT_ID,
          practiceId: PRACTICE_ID,
          name: "Biscuit",
          species: "canine",
          breed: "Corgi",
          sex: "male_neutered",
          status: "active",
        },
      ],
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        name: "  Biscuit  ",
        species: "canine",
        breed: "  Corgi  ",
        color: "  Tricolor  ",
        microchipNumber: "  985112003001234  ",
      })
    ).resolves.toMatchObject({ id: PATIENT_ID, practiceId: PRACTICE_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        practiceId: PRACTICE_ID,
        name: "Biscuit",
        breed: "Corgi",
        color: "Tricolor",
        microchipNumber: "985112003001234",
      })
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "patient.created",
      expect.objectContaining({
        id: PATIENT_ID,
        clientId: CLIENT_ID,
        name: "Biscuit",
        breed: "Corgi",
        source: "dashboard",
      })
    );
  });

  it("trims patient updates and omits blank optional profile fields", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [{ id: PATIENT_ID, name: "Biscuit" }],
    });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        name: "  Biscuit  ",
        breed: "   ",
        color: "  Tricolor  ",
        microchipNumber: "  985112003001234  ",
        photoUrl: "  https://cdn.example.test/biscuit.jpg  ",
      })
    ).resolves.toMatchObject({ id: PATIENT_ID });

    expect(updateSet).toHaveBeenCalledWith({
      name: "Biscuit",
      breed: undefined,
      color: "Tricolor",
      microchipNumber: "985112003001234",
      photoUrl: "https://cdn.example.test/biscuit.jpg",
    });
  });

  it("requires a tenant-owned patient before adding weight history", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).addWeight({
        patientId: PATIENT_ID,
        weightKg: "12.4",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("trims weight and allergy history before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PATIENT_ID }], [{ id: PATIENT_ID }]],
      insertedRows: [{ id: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).addWeight({
        patientId: PATIENT_ID,
        weightKg: " 12.400 ",
      })
    ).resolves.toMatchObject({ id: PATIENT_ID });

    await expect(
      callerWithDb(db).addAllergy({
        patientId: PATIENT_ID,
        allergen: "  Chicken  ",
        reaction: "  Facial swelling  ",
      })
    ).resolves.toMatchObject({ id: PATIENT_ID });

    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        patientId: PATIENT_ID,
        weightKg: "12.400",
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        patientId: PATIENT_ID,
        allergen: "Chicken",
        reaction: "Facial swelling",
        severity: "moderate",
      })
    );
  });

  it("requires a tenant-owned patient before adding allergy history", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).addAllergy({
        patientId: PATIENT_ID,
        allergen: "Chicken",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("keeps allergy removal restricted to non-viewer staff roles", async () => {
    const { db, select, updateSet } = createDb();

    await expect(
      callerWithDb(db, "viewer").removeAllergy({
        patientId: PATIENT_ID,
        id: ALLERGY_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft deletes allergies for tenant-owned patients only", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PATIENT_ID }]],
      updatedRows: [{ id: ALLERGY_ID }],
    });

    await expect(
      callerWithDb(db, "front_desk").removeAllergy({
        patientId: PATIENT_ID,
        id: ALLERGY_ID,
      })
    ).resolves.toEqual({ ok: true });

    // Soft delete: the row is retired via deletedAt, never hard-deleted.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) })
    );
  });

  it("404s allergy removal when the patient is not tenant-owned", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).removeAllergy({
        patientId: PATIENT_ID,
        id: ALLERGY_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("404s allergy removal when the row is missing or already removed", async () => {
    const { db } = createDb({
      selectResults: [[{ id: PATIENT_ID }]],
      updatedRows: [],
    });

    await expect(
      callerWithDb(db).removeAllergy({
        patientId: PATIENT_ID,
        id: ALLERGY_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects stale or cross-tenant patient updates", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).update({
        id: PATIENT_ID,
        name: "Biscuit",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ name: "Biscuit" });
  });

  it("persists a valid DOB and explicitly clears it with null", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [{ id: PATIENT_ID, name: "Biscuit" }],
    });
    const caller = callerWithDb(db);

    await caller.update({
      id: PATIENT_ID,
      dob: "2021-08-08",
    });
    expect(updateSet).toHaveBeenLastCalledWith({ dob: "2021-08-08" });

    await caller.update({
      id: PATIENT_ID,
      dob: null,
    });
    expect(updateSet).toHaveBeenLastCalledWith({ dob: null });
  });

  it("rejects stale or cross-tenant patient deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).delete({ id: PATIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects patient deletes when active appointments exist", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PATIENT_ID }], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: PATIENT_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects patient deletes when waiting appointment requests exist", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PATIENT_ID }], [], [{ id: WAITLIST_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: PATIENT_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes patients without active scheduling dependencies", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: PATIENT_ID }], [], []],
      updatedRows: [{ id: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).delete({ id: PATIENT_ID })
    ).resolves.toEqual({ success: true });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });

  it("does not delete a patient with retained clinical or prescription history", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PATIENT_ID }],
        [],
        [],
        [{ exists: true }],
      ],
    });

    await expect(callerWithDb(db).delete({ id: PATIENT_ID })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("previews cross-client patient merges as blocked before any write", async () => {
    const { db, updateSet, transaction } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [
          {
            id: PATIENT_ID,
            practiceId: PRACTICE_ID,
            clientId: CLIENT_ID,
          },
          {
            id: MERGE_PATIENT_ID,
            practiceId: PRACTICE_ID,
            clientId: OTHER_CLIENT_ID,
          },
        ],
        [{}],
      ],
    });

    await expect(
      callerWithDb(db).previewMerge({
        keepId: PATIENT_ID,
        mergeId: MERGE_PATIENT_ID,
      })
    ).resolves.toMatchObject({
      allowed: false,
      blockerCounts: { differentClient: 1 },
      blockingTotal: 1,
    });

    expect(transaction).toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("fails closed before merging a patient with retained clinical or prescription history", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [],
        [{ id: PRACTICE_ID }],
        [
          {
            id: PATIENT_ID,
            practiceId: PRACTICE_ID,
            clientId: CLIENT_ID,
          },
          {
            id: MERGE_PATIENT_ID,
            practiceId: PRACTICE_ID,
            clientId: CLIENT_ID,
          },
        ],
        [{ prescriptionEvents: 1 }],
      ],
    });

    await expect(
      callerWithDb(db).merge({
        keepId: PATIENT_ID,
        mergeId: MERGE_PATIENT_ID,
        reason: "Duplicate chart created during intake.",
        operationId: MERGE_OPERATION_ID,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("atomically records and retires a history-free duplicate patient", async () => {
    const mergedAt = new Date("2026-08-08T18:00:00.000Z");
    const keepPatient = {
      id: PATIENT_ID,
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      name: "Biscuit",
      species: "canine",
      breed: "Beagle",
      sex: "female_spayed",
      dob: "2020-03-01",
      color: "tricolor",
      microchipNumber: "985141000000001",
      photoUrl: null,
      status: "active",
      externalSource: null,
      externalId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      clientFirstName: "Avery",
      clientLastName: "Rivera",
      clientEmail: "avery@example.com",
      clientPhone: "555-0100",
    };
    const mergePatient = {
      ...keepPatient,
      id: MERGE_PATIENT_ID,
      name: "Biscuit duplicate",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const { db, insertValues, updateSet, transaction, execute } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [],
        [{ id: PRACTICE_ID }],
        [keepPatient, mergePatient],
        [{}],
        [keepPatient],
      ],
      insertedRows: [{ id: MERGE_EVENT_ID, createdAt: mergedAt }],
      updatedResults: [[], [], [{ id: MERGE_PATIENT_ID }]],
    });
    const reason = "Duplicate chart verified by microchip and owner.";

    await expect(
      callerWithDb(db).merge({
        keepId: PATIENT_ID,
        mergeId: MERGE_PATIENT_ID,
        reason,
        operationId: MERGE_OPERATION_ID,
      }),
    ).resolves.toMatchObject({
      id: PATIENT_ID,
      mergeMetadata: {
        eventId: MERGE_EVENT_ID,
        sourcePatientId: MERGE_PATIENT_ID,
        canonicalId: PATIENT_ID,
        replayed: false,
      },
    });

    expect(transaction).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourcePatientId: MERGE_PATIENT_ID,
        targetPatientId: PATIENT_ID,
        performedBy: USER_ID,
        performedByName: "Patient User",
        reason,
        operationId: MERGE_OPERATION_ID,
      }),
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "merged",
        entityType: "patient",
        entityId: PATIENT_ID,
      }),
    );
    expect(updateSet).toHaveBeenNthCalledWith(1, { patientId: PATIENT_ID });
    expect(updateSet).toHaveBeenNthCalledWith(2, { patientId: PATIENT_ID });
    expect(updateSet).toHaveBeenNthCalledWith(3, {
      deletedAt: expect.any(Date),
    });
  });

  it("replays an identical merge operation without moving or retiring twice", async () => {
    const mergedAt = new Date("2026-08-08T18:00:00.000Z");
    const reason = "Duplicate chart verified by microchip and owner.";
    const canonical = {
      id: PATIENT_ID,
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      name: "Biscuit",
      species: "canine",
    };
    const { db, insertValues, updateSet, execute } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [
          {
            id: MERGE_EVENT_ID,
            sourcePatientId: MERGE_PATIENT_ID,
            targetPatientId: PATIENT_ID,
            clientId: CLIENT_ID,
            reason,
            createdAt: mergedAt,
          },
        ],
        [canonical],
      ],
    });

    await expect(
      callerWithDb(db).merge({
        keepId: PATIENT_ID,
        mergeId: MERGE_PATIENT_ID,
        reason,
        operationId: MERGE_OPERATION_ID,
      }),
    ).resolves.toMatchObject({
      id: PATIENT_ID,
      mergeMetadata: {
        eventId: MERGE_EVENT_ID,
        replayed: true,
      },
    });

    expect(execute).toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});
