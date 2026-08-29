import { desc } from "drizzle-orm";
import { backupRuns } from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

export const BACKUP_FRESHNESS_MAX_AGE_MS = 36 * 60 * 60 * 1_000;

type BackupRunStatus = "ok" | "degraded" | "failed";

export interface BackupRunEvidence {
  startedAt: Date;
  completedAt: Date;
  runDateUtc: string;
  status: BackupRunStatus;
  practices: number;
  primaryVerified: number;
  primaryFailed: number;
  oversized: number;
  nearLimit: number;
  maxExportBytes: number;
  replicaEnabled: boolean;
  replicaRequired: boolean;
  replicaVerified: number;
  replicaFailed: number;
}

export async function recordBackupRunEvidence(
  evidence: BackupRunEvidence,
): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.insert(backupRuns).values(evidence);
  });
}

export async function checkBackupRunFreshness(
  now = new Date(),
): Promise<{ ok: boolean; detail: string }> {
  const [latest] = await withSystem(db, (tx) =>
    tx
      .select({
        completedAt: backupRuns.completedAt,
        status: backupRuns.status,
        practices: backupRuns.practices,
        primaryVerified: backupRuns.primaryVerified,
        primaryFailed: backupRuns.primaryFailed,
        replicaRequired: backupRuns.replicaRequired,
        replicaVerified: backupRuns.replicaVerified,
        replicaFailed: backupRuns.replicaFailed,
      })
      .from(backupRuns)
      .orderBy(desc(backupRuns.completedAt), desc(backupRuns.id))
      .limit(1),
  );

  if (!latest) {
    return { ok: false, detail: "No durable backup run evidence exists" };
  }

  const ageMs = now.getTime() - latest.completedAt.getTime();
  if (ageMs < 0 || ageMs > BACKUP_FRESHNESS_MAX_AGE_MS) {
    return { ok: false, detail: "Latest backup run evidence is stale" };
  }

  const primaryComplete =
    latest.status === "ok" &&
    latest.primaryFailed === 0 &&
    latest.primaryVerified === latest.practices;
  if (!primaryComplete) {
    return {
      ok: false,
      detail: `${latest.primaryVerified}/${latest.practices} primary backups verified; ${latest.primaryFailed} failed`,
    };
  }

  if (
    latest.replicaRequired &&
    (latest.replicaFailed > 0 || latest.replicaVerified !== latest.practices)
  ) {
    return {
      ok: false,
      detail: `${latest.replicaVerified}/${latest.practices} required independent backups verified; ${latest.replicaFailed} failed`,
    };
  }

  return {
    ok: true,
    detail: `${latest.primaryVerified}/${latest.practices} primary backups verified in the latest run`,
  };
}
