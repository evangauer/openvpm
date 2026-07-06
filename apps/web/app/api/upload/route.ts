import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { randomUUID } from "crypto";
import { authOptions } from "@/lib/auth";
import { deleteFile, uploadFile } from "@/lib/s3";
import { db } from "@openpims/db/client";
import { files, practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  ALLOWED_UPLOAD_CATEGORIES,
  ALLOWED_UPLOAD_MIME_TYPES,
  isAllowedUploadCategory,
  isAllowedUploadMimeType,
  uploadBytesMatchMimeType,
} from "@/lib/upload-security";
import {
  UPLOAD_REQUEST_MAX_BYTES,
  UPLOAD_FILE_MAX_BYTES,
  uploadRequestContentLengthTooLarge,
} from "@/lib/upload-limits";
import { readRequestBytesWithLimit } from "@/lib/request-body";

const MAX_FILE_NAME_LENGTH = 255;

export async function POST(req: NextRequest) {
  // ---------- Auth ----------
  if (hasBlankConfiguredNextAuthSecret()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (uploadRequestContentLengthTooLarge(req.headers)) {
    return NextResponse.json(
      { error: "Upload exceeds maximum request size" },
      { status: 413 },
    );
  }

  const [activeAccount] = await withSystem(db, (tx) =>
    tx
      .select({
        userId: users.id,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
      })
      .from(users)
      .innerJoin(
        practices,
        and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
      )
      .where(
        and(
          eq(users.id, session.user.id),
          eq(users.practiceId, session.user.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!activeAccount) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (billingEnforced()) {
    if (
      !hasHostedFullAccess(
        activeAccount.tier,
        activeAccount.billingStatus,
        activeAccount.trialEndsAt
      )
    ) {
      return NextResponse.json(
        {
          error:
            "OpenVPM Cloud is read-only until your trial or subscription is active.",
        },
        { status: 403 }
      );
    }
  }

  // ---------- Parse multipart form data ----------
  let formData: FormData;
  try {
    const body = await readRequestBytesWithLimit(req, UPLOAD_REQUEST_MAX_BYTES);
    if (!body.ok) {
      return NextResponse.json(
        { error: "Upload exceeds maximum request size" },
        { status: 413 },
      );
    }

    const boundedBody = new ArrayBuffer(body.bytes.byteLength);
    new Uint8Array(boundedBody).set(body.bytes);
    const boundedRequest = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: boundedBody,
    });
    formData = await boundedRequest.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid form data" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const category = formData.get("category");

  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing file field" },
      { status: 400 },
    );
  }
  if (!file.name || file.name.length > MAX_FILE_NAME_LENGTH) {
    return NextResponse.json(
      { error: "File name must be between 1 and 255 characters" },
      { status: 400 },
    );
  }

  // ---------- Validate category ----------
  if (
    typeof category !== "string" ||
    !isAllowedUploadCategory(category)
  ) {
    return NextResponse.json(
      {
        error: `Invalid category. Allowed: ${ALLOWED_UPLOAD_CATEGORIES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  // ---------- Validate MIME type ----------
  const mimeType = file.type;
  if (!isAllowedUploadMimeType(mimeType)) {
    return NextResponse.json(
      {
        error: `File type not allowed. Accepted: ${Object.keys(ALLOWED_UPLOAD_MIME_TYPES).join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (category === "branding" && !mimeType.startsWith("image/")) {
    return NextResponse.json(
      { error: "Branding uploads must be image files" },
      { status: 400 },
    );
  }

  // ---------- Validate size ----------
  if (file.size > UPLOAD_FILE_MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds maximum size of 10 MB" },
      { status: 400 },
    );
  }

  // ---------- Build S3 key ----------
  const practiceId = session.user.practiceId;
  const uuid = randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${practiceId}/${category}/${uuid}-${safeName}`;
  let uploadedKey: string | null = null;

  // ---------- Upload ----------
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!uploadBytesMatchMimeType(mimeType, buffer)) {
      return NextResponse.json(
        { error: "File contents do not match the declared file type" },
        { status: 400 },
      );
    }

    await uploadFile(key, buffer, mimeType);
    uploadedKey = key;

    // Serve through the same-origin proxy (app/api/files/[...path]). The raw
    // R2/S3 URL is private and can't be loaded by an <img> tag.
    const url = `/api/files/${key}`;

    // Persist metadata in the database (tenant-scoped for RLS).
    await withTenant(db, practiceId, (tx) =>
      tx.insert(files).values({
        practiceId,
        uploadedBy: session.user.id,
        fileName: file.name,
        fileKey: key,
        fileUrl: url,
        mimeType,
        fileSizeBytes: file.size,
        category,
      })
    );

    return NextResponse.json({ url, key }, { status: 201 });
  } catch (err) {
    console.error("Upload failed:", err);
    if (uploadedKey) {
      try {
        await deleteFile(uploadedKey);
      } catch (cleanupErr) {
        console.error("Failed to clean up uploaded object:", cleanupErr);
      }
    }
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 },
    );
  }
}
