#!/usr/bin/env node

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, isNull } from "drizzle-orm";
import { files } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  assertLegacyRecoveryDatabaseIdentity,
  assertLegacyRecoveryStorageSeparation,
  bytesMatch,
  inspectLegacyFileBytes,
  parseLegacyFileRecoveryArgs,
  resolveLegacyRecoveryChecksum,
} from "../lib/legacy-file-recovery";
import { UPLOAD_FILE_MAX_BYTES } from "../lib/upload-limits";
import { isAllowedUploadCategory } from "../lib/upload-security";

type Candidate = {
  id: string;
  practiceId: string;
  fileKey: string;
  fileUrl: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  checksumSha256: string | null;
  storageStatus: (typeof files.$inferSelect)["storageStatus"];
  category: string | null;
};

class OperatorSafeError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OperatorSafeError(`${name} is required.`);
  return value;
}

function legacyClient(): { client: S3Client; bucket: string } {
  const endpoint = requiredEnv("LEGACY_FILE_S3_ENDPOINT");
  const region = requiredEnv("LEGACY_FILE_S3_REGION");
  const accessKeyId = requiredEnv("LEGACY_FILE_S3_ACCESS_KEY");
  const secretAccessKey = requiredEnv("LEGACY_FILE_S3_SECRET_KEY");
  const bucket = requiredEnv("LEGACY_FILE_S3_BUCKET");

  try {
    assertLegacyRecoveryStorageSeparation({
      legacyEndpoint: endpoint,
      legacyBucket: bucket,
      primaryProvider: process.env.FILE_STORAGE_PROVIDER,
      primaryEndpoint: process.env.S3_ENDPOINT,
      primaryBucket: process.env.S3_BUCKET,
      replicaProvider: process.env.FILE_REPLICA_PROVIDER,
      replicaEndpoint: process.env.FILE_REPLICA_S3_ENDPOINT,
      replicaBucket: process.env.FILE_REPLICA_S3_BUCKET,
    });
  } catch (error) {
    throw new OperatorSafeError(
      error instanceof Error ? error.message : "Storage targets are invalid.",
    );
  }

  return {
    client: new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    }),
    bucket,
  };
}

async function readLegacyObject(input: {
  client: S3Client;
  bucket: string;
  key: string;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await input.client.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      { abortSignal: controller.signal },
    );
    if (
      typeof response.ContentLength === "number" &&
      response.ContentLength > UPLOAD_FILE_MAX_BYTES
    ) {
      throw new OperatorSafeError(
        "Legacy object exceeds the supported file limit.",
      );
    }
    const body = await response.Body?.transformToByteArray();
    if (!body) {
      throw new OperatorSafeError("Legacy object body is unavailable.");
    }
    if (body.byteLength > UPLOAD_FILE_MAX_BYTES) {
      throw new OperatorSafeError(
        "Legacy object exceeds the supported file limit.",
      );
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCandidate(
  database: Database,
  fileId: string,
): Promise<Candidate> {
  const { withSystem } = await import("../lib/tenant-db");
  const [candidate] = await withSystem(database, (tx) =>
    tx
      .select({
        id: files.id,
        practiceId: files.practiceId,
        fileKey: files.fileKey,
        fileUrl: files.fileUrl,
        mimeType: files.mimeType,
        fileSizeBytes: files.fileSizeBytes,
        checksumSha256: files.checksumSha256,
        storageStatus: files.storageStatus,
        category: files.category,
      })
      .from(files)
      .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
      .limit(1),
  );
  if (!candidate) {
    throw new OperatorSafeError("Selected file manifest was not found.");
  }
  if (candidate.storageStatus !== "missing") {
    throw new OperatorSafeError(
      "Selected file manifest is not in missing state.",
    );
  }
  if (
    !candidate.category ||
    !isAllowedUploadCategory(candidate.category) ||
    !candidate.fileKey.startsWith(
      `${candidate.practiceId}/${candidate.category}/`,
    ) ||
    candidate.fileUrl !== `/api/files/${candidate.fileKey}`
  ) {
    throw new OperatorSafeError(
      "Selected file manifest has an invalid storage namespace.",
    );
  }
  return candidate;
}

async function putAndVerifyReplica(input: {
  key: string;
  body: Uint8Array;
  mimeType: string;
  checksumSha256: string;
  fileSizeBytes: number;
}) {
  const { normalizeS3VersionId, readReplicaObject, uploadReplicaFile } =
    await import("../lib/s3");
  let write: { etag?: string; versionId?: string } | undefined;
  try {
    write = await uploadReplicaFile(
      input.key,
      Buffer.from(input.body),
      input.mimeType,
      input.checksumSha256,
    );
  } catch {
    // A retry can encounter the immutable object from an earlier partial run.
  }
  const read = await readReplicaObject(input.key, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
    ...(write?.versionId ? { versionId: write.versionId } : {}),
  });
  if (
    read.status !== "available" ||
    !normalizeS3VersionId(read.versionId) ||
    !bytesMatch(read.body, input.checksumSha256, input.fileSizeBytes)
  ) {
    throw new OperatorSafeError(
      "Independent replica write-back verification failed.",
    );
  }
  return {
    etag: read.etag,
    versionId: normalizeS3VersionId(read.versionId)!,
  };
}

async function putAndVerifyPrimary(input: {
  key: string;
  body: Uint8Array;
  mimeType: string;
  checksumSha256: string;
  fileSizeBytes: number;
}) {
  const { readPrimaryObject, uploadManagedFile } = await import("../lib/s3");
  let write: { etag?: string; versionId?: string } | undefined;
  try {
    write = await uploadManagedFile(
      input.key,
      Buffer.from(input.body),
      input.mimeType,
      input.checksumSha256,
    );
  } catch {
    // A retry can encounter the immutable object from an earlier partial run.
  }
  const read = await readPrimaryObject(input.key, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
    ...(write?.versionId ? { versionId: write.versionId } : {}),
  });
  if (
    read.status !== "available" ||
    !bytesMatch(read.body, input.checksumSha256, input.fileSizeBytes)
  ) {
    throw new OperatorSafeError("Primary write-back verification failed.");
  }
  return { etag: read.etag, versionId: read.versionId };
}

async function main() {
  const args = parseLegacyFileRecoveryArgs(process.argv.slice(2));
  if (args.execute) {
    const ownerDatabaseUrl = requiredEnv("OWNER_RECOVERY_DATABASE_URL");
    assertLegacyRecoveryDatabaseIdentity({
      databaseUrl: ownerDatabaseUrl,
      expectedFingerprint: process.env.OWNER_RECOVERY_DATABASE_FINGERPRINT,
    });
    process.env.DATABASE_URL = ownerDatabaseUrl;
  }

  const [{ db }, storage, replication] = await Promise.all([
    import("@openpims/db/client"),
    import("../lib/s3"),
    import("../lib/file-replication"),
  ]);
  const candidate = await loadCandidate(db, args.fileId);
  const expectedChecksumSha256 = resolveLegacyRecoveryChecksum({
    recordedChecksumSha256: candidate.checksumSha256,
    reviewedChecksumSha256: args.expectedChecksumSha256,
    execute: args.execute,
  });
  const legacy = legacyClient();
  const body = await readLegacyObject({
    client: legacy.client,
    bucket: legacy.bucket,
    key: candidate.fileKey,
  });
  const inspected = inspectLegacyFileBytes({
    body,
    expectedFileSizeBytes: candidate.fileSizeBytes,
    expectedChecksumSha256,
  });
  if (
    !inspected.sizeMatches ||
    (expectedChecksumSha256 !== null && !inspected.checksumMatches)
  ) {
    throw new OperatorSafeError(
      "Legacy object does not match the recorded manifest.",
    );
  }

  const replicaKey = replication.replicaObjectKey({
    practiceId: candidate.practiceId,
    fileId: candidate.id,
    checksumSha256: inspected.checksumSha256,
  });
  const [primary, replica] = await Promise.all([
    storage.readPrimaryObject(candidate.fileKey, {
      maxBytes: UPLOAD_FILE_MAX_BYTES,
    }),
    storage.replicaStorageReadiness().ready
      ? storage.readReplicaObject(replicaKey, {
          maxBytes: UPLOAD_FILE_MAX_BYTES,
        })
      : Promise.resolve({ status: "failed" as const }),
  ]);
  const primaryExact =
    primary.status === "available" &&
    bytesMatch(primary.body, inspected.checksumSha256, inspected.fileSizeBytes);
  const replicaExact =
    replica.status === "available" &&
    bytesMatch(replica.body, inspected.checksumSha256, inspected.fileSizeBytes);

  if (!args.execute) {
    console.log(
      JSON.stringify({
        operation: "legacy_file_recovery",
        mode: "dry_run",
        sourceAvailable: true,
        manifestSizeMatches: inspected.sizeMatches,
        recordedChecksumPresent: candidate.checksumSha256 !== null,
        reviewedChecksumProvided: args.expectedChecksumSha256 !== undefined,
        exactChecksumVerified: inspected.checksumMatches,
        observedChecksumSha256: inspected.checksumSha256,
        primaryState:
          primary.status === "available"
            ? primaryExact
              ? "available_exact"
              : "available_mismatch"
            : primary.status,
        replicaState:
          replica.status === "available"
            ? replicaExact
              ? "available_exact"
              : "available_mismatch"
            : replica.status,
        replicaConfigured: storage.replicaStorageReadiness().ready,
        readyToExecute:
          inspected.checksumMatches &&
          storage.replicaStorageReadiness().ready &&
          (primary.status === "missing" || primaryExact) &&
          (replica.status === "missing" || replicaExact),
      }),
    );
    return;
  }

  if (!inspected.checksumMatches) {
    throw new OperatorSafeError("Legacy object checksum is not verified.");
  }

  if (!storage.replicaStorageReadiness().ready) {
    throw new OperatorSafeError("Independent replica storage is not ready.");
  }
  if (primary.status === "failed") {
    throw new OperatorSafeError("Primary storage is unavailable.");
  }
  if (replica.status === "failed") {
    throw new OperatorSafeError("Independent replica storage is unavailable.");
  }
  if (primary.status === "available" && !primaryExact) {
    throw new OperatorSafeError(
      "Primary object already contains different bytes.",
    );
  }
  if (replica.status === "available" && !replicaExact) {
    throw new OperatorSafeError(
      "Replica object already contains different bytes.",
    );
  }

  const mimeType = candidate.mimeType ?? "application/octet-stream";
  const replicaEvidence = await putAndVerifyReplica({
    key: replicaKey,
    body,
    mimeType,
    checksumSha256: inspected.checksumSha256,
    fileSizeBytes: inspected.fileSizeBytes,
  });
  const primaryEvidence = await putAndVerifyPrimary({
    key: candidate.fileKey,
    body,
    mimeType,
    checksumSha256: inspected.checksumSha256,
    fileSizeBytes: inspected.fileSizeBytes,
  });
  const finalized = await replication.finalizeLegacyFileRecovery({
    practiceId: candidate.practiceId,
    fileId: candidate.id,
    fileKey: candidate.fileKey,
    previousStorageStatus: "missing",
    previousChecksumSha256: candidate.checksumSha256,
    previousFileSizeBytes: candidate.fileSizeBytes,
    checksumSha256: inspected.checksumSha256,
    fileSizeBytes: inspected.fileSizeBytes,
    primaryObjectEtag: primaryEvidence.etag,
    primaryObjectVersionId: primaryEvidence.versionId,
    replicaObjectEtag: replicaEvidence.etag,
    replicaObjectVersionId: replicaEvidence.versionId,
  });
  if (!finalized) {
    throw new OperatorSafeError(
      "File manifest changed during legacy recovery.",
    );
  }
  console.log(
    JSON.stringify({
      operation: "legacy_file_recovery",
      mode: "executed",
      sourceVerified: true,
      replicaSeededAndVerified: true,
      primaryRestoredAndVerified: true,
      manifestFinalized: true,
      evidenceRecorded: true,
      nextAction: "run_file_replica_reconciliation",
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    const safeMessage =
      error instanceof OperatorSafeError ||
      (error instanceof Error &&
        /^(First argument|--file-id|--confirmation|--expected-sha256|audit is always|Recorded manifest checksum|Reviewed checksum|Checksum-less manifests|Owner recovery database)/.test(
          error.message,
        ))
        ? error.message
        : "Legacy file recovery failed; inspect provider access privately.";
    console.error(JSON.stringify({ ok: false, error: safeMessage }));
    process.exit(1);
  });
