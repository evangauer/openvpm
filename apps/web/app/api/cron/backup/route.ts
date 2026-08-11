import { NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { exportPracticeData, backupKey } from "@/lib/backup/export";
import {
  readPrimaryObject,
  readReplicaObject,
  normalizeS3VersionId,
  replicaStorageIncludesPractice,
  replicaStorageReadiness,
  replicaStorageRolloutEnabled,
  uploadManagedFile,
  uploadReplicaFile,
} from "@/lib/s3";
import { alertOps } from "@/lib/alerts";
import { withSystem, withTenantReadOnlySnapshot } from "@/lib/tenant-db";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { checksumSha256Hex } from "@/lib/file-replication";
import { PRACTICE_BACKUP_JSON_MAX_BYTES } from "@/lib/backup/policy";
import {
  databaseBackupReplicaCatalog,
  databaseBackupReplicaKey,
} from "@/lib/backup/replica";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function writeAndVerifyReplicaObject(input: {
  key: string;
  body: Buffer;
  checksumSha256: string;
}): Promise<{ etag?: string; versionId: string }> {
  let write: Awaited<ReturnType<typeof uploadReplicaFile>> | undefined;
  let writeError: unknown;
  try {
    write = await uploadReplicaFile(
      input.key,
      input.body,
      "application/json",
      input.checksumSha256,
    );
  } catch (error) {
    // The deterministic checksum-addressed key makes an ambiguous PUT safe to
    // converge through a bounded read-back of the exact expected bytes.
    writeError = error;
  }

  const requestedVersionId = normalizeS3VersionId(write?.versionId);
  const verification = await readReplicaObject(input.key, {
    maxBytes: input.body.byteLength,
    ...(requestedVersionId ? { versionId: requestedVersionId } : {}),
  });
  const verifiedVersionId =
    verification.status === "available"
      ? normalizeS3VersionId(verification.versionId)
      : undefined;
  if (
    verification.status !== "available" ||
    !verifiedVersionId ||
    (requestedVersionId && verifiedVersionId !== requestedVersionId) ||
    verification.body.byteLength !== input.body.byteLength ||
    checksumSha256Hex(verification.body) !== input.checksumSha256
  ) {
    if (writeError) throw writeError;
    throw new Error("Replica object verification failed");
  }

  return {
    ...((verification.etag ?? write?.etag)
      ? { etag: verification.etag ?? write?.etag }
      : {}),
    versionId: verifiedVersionId,
  };
}

// Scheduled per-practice backup → object storage. A clinic gets a daily,
// restorable JSON snapshot of its data, independent of the live DB.
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const startedAt = new Date();
  const exportedAt = startedAt.toISOString();
  const runDateUtc = exportedAt.slice(0, 10);
  let ok = 0;
  let failed = 0;
  let oversized = 0;
  let nearLimit = 0;
  let maxExportBytes = 0;
  let replicaOk = 0;
  let replicaFailed = 0;

  try {
    // Cross-tenant sweep → system context (RLS bypass).
    const allPractices = await withSystem(db, (tx) =>
      tx
        .select({ id: practices.id, timezone: practices.timezone })
        .from(practices)
        .where(isNull(practices.deletedAt)),
    );

    for (const p of allPractices) {
      try {
        // Export each practice in its own tenant context (RLS-scoped).
        const data = await withTenantReadOnlySnapshot(db, p.id, (tx) =>
          exportPracticeData(tx, p.id, exportedAt),
        );
        const backupDate = formatDateInputForTimeZone(
          startedAt,
          p.timezone?.trim() || "UTC",
        );
        const key = backupKey(p.id, backupDate);
        const body = Buffer.from(JSON.stringify(data));
        maxExportBytes = Math.max(maxExportBytes, body.byteLength);
        if (body.byteLength > PRACTICE_BACKUP_JSON_MAX_BYTES) {
          oversized++;
          throw new Error(
            `backup exceeds the ${PRACTICE_BACKUP_JSON_MAX_BYTES}-byte restore safety limit`,
          );
        }
        if (body.byteLength >= PRACTICE_BACKUP_JSON_MAX_BYTES * 0.8) {
          nearLimit++;
        }
        const checksumSha256 = checksumSha256Hex(body);
        let primaryWrite:
          | Awaited<ReturnType<typeof uploadManagedFile>>
          | undefined;
        let primaryWriteError: unknown;
        try {
          primaryWrite = await uploadManagedFile(
            key,
            body,
            "application/json",
            checksumSha256,
          );
        } catch (error) {
          // A timed-out PUT may still have committed. Read the deterministic
          // daily key before declaring failure so retries converge safely.
          primaryWriteError = error;
        }
        const primaryVersionId = normalizeS3VersionId(primaryWrite?.versionId);
        const primaryVerification = await readPrimaryObject(key, {
          maxBytes: body.length,
          ...(primaryVersionId ? { versionId: primaryVersionId } : {}),
        });
        if (
          primaryVerification.status !== "available" ||
          primaryVerification.body.byteLength !== body.length ||
          checksumSha256Hex(primaryVerification.body) !== checksumSha256
        ) {
          if (primaryWriteError) throw primaryWriteError;
          throw new Error("Primary backup verification failed");
        }

        const replicaReadiness = replicaStorageReadiness();
        const replicaEnabled = replicaStorageRolloutEnabled();
        if (
          replicaEnabled &&
          replicaReadiness.ready &&
          replicaStorageIncludesPractice(p.id)
        ) {
          const replicaKey = databaseBackupReplicaKey({
            practiceId: p.id,
            backupDate,
            checksumSha256,
          });
          try {
            const replicaEvidence = await writeAndVerifyReplicaObject({
              key: replicaKey,
              body,
              checksumSha256,
            });

            const catalog = databaseBackupReplicaCatalog({
              practiceId: p.id,
              backupDate,
              exportedAt,
              objectKey: replicaKey,
              checksumSha256,
              fileSizeBytes: body.byteLength,
              exportFormatVersion: data.formatVersion,
              counts: data.counts,
              objectEtag: replicaEvidence.etag,
              objectVersionId: replicaEvidence.versionId,
            });
            await writeAndVerifyReplicaObject({
              key: catalog.key,
              body: catalog.body,
              checksumSha256: catalog.checksumSha256,
            });
            replicaOk++;
          } catch {
            replicaFailed++;
            void alertOps(
              "Independent practice backup failed",
              `practice ${p.id}: replica write or verification failed`,
            );
          }
        } else if (replicaEnabled && !replicaReadiness.ready) {
          replicaFailed++;
        }
        ok++;
      } catch (err) {
        failed++;
        void alertOps(
          "Practice backup failed",
          `practice ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (failed > 0 || replicaFailed > 0) {
      void alertOps(
        "Scheduled backup had failures",
        `${failed} primary and ${replicaFailed} independent backup copies failed for UTC run ${runDateUtc}.`,
      );
    }

    await reportCronHeartbeat({
      job: "backup",
      status: failed > 0 || replicaFailed > 0 ? "degraded" : "ok",
      detail: `${ok} primary backups succeeded, ${replicaOk} independent copies verified, ${failed + replicaFailed} failed`,
      metrics: {
        practices: allPractices.length,
        ok,
        failed,
        otherFailed: failed - oversized,
        oversized,
        nearLimit,
        maxExportBytes,
        backupMaxBytes: PRACTICE_BACKUP_JSON_MAX_BYTES,
        replicaOk,
        replicaFailed,
      },
    });

    return NextResponse.json({
      date: runDateUtc,
      practices: allPractices.length,
      ok,
      failed,
      otherFailed: failed - oversized,
      oversized,
      nearLimit,
      maxExportBytes,
      replicaOk,
      replicaFailed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Backup cron job crashed", message);
    console.error("Cron backup job failed:", error);
    await reportCronHeartbeat({
      job: "backup",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
