import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { fileObjectReplicas, files, fileStorageEvents } from "@openpims/db";
import { db } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  FILE_REPLICA_TARGET,
  normalizeS3VersionId,
  readPrimaryObject,
  readReplicaObject,
  replicaStoragePracticeScope,
  replicaStorageReadiness,
  replicaStorageRequired,
  replicaStorageRolloutEnabled,
  uploadManagedFile,
  uploadReplicaFile,
} from "@/lib/s3";
import { withSystem } from "@/lib/tenant-db";
import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";
import { isAllowedUploadCategory } from "@/lib/upload-security";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const LEASE_MS = 5 * 60 * 1000;
const VERIFY_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_JOB_BUDGET_MS = 240_000;

type ReplicaStatus = "pending" | "available" | "missing" | "corrupt" | "failed";
type FileStorageStatus = (typeof files.$inferSelect)["storageStatus"];

interface ClaimedReplica {
  replicaId: string;
  practiceId: string;
  fileId: string;
  fileKey: string;
  mimeType: string | null;
  fileChecksum: string | null;
  fileSize: number | null;
  fileStorageStatus: FileStorageStatus;
  replicaObjectKey: string;
  replicaChecksum: string | null;
  replicaSize: number | null;
  replicaStatus: ReplicaStatus;
  replicaObjectEtag: string | null;
  replicaObjectVersionId: string | null;
  replicaReplicatedAt: Date | string | null;
  replicaVerifiedAt: Date | string | null;
  attemptCount: number;
  leaseToken: string;
}

export interface FileReplicaRunMetrics {
  intended: boolean;
  required: boolean;
  configured: boolean;
  enabled: boolean;
  candidates: number;
  claimed: number;
  deferred: number;
  copied: number;
  alreadyPresent: number;
  repairedPrimary: number;
  sourceMissing: number;
  sourceCorrupt: number;
  failed: number;
  bytesCopied: number;
  backlog: number;
  available: number;
  activeFiles: number;
  coveragePct: number;
}

export function checksumSha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function replicaObjectKey(input: {
  practiceId: string;
  fileId: string;
  checksumSha256: string;
}): string {
  return `attachments/v1/${input.practiceId}/${input.fileId}/${input.checksumSha256}`;
}

export function recoveryCatalogKey(
  practiceId: string,
  fileId: string,
  checksumSha256: string,
): string {
  return `recovery-catalog/v2/${practiceId}/${fileId}/${checksumSha256}.json`;
}

async function appendStorageEvent(
  tx: Parameters<Parameters<typeof withSystem>[1]>[0],
  input: {
    practiceId: string;
    fileId: string;
    storageTarget: string;
    eventKey: string;
    operationId: string;
    eventKind: string;
    previousStatus?: string | null;
    nextStatus: string;
    expectedChecksumSha256?: string | null;
    observedChecksumSha256?: string | null;
    expectedFileSizeBytes?: number | null;
    observedFileSizeBytes?: number | null;
    objectEtag?: string | null;
    objectVersionId?: string | null;
    failureCode?: string | null;
    workerRunId?: string | null;
  },
): Promise<void> {
  await tx
    .insert(fileStorageEvents)
    .values({
      practiceId: input.practiceId,
      fileId: input.fileId,
      storageTarget: input.storageTarget,
      eventKey: input.eventKey,
      operationId: input.operationId,
      eventKind: input.eventKind,
      previousStatus: input.previousStatus ?? null,
      nextStatus: input.nextStatus,
      expectedChecksumSha256: input.expectedChecksumSha256 ?? null,
      observedChecksumSha256: input.observedChecksumSha256 ?? null,
      expectedFileSizeBytes: input.expectedFileSizeBytes ?? null,
      observedFileSizeBytes: input.observedFileSizeBytes ?? null,
      objectEtag: input.objectEtag ?? null,
      objectVersionId: input.objectVersionId ?? null,
      failureCode: input.failureCode ?? null,
      workerRunId: input.workerRunId ?? null,
    })
    .onConflictDoNothing({ target: fileStorageEvents.eventKey });
}

/**
 * Durably queue an independently replicated copy after the primary manifest is
 * committed. Queue failure never makes the clinic repeat a successful upload;
 * the reconciliation sweep also materializes any missing queue rows.
 */
export async function registerFileForReplication(input: {
  practiceId: string;
  fileId: string;
  fileKey: string;
  checksumSha256: string;
  fileSizeBytes: number;
  objectEtag?: string;
  objectVersionId?: string;
}): Promise<boolean> {
  const operationId = randomUUID();
  const objectKey = replicaObjectKey(input);

  try {
    await withSystem(db, async (tx) => {
      await appendStorageEvent(tx, {
        practiceId: input.practiceId,
        fileId: input.fileId,
        storageTarget: "primary",
        eventKey: `primary:${input.fileId}:${input.checksumSha256}:verified`,
        operationId,
        eventKind: "primary_verified",
        previousStatus: "pending_upload",
        nextStatus: "available",
        expectedChecksumSha256: input.checksumSha256,
        observedChecksumSha256: input.checksumSha256,
        expectedFileSizeBytes: input.fileSizeBytes,
        observedFileSizeBytes: input.fileSizeBytes,
        objectEtag: input.objectEtag,
        objectVersionId: input.objectVersionId,
      });

      await tx
        .insert(fileObjectReplicas)
        .values({
          practiceId: input.practiceId,
          fileId: input.fileId,
          replicaTarget: FILE_REPLICA_TARGET,
          objectKey,
          checksumSha256: input.checksumSha256,
          fileSizeBytes: input.fileSizeBytes,
          status: "pending",
          nextAttemptAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [fileObjectReplicas.fileId, fileObjectReplicas.replicaTarget],
          set: {
            objectKey,
            checksumSha256: input.checksumSha256,
            fileSizeBytes: input.fileSizeBytes,
            status: sql`case
              when ${fileObjectReplicas.status} = 'available'
                and ${fileObjectReplicas.checksumSha256} = ${input.checksumSha256}
              then ${fileObjectReplicas.status}
              else 'pending'::file_replica_status
            end`,
            nextAttemptAt: sql`case
              when ${fileObjectReplicas.status} = 'available'
                and ${fileObjectReplicas.checksumSha256} = ${input.checksumSha256}
              then ${fileObjectReplicas.nextAttemptAt}
              else now()
            end`,
            failureCode: null,
            lastErrorClass: null,
            leaseToken: null,
            leaseExpiresAt: null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

      await appendStorageEvent(tx, {
        practiceId: input.practiceId,
        fileId: input.fileId,
        storageTarget: FILE_REPLICA_TARGET,
        eventKey: `replica:${input.fileId}:${input.checksumSha256}:queued`,
        operationId,
        eventKind: "replica_queued",
        previousStatus: null,
        nextStatus: "pending",
        expectedChecksumSha256: input.checksumSha256,
        expectedFileSizeBytes: input.fileSizeBytes,
      });
    });
    return true;
  } catch {
    await alertOps(
      "File replica queue write failed",
      `practice ${input.practiceId}, file ${input.fileId}; reconciliation must recover the missing queue row.`,
    );
    return false;
  }
}

/**
 * Make a verified replica fallback actionable without paging once per read.
 * The manifest transition and queue wake-up are durable; the reconciler owns
 * provider repair, lease coordination, and alerting.
 */
export async function schedulePrimaryRepair(input: {
  practiceId: string;
  fileId: string;
  fileKey: string;
  checksumSha256: string | null;
  fileSizeBytes: number | null;
  storageStatus: FileStorageStatus;
  observedState: "missing" | "corrupt" | "failed";
}): Promise<boolean> {
  const nextStorageStatus =
    input.observedState === "failed" ? "unverified" : input.observedState;

  try {
    return await withSystem(db, async (tx) => {
      const [updatedFile] = await tx
        .update(files)
        .set({
          storageStatus: nextStorageStatus,
          storageVerifiedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(files.id, input.fileId),
            eq(files.practiceId, input.practiceId),
            eq(files.fileKey, input.fileKey),
            sql`${files.checksumSha256} is not distinct from ${input.checksumSha256}`,
            sql`${files.fileSizeBytes} is not distinct from ${input.fileSizeBytes}`,
            eq(files.storageStatus, input.storageStatus),
            isNull(files.deletedAt),
          ),
        )
        .returning({ id: files.id });
      if (!updatedFile) return false;

      await tx
        .update(fileObjectReplicas)
        .set({ nextAttemptAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(fileObjectReplicas.fileId, input.fileId),
            eq(fileObjectReplicas.practiceId, input.practiceId),
            eq(fileObjectReplicas.replicaTarget, FILE_REPLICA_TARGET),
          ),
        );

      return true;
    });
  } catch {
    return false;
  }
}

function boundedBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value!)));
}

function replicaPracticeScopeSql(scope: string[] | null) {
  if (scope === null) return sql`true`;
  if (scope.length === 0) return sql`false`;
  return sql`f.practice_id in (${sql.join(
    scope.map((practiceId) => sql`${practiceId}::uuid`),
    sql`, `,
  )})`;
}

async function materializeMissingReplicaRows(
  limit: number,
  scope: string[] | null,
): Promise<number> {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      insert into file_object_replicas (
        practice_id, file_id, replica_target, object_key, status,
        next_attempt_at
      )
      select
        f.practice_id,
        f.id,
        ${FILE_REPLICA_TARGET},
        'attachments/v1/' || f.practice_id::text || '/' || f.id::text || '/pending',
        'pending'::file_replica_status,
        now()
      from files f
      join practices p on p.id = f.practice_id and p.deleted_at is null
      where f.deleted_at is null
        and f.storage_status not in ('pending_upload', 'cleanup_pending')
        and ${replicaPracticeScopeSql(scope)}
        and not exists (
          select 1
          from file_object_replicas r
          where r.file_id = f.id
            and r.replica_target = ${FILE_REPLICA_TARGET}
            and r.deleted_at is null
        )
      order by f.created_at, f.id
      limit ${limit}
      on conflict (file_id, replica_target) do update
      set practice_id = excluded.practice_id,
          object_key = excluded.object_key,
          status = 'pending'::file_replica_status,
          failure_code = null,
          last_error_class = null,
          next_attempt_at = now(),
          lease_token = null,
          lease_expires_at = null,
          deleted_at = null,
          updated_at = now()
      returning id
    `);
    return rowsFromExecute<{ id: string }>(result).length;
  });
}

async function claimReplicaRows(input: {
  limit: number;
  staleBefore: Date;
  scope: string[] | null;
}): Promise<ClaimedReplica[]> {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      with candidates as (
        select r.id
        from file_object_replicas r
        join files f on f.id = r.file_id and f.practice_id = r.practice_id
        join practices p on p.id = r.practice_id
        where r.replica_target = ${FILE_REPLICA_TARGET}
          and r.deleted_at is null
          and f.deleted_at is null
          and f.storage_status not in ('pending_upload', 'cleanup_pending')
          and p.deleted_at is null
          and ${replicaPracticeScopeSql(input.scope)}
          and (
            r.status <> 'available'
            or r.verified_at is null
            or r.verified_at < ${input.staleBefore}
            or f.storage_status <> 'available'
            or f.storage_verified_at is null
            or f.storage_verified_at < ${input.staleBefore}
          )
          and (r.next_attempt_at is null or r.next_attempt_at <= now())
          and (r.lease_token is null or r.lease_expires_at < now())
        order by
          case when r.status = 'available' then 1 else 0 end,
          coalesce(r.next_attempt_at, r.created_at),
          r.id
        limit ${input.limit}
        for update of r skip locked
      )
      update file_object_replicas r
      set lease_token = gen_random_uuid(),
          lease_expires_at = now() + ${LEASE_MS} * interval '1 millisecond',
          last_attempted_at = now(),
          attempt_count = r.attempt_count + 1,
          updated_at = now()
      from candidates c, files f
      where r.id = c.id
        and f.id = r.file_id
        and f.practice_id = r.practice_id
      returning
        r.id as "replicaId",
        r.practice_id as "practiceId",
        r.file_id as "fileId",
        f.file_key as "fileKey",
        f.mime_type as "mimeType",
        f.checksum_sha256 as "fileChecksum",
        f.file_size_bytes as "fileSize",
        f.storage_status as "fileStorageStatus",
        r.object_key as "replicaObjectKey",
        r.checksum_sha256 as "replicaChecksum",
        r.file_size_bytes as "replicaSize",
        r.status as "replicaStatus",
        r.object_etag as "replicaObjectEtag",
        r.object_version_id as "replicaObjectVersionId",
        r.replicated_at as "replicaReplicatedAt",
        r.verified_at as "replicaVerifiedAt",
        r.attempt_count as "attemptCount",
        r.lease_token as "leaseToken"
    `);
    return rowsFromExecute<ClaimedReplica>(result);
  });
}

function bodyMatches(
  body: Uint8Array,
  expectedChecksum: string,
  expectedSize: number,
): boolean {
  return (
    body.byteLength === expectedSize &&
    checksumSha256Hex(body) === expectedChecksum
  );
}

function retryAt(attemptCount: number): Date {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 4));
  const delayMs = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * 3 ** exponent);
  return new Date(Date.now() + delayMs);
}

function claimedPrimaryGeneration(item: ClaimedReplica) {
  return and(
    eq(files.id, item.fileId),
    eq(files.practiceId, item.practiceId),
    eq(files.fileKey, item.fileKey),
    sql`${files.checksumSha256} is not distinct from ${item.fileChecksum}`,
    sql`${files.fileSizeBytes} is not distinct from ${item.fileSize}`,
    eq(files.storageStatus, item.fileStorageStatus),
    isNull(files.deletedAt),
  );
}

function claimedPrimaryGenerationExists(item: ClaimedReplica) {
  return sql`exists (
    select 1
    from ${files}
    where ${claimedPrimaryGeneration(item)}
  )`;
}

function claimedReplicaGeneration(item: ClaimedReplica) {
  return and(
    eq(fileObjectReplicas.id, item.replicaId),
    eq(fileObjectReplicas.practiceId, item.practiceId),
    eq(fileObjectReplicas.fileId, item.fileId),
    eq(fileObjectReplicas.replicaTarget, FILE_REPLICA_TARGET),
    eq(fileObjectReplicas.leaseToken, item.leaseToken),
    eq(fileObjectReplicas.objectKey, item.replicaObjectKey),
    sql`${fileObjectReplicas.checksumSha256} is not distinct from ${item.replicaChecksum}`,
    sql`${fileObjectReplicas.fileSizeBytes} is not distinct from ${item.replicaSize}`,
    isNull(fileObjectReplicas.deletedAt),
  );
}

class StaleClaimedGenerationError extends Error {}

async function finalizeReplica(
  item: ClaimedReplica,
  input: {
    status: ReplicaStatus;
    operationId: string;
    eventKind: string;
    previousStatus?: string;
    objectKey?: string;
    checksumSha256?: string | null;
    fileSizeBytes?: number | null;
    objectEtag?: string | null;
    objectVersionId?: string | null;
    replicatedAt?: Date | null;
    verifiedAt?: Date | null;
    failureCode?: string | null;
    lastErrorClass?: string | null;
    nextAttemptAt?: Date | null;
    workerRunId: string;
    primaryTransition?: {
      status: "available" | "missing" | "corrupt";
      eventKind: string;
      checksumSha256?: string;
      fileSizeBytes?: number;
      observedChecksumSha256?: string;
      observedFileSizeBytes?: number;
      objectEtag?: string;
      objectVersionId?: string;
      failureCode?: string;
    };
  },
): Promise<boolean> {
  try {
    return await withSystem(db, async (tx) => {
      const [updated] = await tx
        .update(fileObjectReplicas)
        .set({
          status: input.status,
          ...(input.objectKey ? { objectKey: input.objectKey } : {}),
          checksumSha256:
            input.checksumSha256 === undefined
              ? item.replicaChecksum
              : input.checksumSha256,
          fileSizeBytes:
            input.fileSizeBytes === undefined
              ? item.replicaSize
              : input.fileSizeBytes,
          objectEtag:
            input.objectEtag === undefined
              ? item.replicaObjectEtag
              : input.objectEtag,
          objectVersionId:
            input.objectVersionId === undefined
              ? item.replicaObjectVersionId
              : input.objectVersionId,
          replicatedAt:
            input.replicatedAt === undefined
              ? item.replicaReplicatedAt
                ? new Date(item.replicaReplicatedAt)
                : null
              : input.replicatedAt,
          verifiedAt:
            input.verifiedAt === undefined
              ? item.replicaVerifiedAt
                ? new Date(item.replicaVerifiedAt)
                : null
              : input.verifiedAt,
          failureCode: input.failureCode ?? null,
          lastErrorClass: input.lastErrorClass ?? null,
          nextAttemptAt: input.nextAttemptAt ?? null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            claimedReplicaGeneration(item),
            claimedPrimaryGenerationExists(item),
          ),
        )
        .returning({ id: fileObjectReplicas.id });
      if (!updated) return false;

      if (input.primaryTransition) {
        const transition = input.primaryTransition;
        const [updatedFile] = await tx
          .update(files)
          .set({
            storageStatus: transition.status,
            ...(transition.checksumSha256
              ? { checksumSha256: transition.checksumSha256 }
              : {}),
            ...(typeof transition.fileSizeBytes === "number"
              ? { fileSizeBytes: transition.fileSizeBytes }
              : {}),
            objectEtag: transition.objectEtag ?? null,
            objectVersionId: transition.objectVersionId ?? null,
            storageVerifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(claimedPrimaryGeneration(item))
          .returning({ id: files.id });
        if (!updatedFile) throw new StaleClaimedGenerationError();

        await appendStorageEvent(tx, {
          practiceId: item.practiceId,
          fileId: item.fileId,
          storageTarget: "primary",
          eventKey: `${input.workerRunId}:${item.fileId}:primary:${transition.eventKind}:${input.operationId}`,
          operationId: input.operationId,
          eventKind: transition.eventKind,
          previousStatus: item.fileStorageStatus,
          nextStatus: transition.status,
          expectedChecksumSha256: item.fileChecksum,
          observedChecksumSha256:
            transition.observedChecksumSha256 ?? transition.checksumSha256,
          expectedFileSizeBytes: item.fileSize,
          observedFileSizeBytes:
            transition.observedFileSizeBytes ?? transition.fileSizeBytes,
          objectEtag: transition.objectEtag,
          objectVersionId: transition.objectVersionId,
          failureCode: transition.failureCode,
          workerRunId: input.workerRunId,
        });
      }

      await appendStorageEvent(tx, {
        practiceId: item.practiceId,
        fileId: item.fileId,
        storageTarget: FILE_REPLICA_TARGET,
        eventKey: `${input.workerRunId}:${item.fileId}:${input.eventKind}:${input.operationId}`,
        operationId: input.operationId,
        eventKind: input.eventKind,
        previousStatus: input.previousStatus ?? item.replicaStatus,
        nextStatus: input.status,
        expectedChecksumSha256:
          input.checksumSha256 ?? item.fileChecksum ?? item.replicaChecksum,
        observedChecksumSha256: input.checksumSha256 ?? null,
        expectedFileSizeBytes: input.fileSizeBytes ?? item.fileSize,
        observedFileSizeBytes: input.fileSizeBytes ?? null,
        objectEtag: input.objectEtag,
        objectVersionId: input.objectVersionId,
        failureCode: input.failureCode,
        workerRunId: input.workerRunId,
      });
      return true;
    });
  } catch (error) {
    if (error instanceof StaleClaimedGenerationError) return false;
    throw error;
  }
}

async function writeRecoveryCatalog(input: {
  item: ClaimedReplica;
  replicaObjectKey: string;
  checksumSha256: string;
  fileSizeBytes: number;
  objectEtag?: string;
  objectVersionId: string;
  verifiedAt: Date;
}): Promise<void> {
  const replicaObjectVersionId = normalizeS3VersionId(input.objectVersionId);
  if (!replicaObjectVersionId) {
    throw new Error("Recovery catalog requires an exact replica version");
  }
  const body = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      practiceId: input.item.practiceId,
      fileId: input.item.fileId,
      primaryObjectKey: input.item.fileKey,
      replicaObjectKey: input.replicaObjectKey,
      checksumSha256: input.checksumSha256,
      fileSizeBytes: input.fileSizeBytes,
      objectEtag: input.objectEtag ?? null,
      objectVersionId: replicaObjectVersionId,
      mimeType: input.item.mimeType,
      verifiedAt: input.verifiedAt.toISOString(),
    }),
  );
  const catalogChecksum = checksumSha256Hex(body);
  const catalogKey = recoveryCatalogKey(
    input.item.practiceId,
    input.item.fileId,
    catalogChecksum,
  );
  let catalogWrite: { etag?: string; versionId?: string } | undefined;
  let catalogWriteError: unknown;
  try {
    catalogWrite = await uploadReplicaFile(
      catalogKey,
      body,
      "application/json",
      catalogChecksum,
    );
  } catch (error) {
    // This key is derived from the complete catalog bytes. A provider timeout
    // can therefore converge through checksum/size read-back without creating
    // mutable or duplicate recovery evidence.
    catalogWriteError = error;
  }
  const requestedVersionId = normalizeS3VersionId(catalogWrite?.versionId);
  const verification = await readReplicaObject(catalogKey, {
    maxBytes: body.byteLength,
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
    !bodyMatches(verification.body, catalogChecksum, body.byteLength)
  ) {
    if (catalogWriteError) throw catalogWriteError;
    throw new Error("Recovery catalog verification failed");
  }
}

type ProcessOutcome =
  | "copied"
  | "already_present"
  | "repaired_primary"
  | "source_missing"
  | "source_corrupt"
  | "failed";

function validPrimaryObjectKey(item: ClaimedReplica): boolean {
  const segments = item.fileKey.split("/");
  return (
    segments.length === 3 &&
    segments[0] === item.practiceId &&
    Boolean(segments[2]) &&
    isAllowedUploadCategory(segments[1] ?? "")
  );
}

async function renewReplicaLease(item: ClaimedReplica): Promise<boolean> {
  return withSystem(db, async (tx) => {
    const [renewed] = await tx
      .update(fileObjectReplicas)
      .set({
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          claimedReplicaGeneration(item),
          claimedPrimaryGenerationExists(item),
        ),
      )
      .returning({ id: fileObjectReplicas.id });
    return Boolean(renewed);
  });
}

async function processClaimedReplica(
  item: ClaimedReplica,
  workerRunId: string,
): Promise<{ outcome: ProcessOutcome; bytesCopied: number }> {
  const operationId = randomUUID();
  const expectedChecksum = item.fileChecksum ?? item.replicaChecksum;
  const expectedSize = item.fileSize ?? item.replicaSize;
  if (!validPrimaryObjectKey(item)) {
    const finalized = await finalizeReplica(item, {
      status: "failed",
      operationId,
      eventKind: "invalid_primary_object_namespace",
      failureCode: "invalid_primary_object_namespace",
      lastErrorClass: "permanent_integrity_error",
      objectEtag: null,
      objectVersionId: null,
      replicatedAt: null,
      verifiedAt: null,
      workerRunId,
    });
    if (finalized) {
      await alertOps(
        "File replica quarantined invalid object key",
        `practice ${item.practiceId}, file ${item.fileId}; provider I/O was blocked.`,
      );
    }
    return { outcome: "failed", bytesCopied: 0 };
  }

  const desiredKey =
    expectedChecksum && expectedSize != null
      ? replicaObjectKey({
          practiceId: item.practiceId,
          fileId: item.fileId,
          checksumSha256: expectedChecksum,
        })
      : null;
  let replicaProbeState: "not_checked" | "missing" | "failed" | "corrupt" =
    "not_checked";
  let verifiedReplica:
    | {
        body: Uint8Array;
        contentType?: string;
        etag?: string;
        versionId: string;
        key: string;
        verifiedAt: Date;
      }
    | undefined;

  if (desiredKey && expectedChecksum && expectedSize != null) {
    const probe = await readReplicaObject(desiredKey, {
      maxBytes: UPLOAD_FILE_MAX_BYTES,
      ...(item.replicaStatus === "available" &&
      item.replicaObjectKey === desiredKey &&
      normalizeS3VersionId(item.replicaObjectVersionId)
        ? { versionId: normalizeS3VersionId(item.replicaObjectVersionId)! }
        : {}),
    });
    const probeVersionId =
      probe.status === "available"
        ? normalizeS3VersionId(probe.versionId)
        : undefined;
    if (
      probe.status === "available" &&
      probeVersionId &&
      bodyMatches(probe.body, expectedChecksum, expectedSize)
    ) {
      verifiedReplica = {
        body: probe.body,
        ...(probe.contentType ? { contentType: probe.contentType } : {}),
        ...(probe.etag ? { etag: probe.etag } : {}),
        versionId: probeVersionId,
        key: desiredKey,
        verifiedAt: new Date(),
      };
    } else {
      replicaProbeState =
        probe.status === "available" ? "corrupt" : probe.status;
    }
  }

  const primary = await readPrimaryObject(item.fileKey, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
  });

  if (primary.status === "failed") {
    const preserveVerifiedReplica =
      Boolean(verifiedReplica) ||
      (item.replicaStatus === "available" &&
        (replicaProbeState === "failed" ||
          replicaProbeState === "not_checked"));
    const finalized = await finalizeReplica(item, {
      status:
        verifiedReplica || preserveVerifiedReplica
          ? "available"
          : replicaProbeState === "corrupt"
            ? "corrupt"
            : "pending",
      operationId,
      eventKind: "primary_read_retry_scheduled",
      ...(verifiedReplica ? { objectKey: verifiedReplica.key } : {}),
      checksumSha256: expectedChecksum,
      fileSizeBytes: expectedSize,
      ...(verifiedReplica
        ? {
            objectEtag: verifiedReplica.etag,
            objectVersionId: verifiedReplica.versionId,
            replicatedAt: item.replicaReplicatedAt
              ? new Date(item.replicaReplicatedAt)
              : verifiedReplica.verifiedAt,
            verifiedAt: verifiedReplica.verifiedAt,
          }
        : {}),
      failureCode: "primary_unavailable",
      lastErrorClass: "retryable_provider_error",
      nextAttemptAt: retryAt(item.attemptCount),
      ...(verifiedReplica || preserveVerifiedReplica
        ? {}
        : {
            objectEtag: null,
            objectVersionId: null,
            replicatedAt: null,
            verifiedAt: null,
          }),
      workerRunId,
    });
    void finalized;
    return { outcome: "failed", bytesCopied: 0 };
  }

  const primaryMissing = primary.status === "missing";
  const observedChecksum = primaryMissing
    ? null
    : checksumSha256Hex(primary.body);
  const observedSize = primaryMissing ? null : primary.body.byteLength;
  const primaryCorrupt =
    !primaryMissing &&
    ((item.fileChecksum && item.fileChecksum !== observedChecksum) ||
      (item.fileSize != null && item.fileSize !== observedSize));

  if ((primaryMissing || primaryCorrupt) && verifiedReplica) {
    if (!expectedChecksum || expectedSize == null) {
      throw new Error("Verified replica is missing manifest evidence");
    }
    if (!(await renewReplicaLease(item))) {
      return { outcome: "failed", bytesCopied: 0 };
    }

    let restored: { etag?: string; versionId?: string } | undefined;
    try {
      restored = await uploadManagedFile(
        item.fileKey,
        Buffer.from(verifiedReplica.body),
        item.mimeType ??
          verifiedReplica.contentType ??
          "application/octet-stream",
        expectedChecksum,
      );
    } catch {
      // A timed-out PUT may have committed. The read-back below decides.
    }
    const restoredPrimary = await readPrimaryObject(item.fileKey, {
      maxBytes: UPLOAD_FILE_MAX_BYTES,
    });
    if (
      restoredPrimary.status !== "available" ||
      !bodyMatches(restoredPrimary.body, expectedChecksum, expectedSize)
    ) {
      const finalized = await finalizeReplica(item, {
        status: "available",
        operationId,
        eventKind: "primary_repair_retry_scheduled",
        objectKey: verifiedReplica.key,
        checksumSha256: expectedChecksum,
        fileSizeBytes: expectedSize,
        objectEtag: verifiedReplica.etag,
        objectVersionId: verifiedReplica.versionId,
        replicatedAt: item.replicaReplicatedAt
          ? new Date(item.replicaReplicatedAt)
          : verifiedReplica.verifiedAt,
        verifiedAt: verifiedReplica.verifiedAt,
        failureCode: primaryMissing ? "primary_missing" : "primary_corrupt",
        lastErrorClass: "retryable_provider_error",
        nextAttemptAt: retryAt(item.attemptCount),
        primaryTransition: {
          status: primaryMissing ? "missing" : "corrupt",
          eventKind: primaryMissing
            ? "primary_missing"
            : "primary_integrity_mismatch",
          ...(primaryCorrupt && observedChecksum
            ? {
                observedChecksumSha256: observedChecksum,
                observedFileSizeBytes: observedSize!,
              }
            : {}),
          failureCode: primaryMissing
            ? "primary_missing"
            : "checksum_or_size_mismatch",
        },
        workerRunId,
      });
      void finalized;
      return { outcome: "failed", bytesCopied: 0 };
    }

    try {
      await writeRecoveryCatalog({
        item,
        replicaObjectKey: verifiedReplica.key,
        checksumSha256: expectedChecksum,
        fileSizeBytes: expectedSize,
        objectEtag: verifiedReplica.etag,
        objectVersionId: verifiedReplica.versionId,
        verifiedAt: verifiedReplica.verifiedAt,
      });
    } catch {
      const keepAvailable =
        item.replicaStatus === "available" && item.replicaVerifiedAt;
      const finalized = await finalizeReplica(item, {
        status: keepAvailable ? "available" : "pending",
        operationId,
        eventKind: "recovery_catalog_retry_scheduled",
        objectKey: verifiedReplica.key,
        checksumSha256: expectedChecksum,
        fileSizeBytes: expectedSize,
        objectEtag: verifiedReplica.etag,
        objectVersionId: verifiedReplica.versionId,
        replicatedAt: item.replicaReplicatedAt
          ? new Date(item.replicaReplicatedAt)
          : verifiedReplica.verifiedAt,
        verifiedAt: keepAvailable ? new Date(item.replicaVerifiedAt!) : null,
        failureCode: "catalog_write_failed",
        lastErrorClass: "retryable_provider_error",
        nextAttemptAt: retryAt(item.attemptCount),
        primaryTransition: {
          status: "available",
          eventKind: "primary_restored_from_replica",
          checksumSha256: expectedChecksum,
          fileSizeBytes: expectedSize,
          objectEtag: restoredPrimary.etag ?? restored?.etag,
          objectVersionId: restoredPrimary.versionId ?? restored?.versionId,
        },
        workerRunId,
      });
      if (finalized) {
        await alertOps(
          "Primary file restored; recovery catalog retry pending",
          `practice ${item.practiceId}, file ${item.fileId}; restored bytes verified.`,
        );
      }
      return { outcome: "failed", bytesCopied: expectedSize };
    }

    const finalized = await finalizeReplica(item, {
      status: "available",
      operationId,
      eventKind: "primary_restored_from_replica",
      objectKey: verifiedReplica.key,
      checksumSha256: expectedChecksum,
      fileSizeBytes: expectedSize,
      objectEtag: verifiedReplica.etag,
      objectVersionId: verifiedReplica.versionId,
      replicatedAt: item.replicaReplicatedAt
        ? new Date(item.replicaReplicatedAt)
        : verifiedReplica.verifiedAt,
      verifiedAt: verifiedReplica.verifiedAt,
      primaryTransition: {
        status: "available",
        eventKind: "primary_restored_from_replica",
        checksumSha256: expectedChecksum,
        fileSizeBytes: expectedSize,
        objectEtag: restoredPrimary.etag ?? restored?.etag,
        objectVersionId: restoredPrimary.versionId ?? restored?.versionId,
      },
      workerRunId,
    });
    if (finalized) {
      await alertOps(
        "Primary file restored from replica",
        `practice ${item.practiceId}, file ${item.fileId}; integrity verified.`,
      );
      return { outcome: "repaired_primary", bytesCopied: expectedSize };
    }
    return { outcome: "failed", bytesCopied: expectedSize };
  }

  if (primaryMissing || primaryCorrupt) {
    const preservePriorReplica =
      !verifiedReplica &&
      replicaProbeState === "failed" &&
      item.replicaStatus === "available";
    const replicaStatus = preservePriorReplica
      ? "available"
      : replicaProbeState === "corrupt"
        ? "corrupt"
        : replicaProbeState === "missing"
          ? "missing"
          : "pending";
    const finalized = await finalizeReplica(item, {
      status: replicaStatus,
      operationId,
      eventKind: primaryMissing
        ? "primary_missing_no_verified_replica"
        : "primary_integrity_mismatch",
      ...(desiredKey ? { objectKey: desiredKey } : {}),
      checksumSha256: expectedChecksum,
      fileSizeBytes: expectedSize,
      failureCode: primaryMissing
        ? "primary_missing"
        : "checksum_or_size_mismatch",
      lastErrorClass: preservePriorReplica
        ? "retryable_provider_error"
        : "integrity_error",
      nextAttemptAt: retryAt(item.attemptCount),
      ...(preservePriorReplica
        ? {}
        : {
            objectEtag: null,
            objectVersionId: null,
            replicatedAt: null,
            verifiedAt: null,
          }),
      primaryTransition: {
        status: primaryMissing ? "missing" : "corrupt",
        eventKind: primaryMissing
          ? "primary_missing"
          : "primary_integrity_mismatch",
        ...(primaryCorrupt && observedChecksum
          ? {
              observedChecksumSha256: observedChecksum,
              observedFileSizeBytes: observedSize!,
            }
          : {}),
        failureCode: primaryMissing
          ? "primary_missing"
          : "checksum_or_size_mismatch",
      },
      workerRunId,
    });
    if (finalized) {
      await alertOps(
        primaryMissing
          ? preservePriorReplica
            ? "Primary file missing; replica recheck unavailable"
            : "File has no verified recoverable copy"
          : "Primary file integrity mismatch",
        `practice ${item.practiceId}, file ${item.fileId}; ${primaryMissing ? "primary returned a definitive miss" : "expected manifest does not match stored bytes"}.`,
      );
    }
    return {
      outcome: preservePriorReplica
        ? "failed"
        : primaryMissing
          ? "source_missing"
          : "source_corrupt",
      bytesCopied: 0,
    };
  }

  if (!observedChecksum || observedSize == null) {
    throw new Error("Available primary is missing integrity evidence");
  }

  if (verifiedReplica) {
    try {
      await writeRecoveryCatalog({
        item,
        replicaObjectKey: verifiedReplica.key,
        checksumSha256: observedChecksum,
        fileSizeBytes: observedSize,
        objectEtag: verifiedReplica.etag,
        objectVersionId: verifiedReplica.versionId,
        verifiedAt: verifiedReplica.verifiedAt,
      });
    } catch {
      const keepAvailable =
        item.replicaStatus === "available" && item.replicaVerifiedAt;
      const finalized = await finalizeReplica(item, {
        status: keepAvailable ? "available" : "pending",
        operationId,
        eventKind: "recovery_catalog_retry_scheduled",
        objectKey: verifiedReplica.key,
        checksumSha256: observedChecksum,
        fileSizeBytes: observedSize,
        objectEtag: verifiedReplica.etag,
        objectVersionId: verifiedReplica.versionId,
        replicatedAt: item.replicaReplicatedAt
          ? new Date(item.replicaReplicatedAt)
          : verifiedReplica.verifiedAt,
        verifiedAt: keepAvailable ? new Date(item.replicaVerifiedAt!) : null,
        failureCode: "catalog_write_failed",
        lastErrorClass: "retryable_provider_error",
        nextAttemptAt: retryAt(item.attemptCount),
        primaryTransition: {
          status: "available",
          eventKind: "primary_verified",
          checksumSha256: observedChecksum,
          fileSizeBytes: observedSize,
          objectEtag: primary.etag,
          objectVersionId: primary.versionId,
        },
        workerRunId,
      });
      void finalized;
      return { outcome: "failed", bytesCopied: 0 };
    }

    const finalized = await finalizeReplica(item, {
      status: "available",
      operationId,
      eventKind: "replica_verified",
      objectKey: verifiedReplica.key,
      checksumSha256: observedChecksum,
      fileSizeBytes: observedSize,
      objectEtag: verifiedReplica.etag,
      objectVersionId: verifiedReplica.versionId,
      replicatedAt: item.replicaReplicatedAt
        ? new Date(item.replicaReplicatedAt)
        : verifiedReplica.verifiedAt,
      verifiedAt: verifiedReplica.verifiedAt,
      primaryTransition: {
        status: "available",
        eventKind: "primary_verified",
        checksumSha256: observedChecksum,
        fileSizeBytes: observedSize,
        objectEtag: primary.etag,
        objectVersionId: primary.versionId,
      },
      workerRunId,
    });
    return {
      outcome: finalized ? "already_present" : "failed",
      bytesCopied: 0,
    };
  }

  const replicaKey = replicaObjectKey({
    practiceId: item.practiceId,
    fileId: item.fileId,
    checksumSha256: observedChecksum,
  });
  let write: { etag?: string; versionId?: string } | undefined;
  try {
    write = await uploadReplicaFile(
      replicaKey,
      Buffer.from(primary.body),
      item.mimeType ?? primary.contentType ?? "application/octet-stream",
      observedChecksum,
    );
  } catch {
    // A timed-out PUT can have succeeded. Verify the deterministic destination
    // before scheduling a retry so an ambiguous provider result converges.
  }

  const replica = await readReplicaObject(replicaKey, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
  });
  if (
    replica.status !== "available" ||
    !normalizeS3VersionId(replica.versionId) ||
    !bodyMatches(replica.body, observedChecksum, observedSize)
  ) {
    const finalized = await finalizeReplica(item, {
      status: "pending",
      operationId,
      eventKind: "replica_write_retry_scheduled",
      objectKey: replicaKey,
      checksumSha256: observedChecksum,
      fileSizeBytes: observedSize,
      failureCode:
        replica.status === "missing"
          ? "replica_missing"
          : "replica_unavailable",
      lastErrorClass:
        replica.status === "missing"
          ? "definitive_missing"
          : "retryable_provider_error",
      nextAttemptAt: retryAt(item.attemptCount),
      objectEtag: null,
      objectVersionId: null,
      replicatedAt: null,
      verifiedAt: null,
      workerRunId,
      primaryTransition: {
        status: "available",
        eventKind: "primary_verified",
        checksumSha256: observedChecksum,
        fileSizeBytes: observedSize,
        objectEtag: primary.etag,
        objectVersionId: primary.versionId,
      },
    });
    void finalized;
    return { outcome: "failed", bytesCopied: 0 };
  }

  const verifiedAt = new Date();
  const replicaVersionId = normalizeS3VersionId(replica.versionId)!;
  try {
    await writeRecoveryCatalog({
      item,
      replicaObjectKey: replicaKey,
      checksumSha256: observedChecksum,
      fileSizeBytes: observedSize,
      objectEtag: replica.etag ?? write?.etag,
      objectVersionId: replicaVersionId,
      verifiedAt,
    });
  } catch {
    const finalized = await finalizeReplica(item, {
      status: "pending",
      operationId,
      eventKind: "recovery_catalog_retry_scheduled",
      objectKey: replicaKey,
      checksumSha256: observedChecksum,
      fileSizeBytes: observedSize,
      objectEtag: replica.etag ?? write?.etag,
      objectVersionId: replicaVersionId,
      failureCode: "catalog_write_failed",
      lastErrorClass: "retryable_provider_error",
      nextAttemptAt: retryAt(item.attemptCount),
      replicatedAt: verifiedAt,
      verifiedAt: null,
      workerRunId,
      primaryTransition: {
        status: "available",
        eventKind: "primary_verified",
        checksumSha256: observedChecksum,
        fileSizeBytes: observedSize,
        objectEtag: primary.etag,
        objectVersionId: primary.versionId,
      },
    });
    void finalized;
    return { outcome: "failed", bytesCopied: observedSize };
  }

  const finalized = await finalizeReplica(item, {
    status: "available",
    operationId,
    eventKind: "replica_verified",
    objectKey: replicaKey,
    checksumSha256: observedChecksum,
    fileSizeBytes: observedSize,
    objectEtag: replica.etag ?? write?.etag,
    objectVersionId: replicaVersionId,
    replicatedAt: verifiedAt,
    verifiedAt,
    workerRunId,
    primaryTransition: {
      status: "available",
      eventKind: "primary_verified",
      checksumSha256: observedChecksum,
      fileSizeBytes: observedSize,
      objectEtag: primary.etag,
      objectVersionId: primary.versionId,
    },
  });
  return {
    outcome: finalized ? "copied" : "failed",
    bytesCopied: observedSize,
  };
}

export async function getFileReplicaCoverage(
  scope: string[] | null = replicaStoragePracticeScope(),
): Promise<{
  backlog: number;
  available: number;
  activeFiles: number;
  coveragePct: number;
}> {
  const freshAfter = new Date(Date.now() - VERIFY_AFTER_MS);
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      select
        count(*) filter (
          where r.status = 'available' and r.verified_at >= ${freshAfter}
        )::int as "available",
        count(*) filter (
          where r.status is null
             or r.status <> 'available'
             or r.verified_at is null
             or r.verified_at < ${freshAfter}
        )::int as "backlog",
        count(*)::int as "activeFiles"
      from files f
      join practices p on p.id = f.practice_id and p.deleted_at is null
      left join file_object_replicas r
        on r.file_id = f.id
       and r.replica_target = ${FILE_REPLICA_TARGET}
       and r.deleted_at is null
      where f.deleted_at is null
        and ${replicaPracticeScopeSql(scope)}
    `);
    const coverage = rowsFromExecute<{
      backlog: number | string;
      available: number | string;
      activeFiles: number | string;
    }>(result)[0] ?? { backlog: 0, available: 0, activeFiles: 0 };
    const backlog = Number(coverage.backlog);
    const available = Number(coverage.available);
    const activeFiles = Number(coverage.activeFiles);
    return {
      backlog,
      available,
      activeFiles,
      coveragePct:
        activeFiles === 0
          ? 100
          : Number(((available / activeFiles) * 100).toFixed(2)),
    };
  });
}

export async function reconcileFileReplicas(
  options: { limit?: number; budgetMs?: number } = {},
): Promise<FileReplicaRunMetrics> {
  const readiness = replicaStorageReadiness();
  const required = replicaStorageRequired();
  const enabled = replicaStorageRolloutEnabled();
  const empty: FileReplicaRunMetrics = {
    intended: readiness.intended,
    required,
    configured: readiness.ready,
    enabled,
    candidates: 0,
    claimed: 0,
    deferred: 0,
    copied: 0,
    alreadyPresent: 0,
    repairedPrimary: 0,
    sourceMissing: 0,
    sourceCorrupt: 0,
    failed: 0,
    bytesCopied: 0,
    backlog: 0,
    available: 0,
    activeFiles: 0,
    coveragePct: 0,
  };

  if (!readiness.ready) {
    if (readiness.intended) {
      await alertOps("File replica configuration is invalid", readiness.detail);
    }
    return empty;
  }
  if (!enabled) return empty;

  const limit = boundedBatchSize(options.limit);
  const scope = replicaStoragePracticeScope();
  const candidates = await materializeMissingReplicaRows(limit, scope);
  const workerRunId = randomUUID();
  const metrics = { ...empty, candidates };
  const deadline =
    Date.now() + Math.max(1_000, options.budgetMs ?? DEFAULT_JOB_BUDGET_MS);
  let processed = 0;
  let budgetExhausted = false;

  while (processed < limit) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }

    const [item] = await claimReplicaRows({
      limit: 1,
      staleBefore: new Date(Date.now() - VERIFY_AFTER_MS),
      scope,
    });
    if (!item) break;
    processed += 1;
    metrics.claimed += 1;

    try {
      const result = await processClaimedReplica(item, workerRunId);
      metrics.bytesCopied += result.bytesCopied;
      if (result.outcome === "copied") metrics.copied += 1;
      if (result.outcome === "already_present") metrics.alreadyPresent += 1;
      if (result.outcome === "repaired_primary") metrics.repairedPrimary += 1;
      if (result.outcome === "source_missing") metrics.sourceMissing += 1;
      if (result.outcome === "source_corrupt") metrics.sourceCorrupt += 1;
      if (result.outcome === "failed") metrics.failed += 1;
    } catch {
      metrics.failed += 1;
      await finalizeReplica(item, {
        status: item.replicaStatus === "available" ? "available" : "pending",
        operationId: randomUUID(),
        eventKind: "replication_attempt_crashed",
        failureCode: "worker_error",
        lastErrorClass: "retryable_worker_error",
        nextAttemptAt: retryAt(item.attemptCount),
        verifiedAt:
          item.replicaStatus === "available" && item.replicaVerifiedAt
            ? new Date(item.replicaVerifiedAt)
            : null,
        workerRunId,
      });
    }
  }

  const coverage = await getFileReplicaCoverage(scope);
  metrics.backlog = coverage.backlog;
  metrics.available = coverage.available;
  metrics.activeFiles = coverage.activeFiles;
  metrics.deferred = budgetExhausted ? coverage.backlog : 0;
  metrics.coveragePct = coverage.coveragePct;
  return metrics;
}
