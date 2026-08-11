import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  appointments,
  captureSessions,
  files,
  patients,
  practices,
  users,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { captureRateLimitKey, isCaptureTokenShape } from "@/lib/consult/tokens";
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
import { checksumSha256Hex } from "@/lib/file-replication";
import {
  finalizeManagedUploadManifest,
  ManagedUploadConflictError,
  markManagedUploadCorrupt,
  putAndVerifyManagedUpload,
  queueManagedUploadReplication,
  reserveManagedUpload,
} from "@/lib/managed-file-upload";

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
// A clinic NAT can legitimately have many staff phones uploading at once.
// Token and per-session limits remain the tighter capability controls.
const IP_LIMIT = 300;
const IP_WINDOW_MS = 10 * 60 * 1000;

const MAX_FILE_NAME_LENGTH = 255;
const CAPTURE_FILE_CATEGORY = PATIENT_PHOTO_CATEGORY;
const CAPTURE_SESSION_FILE_LIMIT = 20;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class CaptureSessionLimitError extends Error {}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

async function lookupCaptureSession(database: Database, token: string) {
  const now = new Date();
  const [row] = await database
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
        eq(practices.recoveryHold, false),
        isNull(practices.deletedAt),
      ),
    )
    .where(
      and(
        eq(captureSessions.token, token),
        isNull(captureSessions.deletedAt),
        gt(captureSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  return withSystem(db, async (systemTx) => {
    const session = await lookupCaptureSession(systemTx, token);
    // Unknown, expired, orphaned, deleted-practice, and recovery-held sessions
    // all get the same generic miss before request-body or provider work.
    if (!session || !session.createdBy) {
      return notFound();
    }
    if (
      !(await lockPracticeForExternalSideEffects(systemTx, session.practiceId))
    ) {
      return notFound();
    }

    // Hosted read-only practices cannot take on new uploads (mirrors
    // /api/upload); keep the response generic so it is not a billing oracle.
    if (
      billingEnforced() &&
      !hasHostedFullAccess(
        session.tier,
        session.billingStatus,
        session.trialEndsAt,
      )
    ) {
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
        { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) },
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
        },
      );
    }

    if (uploadRequestContentLengthTooLarge(request.headers)) {
      return NextResponse.json(
        { error: "Upload exceeds maximum request size" },
        { status: 413 },
      );
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return NextResponse.json(
        { error: "A canonical UUID Idempotency-Key header is required" },
        { status: 400 },
      );
    }

    // ---------- Parse multipart form data ----------
    let formData: FormData;
    try {
      const body = await readRequestBytesWithLimit(
        request,
        UPLOAD_REQUEST_MAX_BYTES,
      );
      if (!body.ok) {
        return NextResponse.json(
          { error: "Upload exceeds maximum request size" },
          { status: 413 },
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

    // ---------- Validate MIME type (images only for capture) ----------
    const mimeType = file.type;
    if (!mimeType.startsWith("image/") || !isAllowedUploadMimeType(mimeType)) {
      return NextResponse.json(
        { error: "Capture uploads must be JPG, PNG, or WebP images" },
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

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!uploadBytesMatchMimeType(mimeType, buffer)) {
        return NextResponse.json(
          { error: "File contents do not match the declared file type" },
          { status: 400 },
        );
      }

      const checksumSha256 = checksumSha256Hex(buffer);
      const source = `capture:${session.id}`;
      const reservation = await withTenant(
        db,
        session.practiceId,
        async (tx) => {
          // Serialize uploads for one capture link. This makes the hard session
          // cap safe even when several phones submit at the same time.
          const [lockedSession] = await tx
            .select({ id: captureSessions.id })
            .from(captureSessions)
            .where(
              and(
                eq(captureSessions.id, session.id),
                eq(captureSessions.practiceId, session.practiceId),
                eq(captureSessions.patientId, session.patientId),
                eq(captureSessions.createdBy, session.createdBy!),
                isNull(captureSessions.deletedAt),
                gt(captureSessions.expiresAt, new Date()),
              ),
            )
            .limit(1)
            .for("update");
          if (!lockedSession) return null;

          const [activePatient] = await tx
            .select({ id: patients.id })
            .from(patients)
            .where(
              and(
                eq(patients.id, session.patientId),
                eq(patients.practiceId, session.practiceId),
                eq(patients.status, "active"),
                isNull(patients.deletedAt),
              ),
            )
            .limit(1);
          if (!activePatient) return null;

          const [activeCreator] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.id, session.createdBy!),
                eq(users.practiceId, session.practiceId),
                isNull(users.deletedAt),
              ),
            )
            .limit(1);
          if (!activeCreator) return null;

          if (session.appointmentId) {
            const [linkedAppointment] = await tx
              .select({ id: appointments.id })
              .from(appointments)
              .where(
                and(
                  eq(appointments.id, session.appointmentId),
                  eq(appointments.practiceId, session.practiceId),
                  eq(appointments.patientId, session.patientId),
                  isNull(appointments.deletedAt),
                ),
              )
              .limit(1);
            if (!linkedAppointment) return null;
          }

          const [usage] = await tx
            .select({
              count: sql<number>`count(*)::int`,
              replayCount: sql<number>`count(*) filter (where ${files.idempotencyKey} = ${idempotencyKey}::uuid)::int`,
            })
            .from(files)
            .where(
              and(
                eq(files.practiceId, session.practiceId),
                eq(files.source, source),
                isNull(files.deletedAt),
              ),
            );
          if (
            (usage?.count ?? 0) >= CAPTURE_SESSION_FILE_LIMIT &&
            (usage?.replayCount ?? 0) === 0
          ) {
            throw new CaptureSessionLimitError();
          }

          return reserveManagedUpload(tx, {
            practiceId: session.practiceId,
            uploadedBy: session.createdBy!,
            idempotencyKey,
            fileName: file.name,
            mimeType,
            fileSizeBytes: buffer.length,
            checksumSha256,
            category: CAPTURE_FILE_CATEGORY,
            source,
            entityType: "patient",
            entityId: session.patientId,
            patientId: session.patientId,
            appointmentId: session.appointmentId,
          });
        },
      );
      if (!reservation) return notFound();

      if (reservation.storageStatus === "available") {
        return NextResponse.json(
          { ok: true, fileId: reservation.id },
          { status: 200 },
        );
      }

      const writeResult = await putAndVerifyManagedUpload({
        reservation,
        body: buffer,
      });
      if (writeResult.status === "unavailable") {
        return NextResponse.json(
          { error: "Upload outcome is still being verified. Please retry." },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }
      if (writeResult.status === "corrupt") {
        const marked = await withTenant(db, session.practiceId, (tx) =>
          markManagedUploadCorrupt(tx, reservation),
        );
        if (!marked) {
          throw new Error("Capture reservation changed before quarantine");
        }
        return NextResponse.json(
          { error: "Uploaded object failed integrity verification" },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }

      await withTenant(db, session.practiceId, async (tx) => {
        if (
          !(await finalizeManagedUploadManifest(
            tx,
            reservation,
            writeResult.evidence,
          ))
        ) {
          throw new Error(
            "Capture reservation disappeared before finalization",
          );
        }
      });

      await queueManagedUploadReplication(reservation, writeResult.evidence);

      return NextResponse.json(
        { ok: true, fileId: reservation.id },
        { status: reservation.created ? 201 : 200 },
      );
    } catch (err) {
      if (err instanceof ManagedUploadConflictError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      if (err instanceof CaptureSessionLimitError) {
        return NextResponse.json(
          { error: "This capture link has reached its 20-photo limit" },
          { status: 409 },
        );
      }
      console.error("[capture] managed upload failed");
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  return privateNoStore(await handlePost(request, context));
}
