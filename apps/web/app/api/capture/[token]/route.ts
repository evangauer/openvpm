import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { captureSessions, files, practices } from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  captureRateLimitKey,
  isCaptureTokenShape,
} from "@/lib/consult/tokens";
import { deleteFile, uploadFile } from "@/lib/s3";
import {
  isAllowedUploadMimeType,
  uploadBytesMatchMimeType,
} from "@/lib/upload-security";
import {
  UPLOAD_FILE_MAX_BYTES,
  UPLOAD_REQUEST_MAX_BYTES,
  uploadRequestContentLengthTooLarge,
} from "@/lib/upload-limits";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { PATIENT_PHOTO_CATEGORY } from "@/lib/records/file-kinds";

export const dynamic = "force-dynamic";

/**
 * No-login photo upload endpoint behind an in-consult QR capture link
 * (see server/routers/records.ts createCaptureSession).
 *
 * Security model mirrors the calendar feed route: token shape is validated
 * before any work, lookups run under withSystem with an explicit
 * practice-alive check, and every miss is the same generic 404 (no
 * token-validity oracle). Tokens expire after 30 minutes.
 */

const TOKEN_LIMIT = 60;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;

const MAX_FILE_NAME_LENGTH = 255;
const CAPTURE_FILE_CATEGORY = PATIENT_PHOTO_CATEGORY;

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  const ipResult = await rateLimit({
    key: `capture-upload:ip:${clientIpFromRequest(request)}`,
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  });
  if (!ipResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) }
    );
  }

  const tokenResult = await rateLimit({
    key: captureRateLimitKey("capture-upload", token),
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });
  if (!tokenResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: rateLimitResponseHeaders(TOKEN_LIMIT, tokenResult),
      }
    );
  }

  if (uploadRequestContentLengthTooLarge(request.headers)) {
    return NextResponse.json(
      { error: "Upload exceeds maximum request size" },
      { status: 413 }
    );
  }

  const now = new Date();
  const session = await withSystem(db, async (tx) => {
    const [row] = await tx
      .select({
        id: captureSessions.id,
        practiceId: captureSessions.practiceId,
        patientId: captureSessions.patientId,
        createdBy: captureSessions.createdBy,
        appointmentId: captureSessions.appointmentId,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
      })
      .from(captureSessions)
      .innerJoin(
        practices,
        and(
          eq(practices.id, captureSessions.practiceId),
          isNull(practices.deletedAt)
        )
      )
      .where(
        and(
          eq(captureSessions.token, token),
          isNull(captureSessions.deletedAt),
          gt(captureSessions.expiresAt, now)
        )
      )
      .limit(1);
    return row ?? null;
  });

  // Unknown, expired, and orphaned sessions all get the same generic miss.
  if (!session || !session.createdBy) {
    return notFound();
  }

  // Hosted read-only practices cannot take on new uploads (mirrors
  // /api/upload); keep the response generic so it is not a billing oracle.
  if (
    billingEnforced() &&
    !hasHostedFullAccess(session.tier, session.billingStatus, session.trialEndsAt)
  ) {
    return notFound();
  }

  // ---------- Parse multipart form data ----------
  let formData: FormData;
  try {
    const body = await readRequestBytesWithLimit(
      request,
      UPLOAD_REQUEST_MAX_BYTES
    );
    if (!body.ok) {
      return NextResponse.json(
        { error: "Upload exceeds maximum request size" },
        { status: 413 }
      );
    }

    const boundedBody = new ArrayBuffer(body.bytes.byteLength);
    new Uint8Array(boundedBody).set(body.bytes);
    const boundedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: boundedBody,
    });
    formData = await boundedRequest.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }
  if (!file.name || file.name.length > MAX_FILE_NAME_LENGTH) {
    return NextResponse.json(
      { error: "File name must be between 1 and 255 characters" },
      { status: 400 }
    );
  }

  // ---------- Validate MIME type (images only for capture) ----------
  const mimeType = file.type;
  if (!mimeType.startsWith("image/") || !isAllowedUploadMimeType(mimeType)) {
    return NextResponse.json(
      { error: "Capture uploads must be JPG, PNG, or WebP images" },
      { status: 400 }
    );
  }

  // ---------- Validate size ----------
  if (file.size > UPLOAD_FILE_MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds maximum size of 10 MB" },
      { status: 400 }
    );
  }

  // ---------- Build S3 key ----------
  const uuid = randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${session.practiceId}/${CAPTURE_FILE_CATEGORY}/${uuid}-${safeName}`;
  let uploadedKey: string | null = null;

  // ---------- Upload ----------
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!uploadBytesMatchMimeType(mimeType, buffer)) {
      return NextResponse.json(
        { error: "File contents do not match the declared file type" },
        { status: 400 }
      );
    }

    await uploadFile(key, buffer, mimeType);
    uploadedKey = key;

    // Serve through the same-origin proxy (app/api/files/[...path]).
    const url = `/api/files/${key}`;

    const [inserted] = await withTenant(db, session.practiceId, (tx) =>
      tx
        .insert(files)
        .values({
          practiceId: session.practiceId,
          uploadedBy: session.createdBy!,
          fileName: file.name,
          fileKey: key,
          fileUrl: url,
          mimeType,
          fileSizeBytes: file.size,
          category: CAPTURE_FILE_CATEGORY,
          entityType: "patient",
          entityId: session.patientId,
          appointmentId: session.appointmentId,
        })
        .returning({ id: files.id })
    );

    return NextResponse.json(
      { ok: true, fileId: inserted?.id ?? null },
      { status: 201 }
    );
  } catch (err) {
    console.error("Capture upload failed:", err);
    if (uploadedKey) {
      try {
        await deleteFile(uploadedKey);
      } catch (cleanupErr) {
        console.error("Failed to clean up uploaded object:", cleanupErr);
      }
    }
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
