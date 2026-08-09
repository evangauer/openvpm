import { afterEach, describe, expect, it, vi } from "vitest";

type MigrationMockInput = {
  summary: { plannedInsertCount: number };
  reviewedPlan?: {
    plannerVersion: string;
    dispositions: Array<Record<string, unknown>>;
    targets: Array<Record<string, unknown>>;
  };
};

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const migrationRunMocks = vi.hoisted(() => ({
  MigrationPreviewError: class MigrationPreviewError extends Error {},
  createMigrationPreview: vi.fn(
    async (_db: unknown, _input: MigrationMockInput) =>
      "00000000-0000-0000-0000-0000000000f1",
  ),
  claimMigrationPreview: vi.fn(
    async (_db: unknown, _input: MigrationMockInput) => ({
      alreadyCommitted: false,
      importedCount: 0,
      reconciledCount: 0,
      errorCount: 0,
    }),
  ),
  completeMigrationRun: vi.fn(async () => undefined),
  lockMigrationPractice: vi.fn(async () => undefined),
}));

vi.mock("@/lib/import/run-ledger", () => ({
  ...migrationRunMocks,
}));

const { IMPORT_CSV_MAX_BYTES, dataRouter } = await import("../routers/data");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-0000000000p1";
const PREVIEW_TOKEN = "00000000-0000-0000-0000-0000000000f1";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Admin",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return dataRouter.createCaller({ db, session } as never);
}

function thenableRows(result: unknown[]) {
  const rows = {
    limit: vi.fn(async () => result),
    orderBy: vi.fn(() => rows),
    for: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return rows;
}

function createDb(
  selectRows: unknown[][],
  practiceRows: unknown[] = [{ id: PRACTICE_ID }],
) {
  const remainingSelects = [practiceRows, ...selectRows];
  const select = vi.fn(() => {
    const result = remainingSelects.shift() ?? [];
    const rows = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => rows),
    };
    return builder;
  });

  const insertValues = vi.fn(() => ({
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
  };

  return { db, insertValues, select };
}

const HEADER = "clientEmail,patientName,vaccineName,dateGiven,nextDueDate";
const REX_ROW = "jane@x.com,Rex,Rabies 3yr,2024-10-04,2027-10-04";

const patientRows = [
  { id: PATIENT_ID, name: "Rex", clientEmail: "jane@x.com" },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("vaccination history import", () => {
  it("is admin-only", async () => {
    const { db, select, insertValues } = createDb([]);
    for (const role of ["front_desk", "veterinarian", "viewer"]) {
      await expect(
        callerWithDb(db, role).importVaccinationsCsv({
          csv: `${HEADER}\n${REX_ROW}`,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized CSV before any DB work", async () => {
    const { db, select } = createDb([]);
    await expect(
      callerWithDb(db).importVaccinationsCsv({
        csv: "x".repeat(IMPORT_CSV_MAX_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(select).not.toHaveBeenCalled();
  });

  it("records malformed CSV as a preview without domain writes", async () => {
    const { db, select, insertValues } = createDb([]);
    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\n"jane@x.com,Rex`,
      dryRun: true,
    });
    expect(result).toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 0,
      willInsert: 0,
      unmatchedPatient: 0,
      duplicates: 0,
      errors: ["CSV has an unterminated quoted field."],
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(
      migrationRunMocks.createMigrationPreview.mock.calls.at(-1)?.[1],
    ).toMatchObject({
      mode: "vaccinations",
      reviewedPlan: {
        plannerVersion: "vaccinations-v1",
        dispositions: [],
        targets: [],
      },
    });
  });

  it("commits malformed vaccination CSV as an explicit zero-write skip", async () => {
    const { db, insertValues } = createDb([]);
    const csv = `${HEADER}\n"jane@x.com,Rex`;

    await expect(
      callerWithDb(db).importVaccinationsCsv({
        csv,
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).resolves.toEqual({
      imported: 0,
      errors: ["CSV has an unterminated quoted field."],
    });
    expect(migrationRunMocks.claimMigrationPreview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        mode: "vaccinations",
        reviewedPlan: {
          plannerVersion: "vaccinations-v1",
          dispositions: [],
          targets: [],
        },
      }),
    );
    expect(migrationRunMocks.completeMigrationRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ importedCount: 0 }),
    );
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("dry run reports matches, duplicates, and missing pets without inserting", async () => {
    const existingDose = {
      patientId: PATIENT_ID,
      vaccineName: "Rabies 3yr",
      administeredAt: new Date("2023-10-04T12:00:00.000Z"),
    };
    const { db, insertValues } = createDb([patientRows, [existingDose]]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: [
        HEADER,
        REX_ROW, // new dose
        "jane@x.com,Rex,Rabies 3yr,2023-10-04,", // already in the DB
        REX_ROW, // in-file duplicate
        "jane@x.com,Ghost,DHPP,2024-01-01,", // unknown pet
      ].join("\n"),
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      total: 4,
      willInsert: 1,
      duplicates: 2,
      unmatchedPatient: 1,
    });
    expect(
      result.errors.some((e) => /No matching patient was found/.test(e)),
    ).toBe(true);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("binds each vaccination disposition to the versioned patient selected inside the transaction", async () => {
    const updatedAt = new Date("2026-08-08T12:00:00.000Z");
    const { db } = createDb([[{ ...patientRows[0], updatedAt }], []]);

    await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\n${REX_ROW}`,
      dryRun: true,
      migrationProtocol: "reviewed-v1",
    });

    expect(migrationRunMocks.lockMigrationPractice).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
    );
    expect(
      migrationRunMocks.createMigrationPreview.mock.calls.at(-1)?.[1],
    ).toMatchObject({
      mode: "vaccinations",
      reviewedPlan: {
        plannerVersion: "vaccinations-v1",
        dispositions: [
          {
            rowIndex: 0,
            entityKind: "vaccination",
            action: "insert",
          },
        ],
        targets: [
          {
            rowIndex: 0,
            kind: "patient",
            role: "identity_match",
            targetId: PATIENT_ID,
            targetVersion: updatedAt.toISOString(),
          },
        ],
      },
    });
  });

  it("fails closed when the same-count vaccination target changes after preview", async () => {
    const csv = `${HEADER}\n${REX_ROW}`;
    const previewDb = createDb([
      [
        {
          ...patientRows[0],
          updatedAt: new Date("2026-08-08T12:00:00.000Z"),
        },
      ],
      [],
    ]);
    await callerWithDb(previewDb.db).importVaccinationsCsv({
      csv,
      dryRun: true,
      migrationProtocol: "reviewed-v1",
    });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls.at(-1)?.[1]
        ?.reviewedPlan;
    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({ plannedInsertCount: 1 });
        expect(input.reviewedPlan).not.toEqual(reviewed);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([
      [
        {
          id: "00000000-0000-0000-0000-0000000000p2",
          name: "Rex",
          clientEmail: "jane@x.com",
          updatedAt: new Date("2026-08-08T12:00:00.000Z"),
        },
      ],
      [],
    ]);

    await expect(
      callerWithDb(commitDb.db).importVaccinationsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("returns the saved vaccination result when an exact committed request is retried", async () => {
    migrationRunMocks.claimMigrationPreview.mockResolvedValueOnce({
      alreadyCommitted: true,
      importedCount: 7,
      reconciledCount: 0,
      errorCount: 0,
    });
    const { db, insertValues } = createDb([[], []]);

    await expect(
      callerWithDb(db).importVaccinationsCsv({
        csv: `${HEADER}\n${REX_ROW}`,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).resolves.toEqual({
      imported: 7,
      errors: [],
      alreadyCommitted: true,
      migrationRunId: PREVIEW_TOKEN,
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(migrationRunMocks.completeMigrationRun).not.toHaveBeenCalled();
  });

  it("treats seeded demo patients as unavailable migration targets", async () => {
    const { db, insertValues } = createDb([
      [{ ...patientRows[0], isDemoPatient: true }],
      [],
    ]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\n${REX_ROW}`,
      dryRun: true,
      migrationProtocol: "reviewed-v1",
    });

    expect(result).toMatchObject({
      dryRun: true,
      willInsert: 0,
      unmatchedPatient: 1,
    });
    expect(result.errors[0]).toMatch(/No matching patient/i);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("imports doses at noon UTC of the given day, tenant-stamped", async () => {
    const { db, insertValues } = createDb([patientRows, []]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\n${REX_ROW}`,
      dryRun: false,
      previewToken: PREVIEW_TOKEN,
    });

    expect(result).toMatchObject({ imported: 1 });
    expect(insertValues).toHaveBeenCalledTimes(1);
    const rows = (
      insertValues.mock.calls as unknown as [Array<Record<string, unknown>>][]
    )[0]![0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      vaccineName: "Rabies 3yr",
      nextDueDate: "2027-10-04",
      administeredBy: null,
    });
    expect((rows[0]!.administeredAt as Date).toISOString()).toBe(
      "2024-10-04T12:00:00.000Z",
    );
  });

  it("flags same-named pets under one owner instead of guessing", async () => {
    const twins = [
      { id: PATIENT_ID, name: "Rex", clientEmail: "jane@x.com" },
      {
        id: "00000000-0000-0000-0000-0000000000p2",
        name: "Rex",
        clientEmail: "jane@x.com",
      },
    ];
    const { db, insertValues } = createDb([twins, []]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\n${REX_ROW}`,
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      willInsert: 0,
      unmatchedPatient: 1,
    });
    expect(
      result.errors.some((e) => /patient references are ambiguous/.test(e)),
    ).toBe(true);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("uses a direct external patient ID to disambiguate same-named pets", async () => {
    const twins = [
      {
        id: PATIENT_ID,
        name: "Rex",
        externalSource: "shepherd",
        externalId: "P-1",
        clientEmail: "jane@x.com",
        clientExternalSource: "shepherd",
        clientExternalId: "C-1",
      },
      {
        id: "00000000-0000-0000-0000-0000000000p2",
        name: "Rex",
        externalSource: "shepherd",
        externalId: "P-2",
        clientEmail: "jane@x.com",
        clientExternalSource: "shepherd",
        clientExternalId: "C-1",
      },
    ];
    const { db, insertValues } = createDb([twins, []]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: "Patient ID,Vaccine,Date Given\nP-2,Rabies,2025-01-01",
      source: "shepherd",
      dryRun: false,
      previewToken: PREVIEW_TOKEN,
    });

    expect(result).toMatchObject({ imported: 1, errors: [] });
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        patientId: "00000000-0000-0000-0000-0000000000p2",
        vaccineName: "Rabies",
      }),
    ]);
  });

  it("rejects a direct patient ID that conflicts with the supplied owner and name", async () => {
    const rows = [
      {
        id: PATIENT_ID,
        name: "Rex",
        externalSource: "shepherd",
        externalId: "P-1",
        clientEmail: "rex-owner@example.com",
        clientExternalSource: "shepherd",
        clientExternalId: "C-1",
      },
      {
        id: "00000000-0000-0000-0000-0000000000p2",
        name: "Luna",
        externalSource: "shepherd",
        externalId: "P-2",
        clientEmail: "luna-owner@example.com",
        clientExternalSource: "shepherd",
        clientExternalId: "C-2",
      },
    ];
    const { db, insertValues } = createDb([rows, []]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: [
        "Patient ID,Owner Email,Patient Name,Vaccine,Date Given",
        "P-1,luna-owner@example.com,Luna,Rabies,2025-01-01",
      ].join("\n"),
      source: "shepherd",
      dryRun: true,
    });

    expect(result).toMatchObject({ willInsert: 0, unmatchedPatient: 1 });
    expect(result.errors[0]).toMatch(/ambiguous or conflict/i);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("matches pets case- and spacing-insensitively", async () => {
    const { db } = createDb([
      [{ id: PATIENT_ID, name: "Rex  Jr", clientEmail: "Jane@X.com" }],
      [],
    ]);

    const result = await callerWithDb(db).importVaccinationsCsv({
      csv: `${HEADER}\nJANE@x.com,rex jr,Bordetella,2024-05-05,`,
      dryRun: true,
    });

    expect(result).toMatchObject({ dryRun: true, willInsert: 1 });
  });

  it("404s when the practice is missing or deleted", async () => {
    const { db } = createDb([], []);
    await expect(
      callerWithDb(db).importVaccinationsCsv({
        csv: `${HEADER}\n${REX_ROW}`,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
