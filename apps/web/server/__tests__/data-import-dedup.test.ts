import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const { IMPORT_CSV_MAX_BYTES, dataRouter } = await import("../routers/data");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000c1";

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
  return {
    limit: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
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

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, insertValues, select, update, updateSet, updateReturning };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("data import duplicate handling", () => {
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

  it("reports malformed client CSV before DB work", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: 'firstName,lastName,email\n"Jane,Doe,jane@example.com',
      }),
    ).resolves.toEqual({
      imported: 0,
      reconciled: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("skips existing and in-file duplicate client emails", async () => {
    const { db, insertValues } = createDb([
      [{ email: "existing@example.com" }],
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
      },
    ]);
  });

  it("skips existing and in-file duplicate client emails from CSV imports", async () => {
    const { db, insertValues } = createDb([
      [{ email: "existing@example.com" }],
    ]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: [
          "firstName,lastName,email",
          "Existing,Client,EXISTING@example.com",
          "New,Client,new@example.com",
          "Again,Client, New@example.com ",
        ].join("\n"),
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
      },
    ]);
  });

  it("dry-runs client CSV imports with duplicate planning and no inserts", async () => {
    const { db, insertValues } = createDb([
      [{ email: "existing@example.com" }],
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

  it("imports an ID-only client with a source-scoped external identity", async () => {
    const { db, insertValues } = createDb([[]]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: "Owner ID,First Name,Last Name\n00AbC-19,Jane,Doe",
        source: "shepherd",
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

  it("previews patients against clients planned by the same onboarding import", async () => {
    const { db, insertValues } = createDb([[], []]);

    const result = await callerWithDb(db).importPatientsCsv({
      csv: "Client ID,Patient ID,Patient Name,Species\nC-42,P-9,Rex,Dog",
      clientCsv: "Client ID,First Name,Last Name\nC-42,Jane,Doe",
      source: "other",
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      total: 1,
      willInsert: 1,
      unmatchedClient: 0,
      errors: [],
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

  it("reports malformed patient CSV before DB work", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: 'clientEmail,name,species\n"owner@example.com,Rex,canine',
      }),
    ).resolves.toEqual({
      imported: 0,
      reconciled: 0,
      errors: ["CSV has an unterminated quoted field."],
    });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("dry-runs patient CSV imports with duplicate planning and no inserts", async () => {
    const { db, insertValues } = createDb([
      [{ id: CLIENT_ID, email: "owner@example.com" }],
      [
        {
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
