import { afterEach, describe, expect, it, vi } from "vitest";

type MigrationMockInput = {
  summary: {
    plannedInsertCount: number;
    plannedReconcileCount?: number;
    duplicateCount?: number;
  };
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

const { IMPORT_CSV_MAX_BYTES, dataRouter, legacyImportCompatibilityOpen } =
  await import("../routers/data");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000c1";
const OTHER_CLIENT_ID = "00000000-0000-0000-0000-0000000000c2";
const PATIENT_ID = "00000000-0000-0000-0000-0000000000d1";
const OTHER_PATIENT_ID = "00000000-0000-0000-0000-0000000000d2";
const PREVIEW_TOKEN = "00000000-0000-0000-0000-0000000000f1";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
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
      where: vi.fn(() => rows),
    };
    return builder;
  });

  const insertValues = vi.fn(() => ({
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateReturning = vi.fn(async () => [{ id: CLIENT_ID }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn(async () => undefined);

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
    select,
    insert,
    update,
  };

  return {
    db,
    execute,
    insertValues,
    select,
    update,
    updateSet,
    updateReturning,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("data import duplicate handling", () => {
  it("bounds compatibility for pre-deploy import tabs", () => {
    expect(
      legacyImportCompatibilityOpen(
        Date.parse("2026-08-14T23:59:59Z"),
        "production",
      ),
    ).toBe(true);
    expect(
      legacyImportCompatibilityOpen(
        Date.parse("2026-08-15T00:00:00Z"),
        "production",
      ),
    ).toBe(false);
  });

  it("requires old two-file onboarding tabs to refresh before pet review", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: "clientEmail,name,species\nowner@example.com,Rex,canine",
        clientCsv: "firstName,lastName,email\nAda,Client,owner@example.com",
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "This onboarding import session is out of date. Refresh OpenVPM to check clients before pets.",
    });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid client import fields before DB work", async () => {
    const { db, insertValues } = createDb([]);

    await expect(
      callerWithDb(db).importClients({
        clients: [
          {
            firstName: "   ",
            lastName: "Client",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importClients({
        clients: [
          {
            firstName: "Ada",
            lastName: "Client",
            email: "not-an-email",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importClients({
        clients: [
          {
            firstName: "Ada",
            lastName: "Client",
            address: "a".repeat(501),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized CSV imports before DB work", async () => {
    const { db, insertValues, select } = createDb([]);
    const oversizedCsv = "a".repeat(IMPORT_CSV_MAX_BYTES + 1);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: oversizedCsv,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: oversizedCsv,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects any commit that has not supplied a server preview token", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: "firstName,lastName,email\nAda,Client,ada@example.com",
        dryRun: false,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Check this exact CSV first, then confirm its import.",
    });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns the saved result when an exact committed request is retried", async () => {
    migrationRunMocks.claimMigrationPreview.mockResolvedValueOnce({
      alreadyCommitted: true,
      importedCount: 7,
      reconciledCount: 2,
      errorCount: 0,
    });
    const { db, insertValues } = createDb([[]]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: "firstName,lastName,email\nAda,Client,ada@example.com",
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).resolves.toEqual({
      imported: 7,
      reconciled: 2,
      errors: [],
      alreadyCommitted: true,
      migrationRunId: PREVIEW_TOKEN,
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(migrationRunMocks.completeMigrationRun).not.toHaveBeenCalled();
  });

  it("rejects imports when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb([], []);

    await expect(
      callerWithDb(db).importClients({
        clients: [{ firstName: "Ada", lastName: "Client" }],
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: ["clientEmail,name,species", "owner@example.com,Rex,canine"].join(
          "\n",
        ),
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records malformed client CSV as a preview without domain writes", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: 'firstName,lastName,email\n"Jane,Doe,jane@example.com',
        dryRun: true,
      }),
    ).resolves.toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 0,
      willInsert: 0,
      willReconcile: 0,
      duplicates: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(
      migrationRunMocks.createMigrationPreview.mock.calls.at(-1)?.[1],
    ).toMatchObject({
      mode: "clients",
      reviewedPlan: {
        plannerVersion: "clients-v1",
        dispositions: [],
        targets: [],
      },
    });
  });

  it("commits a malformed client CSV as an explicit zero-write skip", async () => {
    const { db, execute, insertValues } = createDb([]);
    const csv = 'firstName,lastName,email\n"Jane,Doe,jane@example.com';

    await expect(
      callerWithDb(db).importClientsCsv({
        csv,
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).resolves.toEqual({
      imported: 0,
      reconciled: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(migrationRunMocks.claimMigrationPreview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        mode: "clients",
        summary: expect.objectContaining({ plannedInsertCount: 0 }),
        reviewedPlan: {
          plannerVersion: "clients-v1",
          dispositions: [],
          targets: [],
        },
      }),
    );
    expect(migrationRunMocks.completeMigrationRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ importedCount: 0, reconciledCount: 0 }),
    );
    // Tenant scoping plus SERIALIZABLE isolation both execute inside the same
    // transaction before the ledger is completed.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("skips existing and in-file duplicate client emails", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "existing@example.com" }],
    ]);

    await expect(
      callerWithDb(db).importClients({
        clients: [
          {
            firstName: "Existing",
            lastName: "Client",
            email: "Existing@example.com",
          },
          {
            firstName: " New ",
            lastName: " Client ",
            email: " NEW@example.com ",
            phone: " +15555550123 ",
            address: " 123 Main St ",
            city: " Boston ",
            state: " MA ",
            zip: " 02110 ",
          },
          { firstName: "Again", lastName: "Client", email: "new@example.com" },
          { firstName: "No", lastName: "Email" },
        ],
      }),
    ).resolves.toMatchObject({
      imported: 2,
      errors: [
        'Row 1: Skipped duplicate client email "existing@example.com".',
        'Row 3: Skipped duplicate client email "new@example.com".',
      ],
    });

    expect(insertValues).toHaveBeenCalledWith([
      {
        practiceId: PRACTICE_ID,
        firstName: "New",
        lastName: "Client",
        email: "new@example.com",
        phone: "+15555550123",
        address: "123 Main St",
        city: "Boston",
        state: "MA",
        zip: "02110",
        importFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      {
        practiceId: PRACTICE_ID,
        firstName: "No",
        lastName: "Email",
        email: null,
        phone: null,
        address: null,
        city: null,
        state: null,
        zip: null,
        importFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("skips existing and in-file duplicate client emails from CSV imports", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "existing@example.com" }],
    ]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: [
          "firstName,lastName,email",
          "Existing,Client,EXISTING@example.com",
          "New,Client,new@example.com",
          "Again,Client, New@example.com ",
        ].join("\n"),
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).resolves.toMatchObject({
      imported: 1,
      reconciled: 0,
      errors: [
        "Row 1: Skipped a duplicate client.",
        "Row 3: Skipped a duplicate client.",
      ],
    });

    expect(insertValues).toHaveBeenCalledWith([
      {
        practiceId: PRACTICE_ID,
        firstName: "New",
        lastName: "Client",
        email: "new@example.com",
        phone: null,
        address: null,
        city: null,
        state: null,
        zip: null,
        importFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("dry-runs client CSV imports with duplicate planning and no inserts", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "existing@example.com" }],
    ]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: [
          "firstName,lastName,email",
          "Existing,Client,EXISTING@example.com",
          "New,Client,new@example.com",
          "Again,Client,new@example.com",
        ].join("\n"),
        dryRun: true,
      }),
    ).resolves.toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 3,
      willInsert: 1,
      willReconcile: 0,
      duplicates: 2,
      errors: [
        "Row 1: Skipped a duplicate client.",
        "Row 3: Skipped a duplicate client.",
      ],
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not reconcile a real client import onto a disposable demo owner", async () => {
    const { db, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
          isDemo: true,
        },
      ],
    ]);

    const result = await callerWithDb(db).importClientsCsv({
      csv: "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com",
      source: "shepherd",
      dryRun: true,
      migrationProtocol: "reviewed-v1",
    });

    expect(result).toMatchObject({
      dryRun: true,
      willInsert: 1,
      willReconcile: 0,
      duplicates: 0,
      errors: [],
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("imports an ID-only client with a source-scoped external identity", async () => {
    const { db, execute, insertValues } = createDb([[]]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: "Owner ID,First Name,Last Name\n00AbC-19,Jane,Doe",
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).resolves.toMatchObject({ imported: 1, reconciled: 0, errors: [] });

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        externalSource: "shepherd",
        externalId: "00AbC-19",
        firstName: "Jane",
        lastName: "Doe",
        email: null,
      }),
    ]);
    expect(execute).toHaveBeenCalled();
  });

  it("merges a later external ID into the pending client insert", async () => {
    const { db, insertValues, update } = createDb([[]]);

    const result = await callerWithDb(db).importClientsCsv({
      csv: [
        "Client ID,First Name,Last Name,Email",
        ",Jane,Doe,jane@example.com",
        "C-42,Jane,Doe,jane@example.com",
      ].join("\n"),
      source: "shepherd",
      dryRun: false,
      previewToken: PREVIEW_TOKEN,
    });

    expect(result).toMatchObject({ imported: 1, reconciled: 0, errors: [] });
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        email: "jane@example.com",
        externalSource: "shepherd",
        externalId: "C-42",
      }),
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("reconciles an external ID onto one exact existing email match", async () => {
    const existing = [
      {
        id: CLIENT_ID,
        email: "owner@example.com",
        externalSource: null,
        externalId: null,
        deletedAt: null,
      },
    ];
    const dryRunDb = createDb([existing]);
    await expect(
      callerWithDb(dryRunDb.db).importClientsCsv({
        csv: "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com",
        source: "shepherd",
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      dryRun: true,
      willInsert: 0,
      willReconcile: 1,
      duplicates: 0,
      errors: [],
    });

    const commitDb = createDb([
      existing.map((client) => ({
        ...client,
        externalSource: null,
        externalId: null,
      })),
    ]);
    await expect(
      callerWithDb(commitDb.db).importClientsCsv({
        csv: "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com",
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).resolves.toMatchObject({ imported: 0, reconciled: 1, errors: [] });
    expect(commitDb.updateSet).toHaveBeenCalledWith({
      externalSource: "shepherd",
      externalId: "C-42",
    });
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("stops when a reconciliation target changed after planning", async () => {
    const { db, updateReturning, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
    ]);
    updateReturning.mockResolvedValueOnce([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com",
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/changed after the dry run/i),
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid patient import fields before DB work", async () => {
    const { db, insertValues } = createDb([]);

    await expect(
      callerWithDb(db).importPatients({
        patients: [
          {
            clientEmail: "not-an-email",
            name: "Biscuit",
            species: "canine",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatients({
        patients: [
          {
            clientEmail: "owner@example.com",
            name: "   ",
            species: "canine",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatients({
        patients: [
          {
            clientEmail: "owner@example.com",
            name: "Biscuit",
            species: "canine",
            dob: "2026-02-30",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatients({
        patients: [
          {
            clientEmail: "owner@example.com",
            name: "Biscuit",
            species: "canine",
            microchipNumber: "m".repeat(65),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("skips unmatched and duplicate patients before inserting tenant rows", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "owner@example.com" }],
      [
        {
          id: PATIENT_ID,
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: "2020-01-01",
          microchipNumber: null,
        },
      ],
    ]);

    await expect(
      callerWithDb(db).importPatients({
        patients: [
          {
            clientEmail: "owner@example.com",
            name: "Rex",
            species: "canine",
            dob: "2020-01-01",
          },
          {
            clientEmail: " owner@example.com ",
            name: " Luna ",
            species: "feline",
            breed: " Domestic Shorthair ",
            dob: " 2021-03-04 ",
            color: " Black ",
            microchipNumber: " 985112003009999 ",
          },
          {
            clientEmail: "OWNER@example.com",
            name: " Luna ",
            species: "feline",
            dob: "2021-03-04",
          },
          {
            clientEmail: "ghost@example.com",
            name: "Mystery",
            species: "canine",
          },
        ],
      }),
    ).resolves.toMatchObject({
      imported: 1,
      errors: [
        'Row 1: Skipped duplicate patient "Rex".',
        'Row 3: Skipped duplicate patient "Luna".',
        'Row 4: No client found with email "ghost@example.com"',
      ],
    });

    expect(insertValues).toHaveBeenCalledWith([
      {
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        name: "Luna",
        species: "feline",
        breed: "Domestic Shorthair",
        sex: null,
        dob: "2021-03-04",
        color: "Black",
        microchipNumber: "985112003009999",
        importFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it("dry-runs patient CSV imports with owner-match planning and no inserts", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "owner@example.com" }],
      [],
    ]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: [
          "clientEmail,name,species",
          "owner@example.com,Rex,canine",
          "ghost@example.com,Luna,feline",
        ].join("\n"),
        dryRun: true,
      }),
    ).resolves.toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 2,
      willInsert: 1,
      willReconcile: 0,
      unmatchedClient: 1,
      duplicates: 0,
      errors: [
        "Row 2: No matching client was found for the supplied owner reference.",
      ],
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("links an ID-only patient to its external owner ID", async () => {
    const { db, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: null,
          externalSource: "shepherd",
          externalId: "C-42",
          deletedAt: null,
        },
      ],
      [],
    ]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: "Client ID,Patient ID,Patient Name,Species\nC-42,P-9,Rex,Dog",
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
      }),
    ).resolves.toMatchObject({ imported: 1, reconciled: 0, errors: [] });

    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        externalSource: "shepherd",
        externalId: "P-9",
        name: "Rex",
        species: "canine",
      }),
    ]);
  });

  it("requires clients to be committed before a patient preview can match them", async () => {
    const { db, insertValues } = createDb([[], []]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Client ID,Patient ID,Patient Name,Species\nC-42,P-9,Rex,Dog",
      source: "other",
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      total: 1,
      willInsert: 0,
      unmatchedClient: 1,
      errors: [
        "Row 1: No matching client was found for the supplied owner reference.",
      ],
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("merges a later external ID into the pending patient insert", async () => {
    const { db, insertValues, update } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
      [],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: [
        "Owner Email,Patient ID,Patient Name,Species",
        "owner@example.com,,Rex,Dog",
        "owner@example.com,P-9,Rex,Dog",
      ].join("\n"),
      source: "shepherd",
      dryRun: false,
      previewToken: PREVIEW_TOKEN,
    });

    expect(result).toMatchObject({ imported: 1, reconciled: 0, errors: [] });
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "Rex",
        externalSource: "shepherd",
        externalId: "P-9",
      }),
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires a strong patient match before attaching a durable external ID", async () => {
    const baseClient = [
      {
        id: CLIENT_ID,
        email: "owner@example.com",
        externalSource: null,
        externalId: null,
        deletedAt: null,
      },
    ];
    const existingPatient = {
      id: "00000000-0000-0000-0000-0000000000p1",
      clientId: CLIENT_ID,
      name: "Rex",
      species: "canine",
      dob: "2020-01-01",
      microchipNumber: null,
      externalSource: null,
      externalId: null,
      deletedAt: null,
    };
    const weakDb = createDb([baseClient, [existingPatient]]);

    const weakResult = await callerWithDb(weakDb.db).importPatientsCsv({
      csv: "Owner Email,Patient ID,Patient Name,Species\nowner@example.com,P-9,Rex,Dog",
      source: "shepherd",
      dryRun: true,
    });
    expect(weakResult).toMatchObject({
      willInsert: 0,
      willReconcile: 0,
    });
    expect(weakResult.errors[0]).toMatch(/microchip or date of birth/i);

    const strongDb = createDb([baseClient, [existingPatient]]);
    const strongResult = await callerWithDb(strongDb.db).importPatientsCsv({
      csv: "Owner Email,Patient ID,Patient Name,Species,DOB\nowner@example.com,P-9,Rex,Dog,2020-01-01",
      source: "shepherd",
      dryRun: true,
    });
    expect(strongResult).toMatchObject({
      willInsert: 0,
      willReconcile: 1,
      errors: [],
    });
  });

  it("does not match the same external owner ID from a different source", async () => {
    const { db, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: null,
          externalSource: "avimark",
          externalId: "C-42",
          deletedAt: null,
        },
      ],
      [],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Client ID,Patient ID,Patient Name,Species\nC-42,P-9,Rex,Dog",
      source: "shepherd",
      dryRun: true,
    });

    expect(result).toMatchObject({
      willInsert: 0,
      willReconcile: 0,
      unmatchedClient: 1,
    });
    expect(result.errors.join(" ")).not.toContain("C-42");
    expect(result.errors.join(" ")).not.toContain("Rex");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("reserves archived external owner IDs instead of creating a duplicate chart", async () => {
    const { db, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: null,
          externalSource: "shepherd",
          externalId: "C-42",
          deletedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      [],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Client ID,Patient ID,Patient Name,Species\nC-42,P-9,Rex,Dog",
      source: "shepherd",
      dryRun: true,
    });

    expect(result).toMatchObject({
      willInsert: 0,
      unmatchedClient: 1,
    });
    expect(result.errors[0]).toMatch(/archived client/i);
    expect(result.errors.join(" ")).not.toContain("C-42");
    expect(result.errors.join(" ")).not.toContain("Rex");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not attach a patient ID when two existing charts match the row", async () => {
    const { db, insertValues, update } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
      [
        {
          id: "00000000-0000-0000-0000-0000000000p1",
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: null,
          microchipNumber: null,
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
        {
          id: "00000000-0000-0000-0000-0000000000p2",
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: null,
          microchipNumber: null,
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Owner Email,Patient ID,Patient Name,Species\nowner@example.com,P-9,Rex,Dog",
      source: "shepherd",
      dryRun: true,
    });

    expect(result).toMatchObject({ willInsert: 0, willReconcile: 0 });
    expect(result.errors[0]).toMatch(/more than one existing patient/i);
    expect(update).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not create a third chart when weak patient matches have different birth dates", async () => {
    const { db, insertValues, update } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
      [
        {
          id: "00000000-0000-0000-0000-0000000000p1",
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: "2020-01-01",
          microchipNumber: null,
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
        {
          id: "00000000-0000-0000-0000-0000000000p2",
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: "2021-02-02",
          microchipNumber: null,
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Owner Email,Patient ID,Patient Name,Species\nowner@example.com,P-9,Rex,Dog",
      source: "shepherd",
      dryRun: true,
    });

    expect(result).toMatchObject({ willInsert: 0, willReconcile: 0 });
    expect(result.errors[0]).toMatch(/more than one existing patient/i);
    expect(update).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records malformed patient CSV as a preview without domain writes", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: 'clientEmail,name,species\n"owner@example.com,Rex,canine',
        dryRun: true,
      }),
    ).resolves.toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 0,
      willInsert: 0,
      willReconcile: 0,
      unmatchedClient: 0,
      duplicates: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(
      migrationRunMocks.createMigrationPreview.mock.calls.at(-1)?.[1],
    ).toMatchObject({
      mode: "patients",
      reviewedPlan: {
        plannerVersion: "patients-v1",
        dispositions: [],
        targets: [],
      },
    });
  });

  it("commits a malformed patient CSV as an explicit zero-write skip", async () => {
    const { db, execute, insertValues } = createDb([]);
    const csv = 'clientEmail,name,species\n"owner@example.com,Rex,canine';

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv,
        source: "shepherd",
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).resolves.toEqual({
      imported: 0,
      reconciled: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(migrationRunMocks.claimMigrationPreview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        mode: "patients",
        summary: expect.objectContaining({ plannedInsertCount: 0 }),
        reviewedPlan: {
          plannerVersion: "patients-v1",
          dispositions: [],
          targets: [],
        },
      }),
    );
    expect(migrationRunMocks.completeMigrationRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ importedCount: 0, reconciledCount: 0 }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("dry-runs patient CSV imports with duplicate planning and no inserts", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "owner@example.com" }],
      [
        {
          id: PATIENT_ID,
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: "2020-01-01",
          microchipNumber: null,
        },
      ],
    ]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: [
          "clientEmail,name,species,dob,microchipNumber",
          "owner@example.com,Rex,canine,2020-01-01,",
          "owner@example.com,Luna,feline,2021-03-04,985112003009999",
          "owner@example.com,Luna,feline,2021-03-04,985112003009999",
        ].join("\n"),
        dryRun: true,
      }),
    ).resolves.toEqual({
      dryRun: true,
      previewToken: PREVIEW_TOKEN,
      total: 3,
      willInsert: 1,
      willReconcile: 0,
      unmatchedClient: 0,
      duplicates: 2,
      errors: [
        "Row 1: Skipped a duplicate patient.",
        "Row 3: Skipped a duplicate patient.",
      ],
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not reconcile a real patient import onto a disposable demo pet", async () => {
    const { db, insertValues } = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
        },
      ],
      [
        {
          id: PATIENT_ID,
          clientId: CLIENT_ID,
          name: "Rex",
          species: "canine",
          dob: "2020-01-01",
          microchipNumber: null,
          externalSource: null,
          externalId: null,
          deletedAt: null,
          isDemo: true,
        },
      ],
    ]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: [
        "Patient ID,Client Email,Name,Species,DOB",
        "P-42,owner@example.com,Rex,canine,2020-01-01",
      ].join("\n"),
      source: "shepherd",
      dryRun: true,
      migrationProtocol: "reviewed-v1",
    });

    expect(result).toMatchObject({
      dryRun: true,
      willInsert: 1,
      willReconcile: 0,
      duplicates: 0,
      errors: [],
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a same-count client target swap before any domain write", async () => {
    const csv =
      "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com";
    const updatedAt = new Date("2026-08-08T12:00:00.000Z");
    const previewDb = createDb([
      [
        {
          id: CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
          updatedAt,
        },
      ],
    ]);
    await callerWithDb(previewDb.db).importClientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan
        ?.targets;

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({
          plannedInsertCount: 0,
          plannedReconcileCount: 1,
        });
        expect(input.reviewedPlan?.targets).not.toEqual(reviewed);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([
      [
        {
          id: OTHER_CLIENT_ID,
          email: "owner@example.com",
          externalSource: null,
          externalId: null,
          deletedAt: null,
          updatedAt,
        },
      ],
    ]);

    await expect(
      callerWithDb(commitDb.db).importClientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects a selected client version change before any domain write", async () => {
    const csv =
      "Client ID,First Name,Last Name,Email\nC-42,Ada,Client,owner@example.com";
    const clientAt = (updatedAt: string) => ({
      id: CLIENT_ID,
      email: "owner@example.com",
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date(updatedAt),
    });
    const previewDb = createDb([[clientAt("2026-08-08T12:00:00.000Z")]]);
    await callerWithDb(previewDb.db).importClientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan
        ?.targets;

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.reviewedPlan?.targets).not.toEqual(reviewed);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([[clientAt("2026-08-08T12:01:00.000Z")]]);

    await expect(
      callerWithDb(commitDb.db).importClientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects a same-count owner target swap before inserting a patient", async () => {
    const csv = "clientEmail,name,species\nowner@example.com,Rex,canine";
    const ownerAt = (id: string) => ({
      id,
      email: "owner@example.com",
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    const previewDb = createDb([[ownerAt(CLIENT_ID)], []]);
    await callerWithDb(previewDb.db).importPatientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan
        ?.targets;

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({
          plannedInsertCount: 1,
          plannedReconcileCount: 0,
        });
        expect(input.reviewedPlan?.targets).not.toEqual(reviewed);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([[ownerAt(OTHER_CLIENT_ID)], []]);

    await expect(
      callerWithDb(commitDb.db).importPatientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects a same-count patient target swap before reconciliation", async () => {
    const csv = [
      "Patient ID,Client Email,Name,Species,DOB",
      "P-42,owner@example.com,Rex,canine,2020-01-01",
    ].join("\n");
    const owner = {
      id: CLIENT_ID,
      email: "owner@example.com",
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    };
    const patientAt = (id: string) => ({
      id,
      clientId: CLIENT_ID,
      name: "Rex",
      species: "canine",
      dob: "2020-01-01",
      microchipNumber: null,
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    const previewDb = createDb([[owner], [patientAt(PATIENT_ID)]]);
    await callerWithDb(previewDb.db).importPatientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan
        ?.targets;

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({
          plannedInsertCount: 0,
          plannedReconcileCount: 1,
        });
        expect(input.reviewedPlan?.targets).not.toEqual(reviewed);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([[owner], [patientAt(OTHER_PATIENT_ID)]]);

    await expect(
      callerWithDb(commitDb.db).importPatientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects same-count client row dispositions that swap after preview", async () => {
    const csv = [
      "First Name,Last Name,Email",
      "Ada,One,ada@example.com",
      "Ben,Two,ben@example.com",
    ].join("\n");
    const existingClient = (email: string) => ({
      id: CLIENT_ID,
      email,
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    const previewDb = createDb([[existingClient("ada@example.com")]]);
    await callerWithDb(previewDb.db).importClientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan;
    expect(reviewed?.plannerVersion).toBe("clients-v1");
    expect(reviewed?.dispositions).toEqual([
      { rowIndex: 0, entityKind: "client", action: "duplicate" },
      { rowIndex: 1, entityKind: "client", action: "insert" },
    ]);

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({
          plannedInsertCount: 1,
          duplicateCount: 1,
        });
        expect(input.reviewedPlan?.dispositions).toEqual([
          { rowIndex: 0, entityKind: "client", action: "insert" },
          { rowIndex: 1, entityKind: "client", action: "duplicate" },
        ]);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([[existingClient("ben@example.com")]]);

    await expect(
      callerWithDb(commitDb.db).importClientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects same-count patient row dispositions that swap after preview", async () => {
    const csv = [
      "Client Email,Name,Species,DOB",
      "owner@example.com,Rex,canine,2020-01-01",
      "owner@example.com,Luna,canine,2021-01-01",
    ].join("\n");
    const owner = {
      id: CLIENT_ID,
      email: "owner@example.com",
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    };
    const existingPatient = (name: string, dob: string) => ({
      id: PATIENT_ID,
      clientId: CLIENT_ID,
      name,
      species: "canine",
      dob,
      microchipNumber: null,
      externalSource: null,
      externalId: null,
      deletedAt: null,
      updatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
    const previewDb = createDb([
      [owner],
      [existingPatient("Rex", "2020-01-01")],
    ]);
    await callerWithDb(previewDb.db).importPatientsCsv({ csv, dryRun: true });
    const reviewed =
      migrationRunMocks.createMigrationPreview.mock.calls[0]?.[1]?.reviewedPlan;
    expect(reviewed?.plannerVersion).toBe("patients-v1");
    expect(reviewed?.dispositions).toEqual([
      { rowIndex: 0, entityKind: "patient", action: "duplicate" },
      { rowIndex: 1, entityKind: "patient", action: "insert" },
    ]);

    migrationRunMocks.claimMigrationPreview.mockImplementationOnce(
      async (_db, input) => {
        expect(input.summary).toMatchObject({
          plannedInsertCount: 1,
          duplicateCount: 1,
        });
        expect(input.reviewedPlan?.dispositions).toEqual([
          { rowIndex: 0, entityKind: "patient", action: "insert" },
          { rowIndex: 1, entityKind: "patient", action: "duplicate" },
        ]);
        throw new migrationRunMocks.MigrationPreviewError(
          "The reviewed import plan changed.",
        );
      },
    );
    const commitDb = createDb([
      [owner],
      [existingPatient("Luna", "2021-01-01")],
    ]);

    await expect(
      callerWithDb(commitDb.db).importPatientsCsv({
        csv,
        dryRun: false,
        previewToken: PREVIEW_TOKEN,
        migrationProtocol: "reviewed-v1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(commitDb.update).not.toHaveBeenCalled();
    expect(commitDb.insertValues).not.toHaveBeenCalled();
  });

  it("rejects parsed CSV records with invalid bounded fields before DB work", async () => {
    const { db, insertValues } = createDb([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: [
          "firstName,lastName,email,address",
          `Ada,Client,ada@example.com,${"a".repeat(501)}`,
        ].join("\n"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: [
          "clientEmail,name,species,dob",
          "owner@example.com,Biscuit,canine,2026-02-30",
        ].join("\n"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });
});
