import type { Database } from "@openpims/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_PREVIEW_TTL_MS,
  MigrationPreviewError,
  claimMigrationPreview,
  completeMigrationRun,
  createMigrationPreview,
  migrationFileHash,
} from "../run-ledger";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-0000000000bb";
const PREVIEW_TOKEN = "00000000-0000-0000-0000-0000000000cc";
const NOW = new Date("2026-08-08T12:00:00.000Z");

function makeDb(
  returningRows: Array<{ id: string }> = [],
  runRows: unknown[] = [],
) {
  const selectResults = [[{ id: PRACTICE_ID }], runRows];
  const selectFor = vi.fn(
    async (_mode: unknown) => selectResults.shift() ?? [],
  );
  const selectLimit = vi.fn((_limit: number) => ({ for: selectFor }));
  const selectWhere = vi.fn((_condition: unknown) => ({ limit: selectLimit }));
  const selectFrom = vi.fn((_table: unknown) => ({ where: selectWhere }));
  const select = vi.fn((_selection: unknown) => ({ from: selectFrom }));
  const insertValues = vi.fn(async (_values: unknown) => undefined);
  const insert = vi.fn((_table: unknown) => ({ values: insertValues }));
  const returning = vi.fn(async (_selection: unknown) => returningRows);
  const where = vi.fn((_condition: unknown) => ({ returning }));
  const set = vi.fn((_values: unknown) => ({ where }));
  const update = vi.fn((_table: unknown) => ({ set }));

  return {
    db: { insert, select, update } as unknown as Database,
    insertValues,
    returning,
    where,
    set,
    selectFor,
    selectWhere,
  };
}

function conditionIncludesColumnValue(
  value: unknown,
  columnName: string,
  expectedValue: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chunk = value as {
    name?: unknown;
    value?: unknown;
    queryChunks?: unknown[];
  };
  if (
    chunk.name === columnName &&
    Object.prototype.hasOwnProperty.call(chunk, "value") &&
    Object.is(chunk.value, expectedValue)
  ) {
    return true;
  }
  if (!Array.isArray(chunk.queryChunks)) {
    return false;
  }

  const hasColumn = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === columnName,
  );
  const hasValue = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      Object.prototype.hasOwnProperty.call(item, "value") &&
      Object.is((item as { value?: unknown }).value, expectedValue),
  );

  return (
    (hasColumn && hasValue) ||
    chunk.queryChunks.some((item) =>
      conditionIncludesColumnValue(item, columnName, expectedValue),
    )
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("migrationFileHash", () => {
  it("binds a preview to the exact CSV bytes, including a trailing newline", () => {
    const csv = "name,email\nAda,ada@example.com";

    expect(migrationFileHash(csv)).toBe(
      "11bcbfcb3959377b9274253d7fa710f8fcc4d35bfa3412b7a9e69101548561c6",
    );
    expect(migrationFileHash(`${csv}\n`)).toBe(
      "1791357b12b2a8f87ed5c5f8f61adcdde1393decdecdaa86d0b2cce6f9320fb2",
    );
    expect(migrationFileHash(`${csv}\n`)).not.toBe(migrationFileHash(csv));
  });
});

describe("createMigrationPreview", () => {
  it("persists only a safe aggregate ledger with the exact hash, size, counts, and TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { db, insertValues, set, where, selectFor } = makeDb();
    const csv = "name,email\nZoë,secret@example.com";

    const token = await createMigrationPreview(db, {
      practiceId: PRACTICE_ID,
      createdBy: USER_ID,
      mode: "patients",
      source: "shepherd",
      csv,
      summary: {
        sourceRowCount: 17,
        plannedInsertCount: 11,
        plannedReconcileCount: 2,
        duplicateCount: 3,
        unmatchedCount: 1,
        errorCount: 4,
      },
    });

    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(selectFor).toHaveBeenCalledWith("update");
    expect(set).toHaveBeenCalledWith({
      status: "superseded",
      supersededAt: NOW,
      updatedAt: NOW,
    });
    const supersedeCondition = where.mock.calls[0]?.[0];
    expect(
      conditionIncludesColumnValue(
        supersedeCondition,
        "practice_id",
        PRACTICE_ID,
      ),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(supersedeCondition, "mode", "patients"),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(supersedeCondition, "status", "previewed"),
    ).toBe(true);
    expect(insertValues).toHaveBeenCalledOnce();

    const persisted = insertValues.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({
      id: token,
      practiceId: PRACTICE_ID,
      createdBy: USER_ID,
      mode: "patients",
      source: "shepherd",
      fileHash: migrationFileHash(csv),
      fileSizeBytes: Buffer.byteLength(csv, "utf8"),
      sourceRowCount: 17,
      plannedInsertCount: 11,
      plannedReconcileCount: 2,
      duplicateCount: 3,
      unmatchedCount: 1,
      errorCount: 4,
      previewExpiresAt: new Date(NOW.getTime() + MIGRATION_PREVIEW_TTL_MS),
    });
    expect(persisted).not.toHaveProperty("csv");
    expect(persisted).not.toHaveProperty("errors");
    expect(JSON.stringify(persisted)).not.toContain("secret@example.com");
  });
});

describe("claimMigrationPreview", () => {
  const identity = {
    practiceId: PRACTICE_ID,
    previewToken: PREVIEW_TOKEN,
    mode: "clients" as const,
    source: "shepherd",
    csv: "name,email\nAda,ada@example.com",
    summary: {
      sourceRowCount: 5,
      plannedInsertCount: 3,
      plannedReconcileCount: 1,
      duplicateCount: 1,
      unmatchedCount: 0,
      errorCount: 0,
    },
  };
  const previewRun = {
    status: "previewed",
    previewExpiresAt: new Date(NOW.getTime() + 60_000),
    sourceRowCount: 5,
    plannedInsertCount: 3,
    plannedReconcileCount: 1,
    duplicateCount: 1,
    unmatchedCount: 0,
    errorCount: 0,
    importedCount: 0,
    reconciledCount: 0,
  };

  it("atomically claims a matching unexpired preview", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { db, set, where, returning, selectWhere } = makeDb(
      [{ id: PREVIEW_TOKEN }],
      [previewRun],
    );

    await expect(claimMigrationPreview(db, identity)).resolves.toEqual({
      alreadyCommitted: false,
    });

    expect(set).toHaveBeenCalledWith({ status: "committing", updatedAt: NOW });
    expect(returning).toHaveBeenCalledOnce();
    const identityCondition = selectWhere.mock.calls[1]?.[0];
    expect(
      conditionIncludesColumnValue(identityCondition, "id", PREVIEW_TOKEN),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(
        identityCondition,
        "practice_id",
        PRACTICE_ID,
      ),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(identityCondition, "mode", "clients"),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(identityCondition, "source", "shepherd"),
    ).toBe(true);
    const claimCondition = where.mock.calls[0]?.[0];
    expect(
      conditionIncludesColumnValue(claimCondition, "status", "previewed"),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(claimCondition, "practice_id", PRACTICE_ID),
    ).toBe(true);
  });

  it("rejects a preview that could not be claimed", async () => {
    const { db } = makeDb([]);

    await expect(claimMigrationPreview(db, identity)).rejects.toEqual(
      new MigrationPreviewError(
        "The import preview expired or no longer matches this file and practice.",
      ),
    );
  });

  it("returns saved counts without claiming an exact committed retry", async () => {
    const { db, set } = makeDb(
      [],
      [
        {
          ...previewRun,
          status: "committed",
          importedCount: 3,
          reconciledCount: 1,
        },
      ],
    );

    await expect(claimMigrationPreview(db, identity)).resolves.toEqual({
      alreadyCommitted: true,
      importedCount: 3,
      reconciledCount: 1,
      errorCount: 0,
    });
    expect(set).not.toHaveBeenCalled();
  });
});

describe("completeMigrationRun", () => {
  const completion = {
    practiceId: PRACTICE_ID,
    previewToken: PREVIEW_TOKEN,
    importedCount: 13,
    reconciledCount: 4,
    committedBy: USER_ID,
  };

  it("records the actor, final counts, and one completion timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { db, set, where, returning } = makeDb([{ id: PREVIEW_TOKEN }]);

    await expect(completeMigrationRun(db, completion)).resolves.toBeUndefined();

    expect(set).toHaveBeenCalledWith({
      status: "committed",
      importedCount: 13,
      reconciledCount: 4,
      committedAt: NOW,
      committedBy: USER_ID,
      updatedAt: NOW,
    });
    expect(returning).toHaveBeenCalledOnce();
    const condition = where.mock.calls[0]?.[0];
    expect(conditionIncludesColumnValue(condition, "id", PREVIEW_TOKEN)).toBe(
      true,
    );
    expect(
      conditionIncludesColumnValue(condition, "practice_id", PRACTICE_ID),
    ).toBe(true);
    expect(
      conditionIncludesColumnValue(condition, "status", "committing"),
    ).toBe(true);
  });

  it("rejects a run that is no longer in the committing state", async () => {
    const { db } = makeDb([]);

    await expect(completeMigrationRun(db, completion)).rejects.toEqual(
      new MigrationPreviewError(
        "The migration run could not be completed safely.",
      ),
    );
  });
});
