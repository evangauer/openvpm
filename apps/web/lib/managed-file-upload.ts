import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { files } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  readPrimaryObject,
  uploadManagedFile,
  type StoredObjectWrite,
} from "@/lib/s3";
import {
  checksumSha256Hex,
  registerFileForReplication,
} from "@/lib/file-replication";
import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";

export type ManagedUploadCategory = "branding" | "patient-photos" | "consents";
export type DashboardUploadCategory = Exclude<
  ManagedUploadCategory,
  "consents"
>;

export class ManagedUploadConflictError extends Error {
  constructor(
    message = "Idempotency key was already used for a different upload",
  ) {
    super(message);
    this.name = "ManagedUploadConflictError";
  }
}

export class ManagedUploadStateError extends ManagedUploadConflictError {
  constructor(status: string) {
    super(`Upload reservation is not retryable from state: ${status}`);
    this.name = "ManagedUploadStateError";
  }
}

export interface ManagedUploadReservation {
  id: string;
  practiceId: string;
  uploadedBy: string;
  idempotencyKey: string;
  fileName: string;
  fileKey: string;
  fileUrl: string;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  storageStatus: string;
  category: ManagedUploadCategory;
  source: string;
  entityType: string;
  entityId: string;
  patientId: string | null;
  appointmentId: string | null;
  created: boolean;
}

export type ManagedUploadReservationInput = {
  practiceId: string;
  uploadedBy: string;
  idempotencyKey: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  category: ManagedUploadCategory;
  source: string;
  entityType: "practice" | "patient";
  entityId: string;
  patientId?: string | null;
  appointmentId?: string | null;
};

const reservationSelection = {
  id: files.id,
  practiceId: files.practiceId,
  uploadedBy: files.uploadedBy,
  idempotencyKey: files.idempotencyKey,
  fileName: files.fileName,
  fileKey: files.fileKey,
  fileUrl: files.fileUrl,
  mimeType: files.mimeType,
  fileSizeBytes: files.fileSizeBytes,
  checksumSha256: files.checksumSha256,
  storageStatus: files.storageStatus,
  category: files.category,
  source: files.source,
  entityType: files.entityType,
  entityId: files.entityId,
  patientId: files.patientId,
  appointmentId: files.appointmentId,
  deletedAt: files.deletedAt,
};

function toReservation(
  row: typeof reservationSelection extends Record<string, infer _T>
    ? Record<keyof typeof reservationSelection, unknown>
    : never,
  created: boolean,
): ManagedUploadReservation {
  const { deletedAt, ...reservation } = row as Record<
    keyof typeof reservationSelection,
    unknown
  >;
  if (deletedAt != null) {
    throw new ManagedUploadStateError("deleted");
  }
  return {
    ...(reservation as Omit<ManagedUploadReservation, "created">),
    created,
  };
}

function reservationMatches(
  row: ManagedUploadReservation,
  input: ManagedUploadReservationInput,
): boolean {
  return (
    row.practiceId === input.practiceId &&
    row.uploadedBy === input.uploadedBy &&
    row.idempotencyKey === input.idempotencyKey &&
    row.fileName === input.fileName &&
    row.mimeType === input.mimeType &&
    row.fileSizeBytes === input.fileSizeBytes &&
    row.checksumSha256 === input.checksumSha256 &&
    row.category === input.category &&
    row.source === input.source &&
    row.entityType === input.entityType &&
    row.entityId === input.entityId &&
    row.patientId === (input.patientId ?? null) &&
    row.appointmentId === (input.appointmentId ?? null)
  );
}

function reservedObjectLocation(
  practiceId: string,
  category: ManagedUploadCategory,
  objectId: string,
): { fileKey: string; fileUrl: string } {
  const fileKey = `${practiceId}/${category}/${objectId}`;
  return { fileKey, fileUrl: `/api/files/${fileKey}` };
}

/**
 * A corrupt deterministic object must never be overwritten or deleted during
 * a request: either action could destroy the only committed provider result.
 * Keep the same manifest/idempotency identity but move its next attempt to a
 * fresh, unreferenced object key. Recovery keys retain the manifest ID prefix
 * so the old objects remain discoverable for separate operator inspection or
 * cleanup without a request-time delete.
 */
async function rotateCorruptReservation(
  tx: Database,
  reservation: ManagedUploadReservation,
): Promise<ManagedUploadReservation> {
  const replacement = reservedObjectLocation(
    reservation.practiceId,
    reservation.category,
    `${reservation.id}-${randomUUID()}`,
  );
  const [rotated] = await tx
    .update(files)
    .set({
      ...replacement,
      storageStatus: "pending_upload",
      storageVerifiedAt: null,
      objectEtag: null,
      objectVersionId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        eq(files.storageStatus, "corrupt"),
        isNull(files.deletedAt),
      ),
    )
    .returning(reservationSelection);
  if (!rotated) {
    throw new Error("Corrupt upload reservation could not be recovered");
  }

  // This is an existing idempotency reservation. Returning created=false also
  // forces a read-before-write of the replacement key.
  return toReservation(rotated as never, false);
}

/**
 * Missing and legacy-unverified manifests may safely retry on their existing
 * deterministic key. The provider helper reads before writing, so any exact
 * committed bytes converge without an overwrite. Cleanup-pending and unknown
 * states remain terminal and must never be revived by a client request.
 */
async function reopenRetryableReservation(
  tx: Database,
  reservation: ManagedUploadReservation,
): Promise<ManagedUploadReservation> {
  const [reopened] = await tx
    .update(files)
    .set({
      storageStatus: "pending_upload",
      storageVerifiedAt: null,
      objectEtag: null,
      objectVersionId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        inArray(files.storageStatus, ["missing", "unverified"]),
        isNull(files.deletedAt),
      ),
    )
    .returning(reservationSelection);
  if (!reopened) {
    throw new ManagedUploadStateError(reservation.storageStatus);
  }
  return toReservation(reopened as never, false);
}

/** Reserve a durable manifest before any provider write. */
export async function reserveManagedUpload(
  tx: Database,
  input: ManagedUploadReservationInput,
): Promise<ManagedUploadReservation> {
  const fileId = randomUUID();
  const { fileKey, fileUrl } = reservedObjectLocation(
    input.practiceId,
    input.category,
    fileId,
  );
  const [inserted] = await tx
    .insert(files)
    .values({
      id: fileId,
      practiceId: input.practiceId,
      uploadedBy: input.uploadedBy,
      idempotencyKey: input.idempotencyKey,
      fileName: input.fileName,
      fileKey,
      fileUrl,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      checksumSha256: input.checksumSha256,
      storageStatus: "pending_upload",
      category: input.category,
      source: input.source,
      entityType: input.entityType,
      entityId: input.entityId,
      patientId: input.patientId ?? null,
      appointmentId: input.appointmentId ?? null,
    })
    .onConflictDoNothing()
    .returning(reservationSelection);

  if (inserted) {
    return toReservation(inserted as never, true);
  }

  const [existing] = await tx
    .select(reservationSelection)
    .from(files)
    .where(
      and(
        eq(files.practiceId, input.practiceId),
        eq(files.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1)
    .for("update");
  if (!existing) {
    throw new Error("Upload reservation conflict could not be resolved");
  }

  const reservation = toReservation(existing as never, false);
  if (!reservationMatches(reservation, input)) {
    throw new ManagedUploadConflictError();
  }
  if (reservation.storageStatus === "corrupt") {
    return rotateCorruptReservation(tx, reservation);
  }
  if (
    reservation.storageStatus === "missing" ||
    reservation.storageStatus === "unverified"
  ) {
    return reopenRetryableReservation(tx, reservation);
  }
  if (
    reservation.storageStatus === "pending_upload" ||
    reservation.storageStatus === "available"
  ) {
    return reservation;
  }
  throw new ManagedUploadStateError(reservation.storageStatus);
}

export type ManagedUploadWriteResult =
  | { status: "verified"; evidence: StoredObjectWrite }
  | { status: "unavailable" }
  | { status: "corrupt" };

function exactBytes(
  body: Uint8Array,
  expectedChecksum: string,
  expectedSize: number,
): boolean {
  return (
    body.byteLength === expectedSize &&
    checksumSha256Hex(body) === expectedChecksum
  );
}

/**
 * Converge an ambiguous PUT by reading the deterministic reserved key. A
 * provider error never causes immediate deletion because the write may have
 * committed; the reservation remains retryable instead.
 */
export async function putAndVerifyManagedUpload(input: {
  reservation: ManagedUploadReservation;
  body: Buffer;
}): Promise<ManagedUploadWriteResult> {
  const { reservation, body } = input;
  if (!reservation.created) {
    const existing = await readPrimaryObject(reservation.fileKey, {
      maxBytes: UPLOAD_FILE_MAX_BYTES,
    });
    if (existing.status === "available") {
      return exactBytes(
        existing.body,
        reservation.checksumSha256,
        reservation.fileSizeBytes,
      )
        ? {
            status: "verified",
            evidence: {
              url: reservation.fileUrl,
              ...(existing.etag ? { etag: existing.etag } : {}),
              ...(existing.versionId ? { versionId: existing.versionId } : {}),
            },
          }
        : { status: "corrupt" };
    }
    if (existing.status === "failed") return { status: "unavailable" };
  }

  let write: StoredObjectWrite | undefined;
  try {
    write = await uploadManagedFile(
      reservation.fileKey,
      body,
      reservation.mimeType,
      reservation.checksumSha256,
    );
  } catch {
    // A timed-out PUT may have committed; the read-back below is authoritative.
  }

  const verification = await readPrimaryObject(reservation.fileKey, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
    ...(write?.versionId ? { versionId: write.versionId } : {}),
  });
  if (verification.status !== "available") {
    return { status: "unavailable" };
  }
  if (
    !exactBytes(
      verification.body,
      reservation.checksumSha256,
      reservation.fileSizeBytes,
    )
  ) {
    return { status: "corrupt" };
  }

  return {
    status: "verified",
    evidence: {
      url: write?.url ?? reservation.fileUrl,
      etag: verification.etag ?? write?.etag,
      versionId: verification.versionId ?? write?.versionId,
    },
  };
}

export async function finalizeManagedUploadManifest(
  tx: Database,
  reservation: ManagedUploadReservation,
  evidence: StoredObjectWrite,
): Promise<boolean> {
  const [updated] = await tx
    .update(files)
    .set({
      storageStatus: "available",
      storageVerifiedAt: new Date(),
      objectEtag: evidence.etag ?? null,
      objectVersionId: evidence.versionId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        eq(files.storageStatus, "pending_upload"),
        isNull(files.deletedAt),
      ),
    )
    .returning({ id: files.id });
  if (updated) return true;

  // An exact concurrent request may already have completed this generation.
  // Treat that as success without rewriting its provider/version evidence.
  // A rotated key, changed checksum, or any other state remains a hard miss.
  const [alreadyAvailable] = await tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        eq(files.storageStatus, "available"),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(alreadyAvailable);
}

export async function markManagedUploadCorrupt(
  tx: Database,
  reservation: ManagedUploadReservation,
): Promise<boolean> {
  const [updated] = await tx
    .update(files)
    .set({
      storageStatus: "corrupt",
      storageVerifiedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        eq(files.storageStatus, "pending_upload"),
        isNull(files.deletedAt),
      ),
    )
    .returning({ id: files.id });
  if (updated) return true;

  const [alreadyCorrupt] = await tx
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.id, reservation.id),
        eq(files.practiceId, reservation.practiceId),
        eq(files.idempotencyKey, reservation.idempotencyKey),
        eq(files.fileKey, reservation.fileKey),
        eq(files.fileUrl, reservation.fileUrl),
        eq(files.checksumSha256, reservation.checksumSha256),
        eq(files.fileSizeBytes, reservation.fileSizeBytes),
        eq(files.storageStatus, "corrupt"),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(alreadyCorrupt);
}

export async function queueManagedUploadReplication(
  reservation: ManagedUploadReservation,
  evidence: StoredObjectWrite,
): Promise<boolean> {
  return registerFileForReplication({
    practiceId: reservation.practiceId,
    fileId: reservation.id,
    fileKey: reservation.fileKey,
    checksumSha256: reservation.checksumSha256,
    fileSizeBytes: reservation.fileSizeBytes,
    objectEtag: evidence.etag,
    objectVersionId: evidence.versionId,
  });
}
