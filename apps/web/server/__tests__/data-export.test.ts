import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  exportPracticeData: vi.fn(async () => ({
    practiceId: "00000000-0000-0000-0000-0000000000aa",
    exportedAt: "2026-06-27T00:00:00.000Z",
    counts: {},
    clients: [],
    patients: [],
    soapNotes: [],
    vitalSigns: [],
    prescriptions: [],
    controlledSubstanceLog: [],
  })),
  restorePracticeData: vi.fn(),
  summarizePracticeExport: vi.fn(() => ({
    counts: {},
    missingSections: [],
    totalRows: 0,
  })),
  validatePracticeExportRestore: vi.fn(() => ({
    valid: true,
    errors: [] as string[],
  })),
  validatePracticeFileRestoreTarget: vi.fn(() => ({
    valid: true,
    errors: [] as string[],
  })),
  practiceBackupContainsSealedConsentEvidence: vi.fn(() => false),
  isPracticeBackupJsonSizeValid: vi.fn(() => true),
  recordAuditLog: vi.fn(async () => undefined),
  recordActivationAfterAppointmentCreated: vi.fn(async () => true),
}));

vi.mock("@/lib/backup/export", () => ({
  exportPracticeData: mocks.exportPracticeData,
  restorePracticeData: mocks.restorePracticeData,
  summarizePracticeExport: mocks.summarizePracticeExport,
  validatePracticeFileRestoreTarget: mocks.validatePracticeFileRestoreTarget,
  validatePracticeExportRestore: mocks.validatePracticeExportRestore,
  practiceBackupContainsSealedConsentEvidence:
    mocks.practiceBackupContainsSealedConsentEvidence,
}));

vi.mock("@/lib/backup/policy", () => ({
  PRACTICE_BACKUP_JSON_SIZE_MESSAGE:
    "Backup JSON restores must be 50 MB or less.",
  isPracticeBackupJsonSizeValid: mocks.isPracticeBackupJsonSizeValid,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/funnel-events-server", () => ({
  recordActivationAfterAppointmentCreated:
    mocks.recordActivationAfterAppointmentCreated,
}));

const { dataRouter } = await import("../routers/data");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return dataRouter.createCaller({ db, session } as never);
}

function createDb(
  practiceRows: Record<string, unknown>[] = [{ id: PRACTICE_ID }],
) {
  const limit = vi.fn(async () => practiceRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };
  return db;
}

function createRestoreDb(
  selectResults: Record<string, unknown>[][] = [[], [], [], []],
  practiceRows: Record<string, unknown>[] = [{ id: PRACTICE_ID }],
) {
  const queuedResults = [practiceRows, ...selectResults];
  const limit = vi.fn(async () => queuedResults.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const tx = {
    execute: vi.fn(async () => undefined),
    select,
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));
  const db: Record<string, unknown> = {
    transaction,
    execute: vi.fn(async () => undefined),
    select,
  };
  return { db, tx, transaction, select, limit };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("data full backup export", () => {
  it("exports a restorable full-practice backup for admins", async () => {
    const db = createDb();

    await expect(callerWithDb(db).exportFullBackup()).resolves.toMatchObject({
      practiceId: PRACTICE_ID,
      clients: [],
      patients: [],
      soapNotes: [],
      vitalSigns: [],
      prescriptions: [],
      controlledSubstanceLog: [],
    });

    expect(mocks.exportPracticeData).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("does not allow non-admin staff to export the full backup", async () => {
    const db = createDb();

    await expect(
      callerWithDb(db, "front_desk").exportFullBackup(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.exportPracticeData).not.toHaveBeenCalled();
  });

  it("rejects full backup exports when the practice is missing or deleted", async () => {
    const db = createDb([]);

    await expect(callerWithDb(db).exportFullBackup()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.exportPracticeData).not.toHaveBeenCalled();
  });
});

describe("data full backup restore", () => {
  it("rejects oversized backup restores before dry-run work", async () => {
    const { db, select } = createRestoreDb();
    mocks.isPracticeBackupJsonSizeValid.mockReturnValueOnce(false);

    await expect(
      callerWithDb(db).restoreBackup({ backup: { clients: [] }, dryRun: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.summarizePracticeExport).not.toHaveBeenCalled();
    expect(mocks.validatePracticeExportRestore).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("dry-runs backup restores before touching tenant data", async () => {
    const { db, select } = createRestoreDb();
    const backup = { clients: [] };

    await expect(
      callerWithDb(db).restoreBackup({ backup, dryRun: true }),
    ).resolves.toMatchObject({
      dryRun: true,
      totalRows: 0,
      missingSections: [],
      restoreErrors: [],
    });

    expect(mocks.summarizePracticeExport).toHaveBeenCalledWith(backup);
    expect(mocks.validatePracticeExportRestore).toHaveBeenCalledWith(backup);
    expect(mocks.validatePracticeFileRestoreTarget).toHaveBeenCalledWith(
      backup,
      PRACTICE_ID,
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("reports invalid restore references during dry-run", async () => {
    const { db, select } = createRestoreDb();
    mocks.validatePracticeExportRestore.mockReturnValueOnce({
      valid: false,
      errors: [
        'patients[patient-1].clientId references missing clients row "client-1".',
      ],
    });

    await expect(
      callerWithDb(db).restoreBackup({ backup: { clients: [] }, dryRun: true }),
    ).resolves.toMatchObject({
      dryRun: true,
      restoreErrors: [
        'patients[patient-1].clientId references missing clients row "client-1".',
      ],
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("reports a file-bearing backup that cannot target this practice", async () => {
    const { db, select } = createRestoreDb();
    mocks.validatePracticeFileRestoreTarget.mockReturnValueOnce({
      valid: false,
      errors: [
        "This database backup contains attachment manifests but not the attachment files.",
      ],
    });

    await expect(
      callerWithDb(db).restoreBackup({ backup: { files: [{}] }, dryRun: true }),
    ).resolves.toMatchObject({
      dryRun: true,
      restoreErrors: [expect.stringContaining("attachment manifests")],
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("rejects sealed signed-consent evidence from the web restore path", async () => {
    const { db, select } = createRestoreDb();
    mocks.practiceBackupContainsSealedConsentEvidence.mockReturnValueOnce(true);

    await expect(
      callerWithDb(db).restoreBackup({
        backup: { signedConsentEvidence: [{ id: "sealed-consent" }] },
        dryRun: false,
        confirmFreshPractice: true,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("database-owner recovery workflow"),
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("rejects legacy consent-signature manifests before web restore starts", async () => {
    const { db, select } = createRestoreDb();
    mocks.validatePracticeExportRestore.mockReturnValueOnce({
      valid: false,
      errors: [
        "This legacy backup contains signed-consent files or dependent treatment-plan decisions without their signed consent evidence; a format v9 export or full database recovery is required.",
      ],
    });

    await expect(
      callerWithDb(db).restoreBackup({
        backup: {
          formatVersion: 8,
          files: [{ source: "consent_signature" }],
        },
        dryRun: false,
        confirmFreshPractice: true,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "format v9 export or full database recovery",
      ),
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(
      mocks.practiceBackupContainsSealedConsentEvidence,
    ).toHaveBeenCalled();
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("refuses live restore when backup references are invalid", async () => {
    const { db, select } = createRestoreDb();
    mocks.validatePracticeExportRestore.mockReturnValueOnce({
      valid: false,
      errors: [
        'patientWeights[weight-1].patientId references missing patients row "patient-1".',
      ],
    });

    await expect(
      callerWithDb(db).restoreBackup({
        backup: { clients: [] },
        dryRun: false,
        confirmFreshPractice: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("requires explicit fresh-practice confirmation before restoring", async () => {
    const { db, select, transaction } = createRestoreDb();

    await expect(
      callerWithDb(db).restoreBackup({
        backup: { clients: [] },
        dryRun: false,
        confirmFreshPractice: false,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("rejects backup restores when the practice is missing or deleted", async () => {
    const { db, select } = createRestoreDb([[], [], [], []], []);

    await expect(
      callerWithDb(db).restoreBackup({ backup: { clients: [] }, dryRun: true }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("refuses to restore into practices with core records", async () => {
    const { db, transaction } = createRestoreDb([
      [{ id: "client-1" }],
      [],
      [],
      [],
    ]);

    await expect(
      callerWithDb(db).restoreBackup({
        backup: { clients: [] },
        dryRun: false,
        confirmFreshPractice: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).not.toHaveBeenCalled();
  });

  it("restores a complete backup into an empty confirmed practice", async () => {
    const { db, tx, transaction } = createRestoreDb();
    mocks.restorePracticeData.mockResolvedValueOnce({
      restored: { clients: 1 },
      totalRows: 1,
    });

    await expect(
      callerWithDb(db).restoreBackup({
        backup: { clients: [] },
        dryRun: false,
        confirmFreshPractice: true,
      }),
    ).resolves.toEqual({
      dryRun: false,
      restored: { clients: 1 },
      totalRows: 1,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(mocks.restorePracticeData).toHaveBeenCalledWith(
      tx,
      PRACTICE_ID,
      { clients: [] },
      { recoveryHoldDb: expect.anything() },
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      tx,
      PRACTICE_ID,
      "data.restoreBackup",
    );
  });
});

describe("data CSV export safety", () => {
  const source = readFileSync(
    new URL("../routers/data.ts", import.meta.url),
    "utf8",
  );

  function scopedJoinPattern(
    joinMethod: "innerJoin" | "leftJoin",
    table: string,
    foreignKey: string,
  ) {
    return new RegExp(
      `${joinMethod}\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
        ".",
        "\\.",
      )}, ${table}\\.id\\),[\\s\\S]*?eq\\(${table}\\.practiceId, ctx\\.practiceId\\),[\\s\\S]*?isNull\\(${table}\\.deletedAt\\)[\\s\\S]*?\\)\\s*\\)`,
      "s",
    );
  }

  it("scopes patient export client display rows to the active tenant", () => {
    expect(source).toMatch(
      scopedJoinPattern("innerJoin", "clients", "patients.clientId"),
    );
  });

  it("scopes appointment export entity joins to active tenant rows", () => {
    for (const [table, foreignKey] of [
      ["patients", "appointments.patientId"],
      ["clients", "appointments.clientId"],
      ["appointmentTypes", "appointments.typeId"],
    ]) {
      expect(source).toMatch(scopedJoinPattern("leftJoin", table, foreignKey));
    }
  });

  it("preserves exported doctor attribution after staff deactivation", () => {
    expect(source).toMatch(
      /leftJoin\(\s*users,\s*and\(\s*eq\(appointments\.doctorId, users\.id\),[\s\S]*?eq\(users\.practiceId, ctx\.practiceId\),?[\s\S]*?\)\s*\)/s,
    );
    expect(source).not.toMatch(
      /eq\(appointments\.doctorId, users\.id\)[\s\S]{0,180}?isNull\(users\.deletedAt\)/s,
    );
  });

  it("keeps appointment export patient names scoped to the appointment client", () => {
    const patientJoin = source.match(
      /\.from\(appointments\)[\s\S]+?\.leftJoin\(\s*patients,[\s\S]+?\)\s*\.leftJoin\(\s*clients,/,
    )?.[0];

    expect(patientJoin).toContain(
      "eq(patients.clientId, appointments.clientId)",
    );
  });

  it("scopes invoice export display joins to active tenant rows", () => {
    expect(source).toMatch(
      scopedJoinPattern("innerJoin", "clients", "invoices.clientId"),
    );
    expect(source).toMatch(
      scopedJoinPattern("leftJoin", "patients", "invoices.patientId"),
    );
  });

  it("keeps invoice export patient names scoped to the invoice client", () => {
    const patientJoin = source.match(
      /\.from\(invoices\)[\s\S]+?\.leftJoin\(\s*patients,[\s\S]+?\)\s*\.where/,
    )?.[0];

    expect(patientJoin).toContain("eq(patients.clientId, invoices.clientId)");
  });

  it("fetches invoice export items through the selected tenant invoices", () => {
    const itemLookup = source.match(
      /\.from\(invoiceItems\)[\s\S]+?for \(const item of allItems\)/,
    )?.[0];

    expect(itemLookup).toContain("inArray(invoiceItems.invoiceId, invoiceIds)");
    expect(itemLookup).toContain(
      "where ${invoices.id} = ${invoiceItems.invoiceId}",
    );
    expect(itemLookup).toContain(
      "and ${invoices.practiceId} = ${ctx.practiceId}",
    );
    expect(itemLookup).toContain("and ${invoices.deletedAt} is null");
    expect(itemLookup).toContain("activePracticePredicate(ctx.practiceId)");
    expect(itemLookup).toContain("isNull(invoiceItems.deletedAt)");
  });

  it("fails data export/import paths closed when the practice is inactive", () => {
    expect(source).toContain("function activePracticeWhere");
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain("await assertActivePractice(ctx)");
  });
});
