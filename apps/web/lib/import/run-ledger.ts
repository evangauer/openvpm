import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { migrationRuns, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";

export const MIGRATION_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export class MigrationPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPreviewError";
  }
}

export type MigrationRunMode =
  | "clients"
  | "patients"
  | "vaccinations"
  | "soap_notes";

export type MigrationPreviewSummary = {
  sourceRowCount: number;
  plannedInsertCount: number;
  plannedReconcileCount?: number;
  duplicateCount?: number;
  unmatchedCount?: number;
  errorCount: number;
};

export type MigrationClaimResult =
  | { alreadyCommitted: false }
  | {
      alreadyCommitted: true;
      importedCount: number;
      reconciledCount: number;
      errorCount: number;
    };

type MigrationPreviewIdentity = {
  practiceId: string;
  mode: MigrationRunMode;
  source: string;
  csv: string;
  summary: MigrationPreviewSummary;
};

export async function lockMigrationPractice(
  db: Database,
  practiceId: string,
): Promise<void> {
  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("update");

  if (!practice) {
    throw new MigrationPreviewError("The practice is no longer available.");
  }
}

export function migrationFileHash(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex");
}

export async function createMigrationPreview(
  db: Database,
  input: MigrationPreviewIdentity & { createdBy: string },
): Promise<string> {
  const id = randomUUID();
  const supersededAt = new Date();
  await lockMigrationPractice(db, input.practiceId);
  await db
    .update(migrationRuns)
    .set({
      status: "superseded",
      supersededAt,
      updatedAt: supersededAt,
    })
    .where(
      and(
        eq(migrationRuns.practiceId, input.practiceId),
        eq(migrationRuns.mode, input.mode),
        eq(migrationRuns.status, "previewed"),
        isNull(migrationRuns.deletedAt),
      ),
    );
  await db.insert(migrationRuns).values({
    id,
    practiceId: input.practiceId,
    createdBy: input.createdBy,
    mode: input.mode,
    source: input.source,
    fileHash: migrationFileHash(input.csv),
    fileSizeBytes: Buffer.byteLength(input.csv, "utf8"),
    sourceRowCount: input.summary.sourceRowCount,
    plannedInsertCount: input.summary.plannedInsertCount,
    plannedReconcileCount: input.summary.plannedReconcileCount ?? 0,
    duplicateCount: input.summary.duplicateCount ?? 0,
    unmatchedCount: input.summary.unmatchedCount ?? 0,
    errorCount: input.summary.errorCount,
    previewExpiresAt: new Date(Date.now() + MIGRATION_PREVIEW_TTL_MS),
  });
  return id;
}

export async function claimMigrationPreview(
  db: Database,
  input: MigrationPreviewIdentity & { previewToken: string },
): Promise<MigrationClaimResult> {
  await lockMigrationPractice(db, input.practiceId);
  const [run] = await db
    .select({
      status: migrationRuns.status,
      previewExpiresAt: migrationRuns.previewExpiresAt,
      sourceRowCount: migrationRuns.sourceRowCount,
      plannedInsertCount: migrationRuns.plannedInsertCount,
      plannedReconcileCount: migrationRuns.plannedReconcileCount,
      duplicateCount: migrationRuns.duplicateCount,
      unmatchedCount: migrationRuns.unmatchedCount,
      errorCount: migrationRuns.errorCount,
      importedCount: migrationRuns.importedCount,
      reconciledCount: migrationRuns.reconciledCount,
    })
    .from(migrationRuns)
    .where(
      and(
        eq(migrationRuns.id, input.previewToken),
        eq(migrationRuns.practiceId, input.practiceId),
        eq(migrationRuns.mode, input.mode),
        eq(migrationRuns.source, input.source),
        eq(migrationRuns.fileHash, migrationFileHash(input.csv)),
        isNull(migrationRuns.deletedAt),
      ),
    )
    .limit(1)
    .for("update");

  if (!run) {
    throw new MigrationPreviewError(
      "The import preview expired or no longer matches this file and practice.",
    );
  }
  if (run.status === "committed") {
    return {
      alreadyCommitted: true,
      importedCount: run.importedCount,
      reconciledCount: run.reconciledCount,
      errorCount: run.errorCount,
    };
  }

  const expected = {
    sourceRowCount: input.summary.sourceRowCount,
    plannedInsertCount: input.summary.plannedInsertCount,
    plannedReconcileCount: input.summary.plannedReconcileCount ?? 0,
    duplicateCount: input.summary.duplicateCount ?? 0,
    unmatchedCount: input.summary.unmatchedCount ?? 0,
    errorCount: input.summary.errorCount,
  };
  const previewMatches =
    run.status === "previewed" &&
    run.previewExpiresAt.getTime() > Date.now() &&
    run.sourceRowCount === expected.sourceRowCount &&
    run.plannedInsertCount === expected.plannedInsertCount &&
    run.plannedReconcileCount === expected.plannedReconcileCount &&
    run.duplicateCount === expected.duplicateCount &&
    run.unmatchedCount === expected.unmatchedCount &&
    run.errorCount === expected.errorCount;
  if (!previewMatches) {
    throw new MigrationPreviewError(
      "The import preview expired or no longer matches this file and practice.",
    );
  }

  const [claimed] = await db
    .update(migrationRuns)
    .set({ status: "committing", updatedAt: new Date() })
    .where(
      and(
        eq(migrationRuns.id, input.previewToken),
        eq(migrationRuns.practiceId, input.practiceId),
        eq(migrationRuns.status, "previewed"),
        isNull(migrationRuns.deletedAt),
      ),
    )
    .returning({ id: migrationRuns.id });

  if (!claimed) {
    throw new MigrationPreviewError(
      "The import preview expired or no longer matches this file and practice.",
    );
  }
  return { alreadyCommitted: false };
}

export async function completeMigrationRun(
  db: Database,
  input: {
    practiceId: string;
    previewToken: string;
    importedCount: number;
    reconciledCount?: number;
    committedBy: string;
  },
): Promise<void> {
  const committedAt = new Date();
  const [completed] = await db
    .update(migrationRuns)
    .set({
      status: "committed",
      importedCount: input.importedCount,
      reconciledCount: input.reconciledCount ?? 0,
      committedAt,
      committedBy: input.committedBy,
      updatedAt: committedAt,
    })
    .where(
      and(
        eq(migrationRuns.id, input.previewToken),
        eq(migrationRuns.practiceId, input.practiceId),
        eq(migrationRuns.status, "committing"),
        isNull(migrationRuns.deletedAt),
      ),
    )
    .returning({ id: migrationRuns.id });

  if (!completed) {
    throw new MigrationPreviewError(
      "The migration run could not be completed safely.",
    );
  }
}
