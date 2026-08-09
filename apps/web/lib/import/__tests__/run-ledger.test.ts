import type { Database } from "@openpims/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_PREVIEW_TTL_MS,
  MIGRATION_REVIEWED_PLAN_SCHEMA_VERSION,
  MigrationPreviewError,
  claimMigrationPreview,
  completeMigrationRun,
  createMigrationPreview,
  migrationFileHash,
  migrationReviewedPlanHash,
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

describe("migrationReviewedPlanHash", () => {
  const identity = {
    mode: "patients" as const,
    source: "shepherd",
    csv: "ownerEmail,name,species\nowner@example.com,Rex,canine",
    summary: {
      sourceRowCount: 1,
      plannedInsertCount: 0,
      plannedReconcileCount: 1,
      duplicateCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
    },
  };
  const dispositions = [
    {
      rowIndex: 0,
      entityKind: "patient" as const,
      action: "reconcile" as const,
    },
  ];

  function reviewedPlan(
    targets: Array<{
      rowIndex: number;
      kind: "owner" | "patient" | "client";
      role: "owner_match" | "identity_match" | "external_match";
      targetId: string;
      targetVersion: string | null;
    }>,
    plannerVersion = "patients-v1",
  ) {
    return { plannerVersion, dispositions, targets };
  }

  it("changes when an owner or patient target changes despite identical counts", () => {
    const first = migrationReviewedPlanHash({
      ...identity,
      reviewedPlan: reviewedPlan([
        {
          rowIndex: 0,
          kind: "owner",
          role: "owner_match",
          targetId: "00000000-0000-0000-0000-0000000000c1",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
        {
          rowIndex: 0,
          kind: "patient",
          role: "identity_match",
          targetId: "00000000-0000-0000-0000-0000000000d1",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
      ]),
    });
    const ownerSwap = migrationReviewedPlanHash({
      ...identity,
      reviewedPlan: reviewedPlan([
        {
          rowIndex: 0,
          kind: "owner",
          role: "owner_match",
          targetId: "00000000-0000-0000-0000-0000000000c2",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
        {
          rowIndex: 0,
          kind: "patient",
          role: "identity_match",
          targetId: "00000000-0000-0000-0000-0000000000d1",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
      ]),
    });
    const patientSwap = migrationReviewedPlanHash({
      ...identity,
      reviewedPlan: reviewedPlan([
        {
          rowIndex: 0,
          kind: "owner",
          role: "owner_match",
          targetId: "00000000-0000-0000-0000-0000000000c1",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
        {
          rowIndex: 0,
          kind: "patient",
          role: "identity_match",
          targetId: "00000000-0000-0000-0000-0000000000d2",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
      ]),
    });

    expect(ownerSwap).not.toBe(first);
    expect(patientSwap).not.toBe(first);
  });

  it("changes when the selected target version changes", () => {
    const reviewedTargets = [
      {
        rowIndex: 0,
        kind: "client" as const,
        role: "identity_match" as const,
        targetId: "00000000-0000-0000-0000-0000000000c1",
        targetVersion: "2026-08-08T12:00:00.000Z",
      },
    ];

    expect(
      migrationReviewedPlanHash({
        ...identity,
        reviewedPlan: reviewedPlan(reviewedTargets),
      }),
    ).not.toBe(
      migrationReviewedPlanHash({
        ...identity,
        reviewedPlan: reviewedPlan([
          {
            ...reviewedTargets[0],
            targetVersion: "2026-08-08T12:01:00.000Z",
          },
        ]),
      }),
    );
  });

  it("changes when same-count row dispositions are swapped", () => {
    const rows = {
      ...identity,
      summary: {
        ...identity.summary,
        sourceRowCount: 2,
        plannedInsertCount: 1,
        plannedReconcileCount: 0,
        duplicateCount: 1,
      },
    };
    const first = migrationReviewedPlanHash({
      ...rows,
      reviewedPlan: {
        plannerVersion: "patients-v1",
        dispositions: [
          { rowIndex: 0, entityKind: "patient", action: "insert" },
          { rowIndex: 1, entityKind: "patient", action: "duplicate" },
        ],
        targets: [],
      },
    });
    const swapped = migrationReviewedPlanHash({
      ...rows,
      reviewedPlan: {
        plannerVersion: "patients-v1",
        dispositions: [
          { rowIndex: 0, entityKind: "patient", action: "duplicate" },
          { rowIndex: 1, entityKind: "patient", action: "insert" },
        ],
        targets: [],
      },
    });

    expect(swapped).not.toBe(first);
  });

  it("binds history row dispositions and versioned patient targets", () => {
    const history = {
      mode: "vaccinations" as const,
      source: "shepherd",
      csv: [
        "Patient ID,Vaccine,Date Given",
        "P-1,Rabies,2025-01-01",
        "P-2,DHPP,2025-01-02",
      ].join("\n"),
      summary: {
        sourceRowCount: 2,
        plannedInsertCount: 1,
        duplicateCount: 1,
        unmatchedCount: 0,
        errorCount: 1,
      },
    };
    const reviewedPlan = {
      plannerVersion: "vaccinations-v1",
      dispositions: [
        {
          rowIndex: 0,
          entityKind: "vaccination" as const,
          action: "insert" as const,
        },
        {
          rowIndex: 1,
          entityKind: "vaccination" as const,
          action: "duplicate" as const,
        },
      ],
      targets: [
        {
          rowIndex: 0,
          kind: "patient" as const,
          role: "external_match" as const,
          targetId: "00000000-0000-0000-0000-0000000000d1",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
        {
          rowIndex: 1,
          kind: "patient" as const,
          role: "external_match" as const,
          targetId: "00000000-0000-0000-0000-0000000000d2",
          targetVersion: "2026-08-08T12:00:00.000Z",
        },
      ],
    };
    const reviewedHash = migrationReviewedPlanHash({
      ...history,
      reviewedPlan,
    });

    expect(
      migrationReviewedPlanHash({
        ...history,
        reviewedPlan: {
          ...reviewedPlan,
          dispositions: [
            { ...reviewedPlan.dispositions[0], action: "duplicate" as const },
            { ...reviewedPlan.dispositions[1], action: "insert" as const },
          ],
        },
      }),
    ).not.toBe(reviewedHash);
    expect(
      migrationReviewedPlanHash({
        ...history,
        reviewedPlan: {
          ...reviewedPlan,
          targets: [
            {
              ...reviewedPlan.targets[0],
              targetVersion: "2026-08-08T12:01:00.000Z",
            },
            reviewedPlan.targets[1],
          ],
        },
      }),
    ).not.toBe(reviewedHash);
  });

  it("requires a deliberate planner version and schema version", () => {
    expect(MIGRATION_REVIEWED_PLAN_SCHEMA_VERSION).toBe(1);
    expect(
      migrationReviewedPlanHash({
        ...identity,
        reviewedPlan: reviewedPlan([], "patients-v1"),
      }),
    ).not.toBe(
      migrationReviewedPlanHash({
        ...identity,
        reviewedPlan: reviewedPlan([], "patients-v2"),
      }),
    );
  });
});

describe("createMigrationPreview", () => {
  it("persists only a safe aggregate ledger with the exact hash, size, counts, and TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { db, insertValues, set, where, selectFor } = makeDb();
    const csv = "name,email\nZoë,secret@example.com";
    const reviewedPlan = {
      plannerVersion: "patients-v1",
      dispositions: [
        {
          rowIndex: 0,
          entityKind: "patient" as const,
          action: "reconcile" as const,
        },
      ],
      targets: [
        {
          rowIndex: 0,
          kind: "patient" as const,
          role: "identity_match" as const,
          targetId: "00000000-0000-0000-0000-0000000000d1",
          targetVersion: "2026-08-08T11:59:00.000Z",
        },
      ],
    };

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
      reviewedPlan,
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
      reviewedPlanHash: migrationReviewedPlanHash({
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
        reviewedPlan,
      }),
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
    expect(persisted).not.toHaveProperty("reviewedPlan");
    expect(JSON.stringify(persisted)).not.toContain("secret@example.com");
    expect(JSON.stringify(persisted)).not.toContain(
      reviewedPlan.targets[0].targetId,
    );
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
    reviewedPlanHash: migrationReviewedPlanHash(identity),
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

  it("returns saved counts for an exact-file token after its committed targets changed", async () => {
    const { db, set } = makeDb(
      [],
      [
        {
          ...previewRun,
          status: "committed",
          reviewedPlanHash: "f".repeat(64),
          importedCount: 3,
          reconciledCount: 1,
        },
      ],
    );

    await expect(
      claimMigrationPreview(db, {
        ...identity,
        reviewedPlan: {
          plannerVersion: "clients-v2",
          dispositions: [
            { rowIndex: 0, entityKind: "client", action: "duplicate" },
          ],
          targets: [
            {
              rowIndex: 0,
              kind: "client",
              role: "identity_match",
              targetId: "00000000-0000-0000-0000-0000000000dd",
              targetVersion: "2026-08-08T12:01:00.000Z",
            },
          ],
        },
      }),
    ).resolves.toEqual({
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
