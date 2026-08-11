import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@openpims/db/client";
import { fileObjectReplicas, files, practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  FILE_REPLICA_TARGET,
  normalizeS3VersionId,
  readPrimaryObject,
  readReplicaObject,
} from "@/lib/s3";
import { withSystem } from "@/lib/tenant-db";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import {
  contentDispositionForFile,
  isAllowedUploadCategory,
} from "@/lib/upload-security";
import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";
import {
  checksumSha256Hex,
  schedulePrimaryRepair,
} from "@/lib/file-replication";

export const dynamic = "force-dynamic";

async function getActiveFileMetadata({
  key,
  practiceId,
  category,
}: {
  key: string;
  practiceId: string;
  category: string;
}) {
  const [file] = await withSystem(db, (tx) =>
    tx
      .select({
        id: files.id,
        fileName: files.fileName,
        mimeType: files.mimeType,
        checksumSha256: files.checksumSha256,
        fileSizeBytes: files.fileSizeBytes,
        storageStatus: files.storageStatus,
        replicaObjectKey: fileObjectReplicas.objectKey,
        replicaObjectVersionId: fileObjectReplicas.objectVersionId,
        replicaChecksumSha256: fileObjectReplicas.checksumSha256,
        replicaFileSizeBytes: fileObjectReplicas.fileSizeBytes,
        replicaStatus: fileObjectReplicas.status,
      })
      .from(files)
      .innerJoin(
        practices,
        and(eq(practices.id, files.practiceId), isNull(practices.deletedAt)),
      )
      .leftJoin(
        fileObjectReplicas,
        and(
          eq(fileObjectReplicas.fileId, files.id),
          eq(fileObjectReplicas.practiceId, files.practiceId),
          eq(fileObjectReplicas.replicaTarget, FILE_REPLICA_TARGET),
          isNull(fileObjectReplicas.deletedAt),
        ),
      )
      .where(
        and(
          eq(files.fileKey, key),
          eq(files.practiceId, practiceId),
          eq(files.category, category),
          isNull(files.deletedAt),
        ),
      )
      .limit(1),
  );

  return file ?? null;
}

function objectKeyFromPath(path: string[]): string | null {
  const decoded: string[] = [];

  for (const segment of path) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (!value || value.includes("/") || value.includes("\\")) {
      return null;
    }

    decoded.push(value);
  }

  if (decoded.length !== 3) {
    return null;
  }

  return decoded.join("/");
}

/**
 * Same-origin file proxy. Uploaded objects live in a PRIVATE R2/S3 bucket, so
 * the raw storage URL can't be loaded by an <img> tag (it 401s). This streams
 * the object through the app instead.
 *
 * Access model, keyed off the object path `{practiceId}/{category}/{file}`:
 *  - `branding/*` (logos) is PUBLIC — logos must render in emails and the
 *    unauthenticated client portal, and contain nothing sensitive.
 *  - everything else (patient-photos, documents, lab-results) is tenant-private:
 *    the caller must be signed in and belong to the owning practice.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const key = objectKeyFromPath(path);
  if (!key) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [practiceId, category] = key.split("/");
  if (!practiceId || !category || !isAllowedUploadCategory(category)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isPublic = category === "branding";
  if (!isPublic) {
    if (hasBlankConfiguredNextAuthSecret()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.practiceId !== practiceId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [activeUser] = await withSystem(db, (tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(
          practices,
          and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
        )
        .where(
          and(
            eq(users.id, session.user.id),
            eq(users.practiceId, practiceId),
            isNull(users.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!activeUser) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const metadata = await getActiveFileMetadata({
    key,
    practiceId,
    category,
  });
  if (!metadata) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isPublic && !metadata.mimeType?.toLowerCase().startsWith("image/")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    metadata.storageStatus === "pending_upload" ||
    metadata.storageStatus === "cleanup_pending"
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const primary = await readPrimaryObject(key, {
    maxBytes: UPLOAD_FILE_MAX_BYTES,
  });
  const primaryMatchesManifest =
    primary.status === "available" &&
    (!metadata.checksumSha256 ||
      (primary.body.byteLength === metadata.fileSizeBytes &&
        checksumSha256Hex(primary.body) === metadata.checksumSha256));
  let obj = primaryMatchesManifest
    ? { body: primary.body, contentType: primary.contentType }
    : null;
  let replicaFallbackState:
    | "not_attempted"
    | "available"
    | "missing"
    | "failed"
    | "corrupt" = "not_attempted";
  const replicaObjectVersionId = normalizeS3VersionId(
    metadata.replicaObjectVersionId,
  );

  if (
    !obj &&
    metadata.replicaStatus === "available" &&
    metadata.replicaObjectKey &&
    replicaObjectVersionId
  ) {
    const expectedChecksum =
      metadata.checksumSha256 ?? metadata.replicaChecksumSha256;
    const expectedSize =
      metadata.fileSizeBytes ?? metadata.replicaFileSizeBytes;
    if (expectedChecksum && expectedSize != null) {
      const replica = await readReplicaObject(metadata.replicaObjectKey, {
        maxBytes: UPLOAD_FILE_MAX_BYTES,
        versionId: replicaObjectVersionId,
      });
      if (
        replica.status === "available" &&
        normalizeS3VersionId(replica.versionId) === replicaObjectVersionId &&
        replica.body.byteLength === expectedSize &&
        checksumSha256Hex(replica.body) === expectedChecksum
      ) {
        replicaFallbackState = "available";
        obj = { body: replica.body, contentType: replica.contentType };
        const observedState =
          primary.status === "missing"
            ? "missing"
            : primary.status === "available"
              ? "corrupt"
              : "failed";
        await schedulePrimaryRepair({
          practiceId,
          fileId: metadata.id,
          fileKey: key,
          checksumSha256: metadata.checksumSha256,
          fileSizeBytes: metadata.fileSizeBytes,
          storageStatus: metadata.storageStatus,
          observedState,
        });
      } else {
        replicaFallbackState =
          replica.status === "available" ? "corrupt" : replica.status;
      }
    }
  }

  if (!obj) {
    const definitiveMissing =
      primary.status === "missing" &&
      (replicaFallbackState === "not_attempted" ||
        replicaFallbackState === "missing");
    return NextResponse.json(
      {
        error: definitiveMissing ? "Not found" : "File temporarily unavailable",
      },
      { status: definitiveMissing ? 404 : 503 },
    );
  }
  if (isPublic && !obj.contentType?.toLowerCase().startsWith("image/")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(Buffer.from(obj.body), {
    headers: {
      "Content-Type": obj.contentType ?? "application/octet-stream",
      "Content-Disposition": contentDispositionForFile({
        filename: metadata.fileName,
        contentType: obj.contentType,
        isPublic,
      }),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": isPublic
        ? "public, max-age=86400"
        : "private, max-age=3600",
    },
  });
}
