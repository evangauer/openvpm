import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { controlledSubstancesRouter } = await import(
  "../routers/controlled-substances"
);
const { LIST_OFFSET_MAX } = await import("../routers/pagination");
const {
  CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH,
} = await import("@/lib/controlled-substances/policy");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PATIENT_ID = "00000000-0000-0000-0000-000000000002";
const WITNESS_ID = "00000000-0000-0000-0000-000000000003";
const ENTRY_ID = "00000000-0000-0000-0000-000000000004";

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
  return controlledSubstancesRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      groupBy: vi.fn(() => afterWhere),
      limit: vi.fn(() => afterWhere),
      offset: vi.fn(async () => result),
      orderBy: vi.fn(() => afterWhere),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      offset: vi.fn(() => builder),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const execute = vi.fn(async () => undefined);
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  const db: Record<string, unknown> = {
    transaction,
    execute,
    select,
    insert,
  };

  return { db, select, insertValues, execute, transaction };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("controlled substance log safety", () => {
  it("exposes the practice timezone for controlled-substance log timestamps", async () => {
    const { db } = createDb({
      selectResults: [[{ timezone: "America/Los_Angeles" }]],
    });

    await expect(callerWithDb(db).settings()).resolves.toEqual({
      timezone: "America/Los_Angeles",
    });
  });

  it("lists active staff witness options for the current practice", async () => {
    const { db } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: WITNESS_ID, name: "Witness", role: "technician" }],
      ],
    });

    await expect(callerWithDb(db).listWitnesses()).resolves.toEqual([
      { id: WITNESS_ID, name: "Witness", role: "technician" },
    ]);
  });

  it("requires a patient when administering a controlled substance", async () => {
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "administered",
        quantity: "1.5",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires a witness when wasting a controlled substance", async () => {
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "wasted",
        quantity: "0.2",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects non-positive quantities", async () => {
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "-1",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects quantities that do not fit the controlled-substance numeric column", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.2345",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "10000000",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects invalid controlled-substance dates before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).list({
        startDate: "2026-02-31",
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
      callerWithDb(db).summary({
        startDate: "2026-06-28",
        endDate: "2026-06-27",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "ml",
        performedAt: "2026-06-27",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects reads and writes when the practice is missing or deleted", async () => {
    const { db, select, insertValues } = createDb({
      selectResults: [[], [], [], [], []],
    });

    await expect(callerWithDb(db).settings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(callerWithDb(db).listWitnesses()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).list({ limit: 25, offset: 0 })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(callerWithDb(db).summary({})).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "ml",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(select).toHaveBeenCalledTimes(5);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("lists controlled-substance logs within practice-local date filters", async () => {
    const row = {
      id: ENTRY_ID,
      drugName: "Ketamine",
      performedAt: new Date("2026-07-01T16:00:00.000Z"),
    };
    const { db, select } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ timezone: "America/Los_Angeles" }],
        [row],
        [{ count: 1 }],
      ],
    });

    await expect(
      callerWithDb(db).list({
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        limit: 25,
        offset: 0,
      })
    ).resolves.toEqual({ items: [row], total: 1 });

    expect(select).toHaveBeenCalledTimes(4);
  });

  it("summarizes controlled-substance logs within practice-local date filters", async () => {
    const row = {
      drugName: "Ketamine",
      unit: "ml",
      totalReceived: "10",
      totalAdministered: "1.5",
      totalWasted: "0.2",
      totalReturned: "0",
    };
    const { db, select } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ timezone: "America/Los_Angeles" }],
        [row],
      ],
    });

    await expect(
      callerWithDb(db).summary({
        startDate: "2026-07-01",
        endDate: "2026-07-01",
      })
    ).resolves.toEqual([row]);

    expect(select).toHaveBeenCalledTimes(3);
  });

  it("rejects overlong controlled-substance text before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).list({
        drugName: "k".repeat(CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH + 1),
        limit: 25,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "m".repeat(CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "K".repeat(CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH + 1),
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "ml",
        lotNumber: "L".repeat(CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "ml",
        notes: "n".repeat(CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("trims controlled-substance text before writing", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: ENTRY_ID, patientId: null }],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "  Ketamine  ",
        deaSchedule: "III",
        action: "received",
        quantity: "1.5",
        unit: "  ml  ",
        lotNumber: "  LOT-42  ",
        notes: "  Initial stock count  ",
      })
    ).resolves.toMatchObject({ id: ENTRY_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        drugName: "Ketamine",
        unit: "ml",
        lotNumber: "LOT-42",
        notes: "Initial stock count",
      })
    );
  });

  it("requires administered patients to belong to the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "administered",
        quantity: "1.5",
        unit: "ml",
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("requires waste witnesses to belong to the practice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }], []],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "wasted",
        quantity: "0.2",
        unit: "ml",
        witnessedBy: WITNESS_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects administered, wasted, and returned entries that would overdraw the ledger balance", async () => {
    const balance = {
      totalReceived: "2.000",
      totalAdministered: "1.500",
      totalWasted: "0.250",
      totalReturned: "0",
    };

    const { db, execute, insertValues, transaction } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PATIENT_ID }],
        [balance],
        [{ id: PRACTICE_ID }],
        [{ id: WITNESS_ID }],
        [balance],
        [{ id: PRACTICE_ID }],
        [balance],
      ],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "administered",
        quantity: "0.251",
        unit: "ml",
        patientId: PATIENT_ID,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Insufficient Ketamine balance: 0.25 ml available.",
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "wasted",
        quantity: "0.251",
        unit: "ml",
        witnessedBy: WITNESS_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "returned",
        quantity: "0.251",
        unit: "ml",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(transaction).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("records an administered dose after validating the patient", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: PATIENT_ID }],
        [
          {
            totalReceived: "10.000",
            totalAdministered: "0",
            totalWasted: "0",
            totalReturned: "0",
          },
        ],
      ],
      insertedRows: [{ id: ENTRY_ID, patientId: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "administered",
        quantity: "1.5",
        unit: "ml",
        patientId: PATIENT_ID,
      })
    ).resolves.toMatchObject({ id: ENTRY_ID, patientId: PATIENT_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        performedBy: USER_ID,
      })
    );
  });

  it("records an explicit performed timestamp after validation", async () => {
    const { db, execute, insertValues, transaction } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: ENTRY_ID, patientId: null }],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received",
        quantity: "1.500",
        unit: "ml",
        performedAt: "2026-06-27T14:30:00.000Z",
      })
    ).resolves.toMatchObject({ id: ENTRY_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        performedBy: USER_ID,
        performedAt: expect.any(Date),
      })
    );
    const [values] = insertValues.mock.calls[0] as unknown as [
      { performedAt: Date },
    ];
    expect(values.performedAt.toISOString()).toBe("2026-06-27T14:30:00.000Z");
    expect(transaction).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  it("records waste after validating the witness", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: WITNESS_ID }],
        [
          {
            totalReceived: "10.000",
            totalAdministered: "0",
            totalWasted: "0",
            totalReturned: "0",
          },
        ],
      ],
      insertedRows: [{ id: ENTRY_ID, witnessedBy: WITNESS_ID }],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "wasted",
        quantity: "0.2",
        unit: "ml",
        witnessedBy: WITNESS_ID,
      })
    ).resolves.toMatchObject({ id: ENTRY_ID, witnessedBy: WITNESS_ID });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        witnessedBy: WITNESS_ID,
        performedBy: USER_ID,
      })
    );
  });

  it("records returned stock only when balance is available", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: PRACTICE_ID }],
        [
          {
            totalReceived: "10.000",
            totalAdministered: "1.000",
            totalWasted: "0.250",
            totalReturned: "0",
          },
        ],
      ],
      insertedRows: [{ id: ENTRY_ID, action: "returned" }],
    });

    await expect(
      callerWithDb(db).create({
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "returned",
        quantity: "2.5",
        unit: "ml",
      })
    ).resolves.toMatchObject({ id: ENTRY_ID, action: "returned" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "returned",
        quantity: "2.5",
      })
    );
  });
});

describe("controlled substance list scoping", () => {
  const source = readFileSync(
    new URL("../routers/controlled-substances.ts", import.meta.url),
    "utf8"
  );

  it("keeps patients active while preserving former-staff ledger attribution", () => {
    expect(source).toMatch(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(controlledSubstanceLog\.patientId, patients\.id\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toMatch(
      /leftJoin\(\s*performer,\s*and\(\s*eq\(controlledSubstanceLog\.performedBy, performer\.id\),\s*eq\(performer\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\)\s*,?\s*\)\s*\)/s
    );
    expect(source).toMatch(
      /leftJoin\(\s*witness,\s*and\(\s*eq\(controlledSubstanceLog\.witnessedBy, witness\.id\),\s*eq\(witness\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\)\s*,?\s*\)\s*\)/s
    );
    expect(source).not.toMatch(
      /eq\(controlledSubstanceLog\.performedBy, performer\.id\)[\s\S]{0,180}?isNull\(performer\.deletedAt\)/s
    );
    expect(source).not.toMatch(
      /eq\(controlledSubstanceLog\.witnessedBy, witness\.id\)[\s\S]{0,180}?isNull\(witness\.deletedAt\)/s
    );
  });

  it("requires an active practice for controlled-substance reads and writes", () => {
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("await assertActivePractice(ctx)");
    expect(source).toContain("await assertActivePractice(txCtx)");
    expect(source).not.toContain("practice?.timezone");
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(8);
    expect(source).toMatch(
      /eq\(controlledSubstanceLog\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(controlledSubstanceLog\.deletedAt\)/
    );
  });

  it("uses the practice timezone for list and summary date filters", () => {
    expect(source).toContain(
      "const range = await controlledSubstanceDateRange(ctx, input)"
    );
    expect(source).toContain("dateInputDayUtcRange(value, timeZone).start");
    expect(source).toContain("return new Date(end.getTime() - 1)");
  });

  it("serializes same-drug ledger writes before checking balance", () => {
    expect(source).toContain("return ctx.db.transaction(async (tx) => {");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("await lockControlledSubstanceLedger(txCtx, input)");
    expect(source).toContain("await assertControlledSubstanceBalance(txCtx, input)");
  });
});
