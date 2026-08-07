import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@openpims/db/client";
import { files, practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { getObject } from "@/lib/s3";
import { withSystem } from "@/lib/tenant-db";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import {
  contentDispositionForFile,
  filenameFromObjectKey,
  isAllowedUploadCategory,
} from "@/lib/upload-security";
import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";

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
        mimeType: files.mimeType,
      })
      .from(files)
      .innerJoin(
        practices,
        and(eq(practices.id, files.practiceId), isNull(practices.deletedAt)),
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
  if (
    isPublic &&
    !metadata.mimeType?.toLowerCase().startsWith("image/")
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const obj = await getObject(key, { maxBytes: UPLOAD_FILE_MAX_BYTES });
  if (!obj) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    isPublic &&
    !obj.contentType?.toLowerCase().startsWith("image/")
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(Buffer.from(obj.body), {
    headers: {
      "Content-Type": obj.contentType ?? "application/octet-stream",
      "Content-Disposition": contentDispositionForFile({
        filename: filenameFromObjectKey(key),
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
