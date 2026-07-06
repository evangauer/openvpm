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
      reject?: (error: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
}

function createDb(
  selectRows: unknown[][],
  practiceRows: unknown[] = [{ id: PRACTICE_ID }]
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

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
  };

  return { db, insertValues, select };
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
      })
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
      })
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
      })
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
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: oversizedCsv,
        dryRun: true,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects imports when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb([], []);

    await expect(
      callerWithDb(db).importClients({
        clients: [{ firstName: "Ada", lastName: "Client" }],
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: ["clientEmail,name,species", "owner@example.com,Rex,canine"].join(
          "\n"
        ),
        dryRun: true,
      })
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
      })
    ).resolves.toEqual({
      imported: 0,
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
          { firstName: "Existing", lastName: "Client", email: "Existing@example.com" },
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
      })
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
      })
    ).resolves.toMatchObject({
      imported: 1,
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
      })
    ).resolves.toEqual({
      dryRun: true,
      total: 3,
      willInsert: 1,
      duplicates: 2,
      errors: [],
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
      })
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
      })
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
      })
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
      })
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
      })
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
      })
    ).resolves.toEqual({
      dryRun: true,
      total: 2,
      willInsert: 1,
      unmatchedClient: 1,
      duplicates: 0,
      errors: ['Row 2: No client found with email "ghost@example.com"'],
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("reports malformed patient CSV before DB work", async () => {
    const { db, insertValues, select } = createDb([]);

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: 'clientEmail,name,species\n"owner@example.com,Rex,canine',
      })
    ).resolves.toEqual({
      imported: 0,
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
      })
    ).resolves.toEqual({
      dryRun: true,
      total: 3,
      willInsert: 1,
      unmatchedClient: 0,
      duplicates: 2,
      errors: [
        'Row 1: Skipped duplicate patient "Rex".',
        'Row 3: Skipped duplicate patient "Luna".',
      ],
    });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects parsed CSV records with invalid bounded fields before DB work", async () => {
    const { db, insertValues } = createDb([]);

    await expect(
      callerWithDb(db).importClientsCsv({
        csv: [
          "firstName,lastName,address",
          `Ada,Client,${"a".repeat(501)}`,
        ].join("\n"),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).importPatientsCsv({
        csv: [
          "clientEmail,name,species,dob",
          "owner@example.com,Biscuit,canine,2026-02-30",
        ].join("\n"),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });
});
