import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@openpims/db/client";
import { patients, practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  isAllowedUploadMimeType,
  uploadBytesMatchMimeType,
} from "@/lib/upload-security";
import {
  UPLOAD_REQUEST_MAX_BYTES,
  UPLOAD_FILE_MAX_BYTES,
  uploadRequestContentLengthTooLarge,
} from "@/lib/upload-limits";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { checksumSha256Hex } from "@/lib/file-replication";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import {
  finalizeManagedUploadManifest,
  ManagedUploadConflictError,
  markManagedUploadCorrupt,
  putAndVerifyManagedUpload,
  queueManagedUploadReplication,
  reserveManagedUpload,
  type DashboardUploadCategory,
} from "@/lib/managed-file-upload";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";

const MAX_FILE_NAME_LENGTH = 255;
const DASHBOARD_UPLOAD_CATEGORIES = ["branding", "patient-photos"] as const;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_UPLOAD_LIMIT = 30;
const USER_UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const PRACTICE_UPLOAD_LIMIT = 300;
const PRACTICE_UPLOAD_WINDOW_MS = 60 * 60 * 1000;

function rateLimitedResponse(
  limit: number,
  result: { remaining: number; resetAt: Date },
) {
  return NextResponse.json(
    { error: "Too many uploads. Please wait and try again." },
    { status: 429, headers: rateLimitResponseHeaders(limit, result) },
  );
}

async function enforceUploadRateLimits(userId: string, practiceId: string) {
  try {
    const userLimit = await rateLimit({
      key: `dashboard-upload:user:${userId}`,
      limit: USER_UPLOAD_LIMIT,
      windowMs: USER_UPLOAD_WINDOW_MS,
    });
    if (!userLimit.success) {
      return rateLimitedResponse(USER_UPLOAD_LIMIT, userLimit);
    }
    const practiceLimit = await rateLimit({
      key: `dashboard-upload:practice:${practiceId}`,
      limit: PRACTICE_UPLOAD_LIMIT,
      windowMs: PRACTICE_UPLOAD_WINDOW_MS,
    });
    if (!practiceLimit.success) {
      return rateLimitedResponse(PRACTICE_UPLOAD_LIMIT, practiceLimit);
    }
    return null;
  } catch {
    return rateLimitedResponse(USER_UPLOAD_LIMIT, {
      remaining: 0,
      resetAt: new Date(Date.now() + USER_UPLOAD_WINDOW_MS),
    });
  }
}

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
        role: users.role,
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
  if (activeAccount.role === "viewer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const uploadRateLimit = await enforceUploadRateLimits(
    activeAccount.userId,
    session.user.practiceId,
  );
  if (uploadRateLimit) return uploadRateLimit;

  if (billingEnforced()) {
    if (
      !hasHostedFullAccess(
        activeAccount.tier,
        activeAccount.billingStatus,
        activeAccount.trialEndsAt,
      )
    ) {
      return NextResponse.json(
        {
          error:
            "OpenVPM Cloud is read-only until your trial or subscription is active.",
        },
        { status: 403 },
      );
    }
  }

  const practiceId = session.user.practiceId;
  const postCommit = {
    replicationToQueue: null as null | (() => Promise<boolean>),
  };
  try {
    const response = await withTenant(db, practiceId, async (leaseTx) => {
      // Acquire the recovery lease before reading the multipart body and keep
      // the transaction open through primary storage PUT and manifest/link
      // finalization. The short reservation transaction commits independently
      // before PUT; finalization and entity linking use this lease-owning
      // transaction. The shared lock drains in-flight work before restore.
      if (!(await lockPracticeForExternalSideEffects(leaseTx, practiceId))) {
        return NextResponse.json(
          { error: RECOVERY_HOLD_BLOCK_MESSAGE },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }

      // ---------- Parse multipart form data ----------
      let formData: FormData;
      try {
        const body = await readRequestBytesWithLimit(
          req,
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
      const patientIdValue = formData.get("patientId");
      const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";

      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return NextResponse.json(
          { error: "A canonical UUID Idempotency-Key header is required" },
          { status: 400 },
        );
      }

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
        !DASHBOARD_UPLOAD_CATEGORIES.includes(
          category as (typeof DASHBOARD_UPLOAD_CATEGORIES)[number],
        )
      ) {
        return NextResponse.json(
          {
            error: `Invalid category. Allowed: ${DASHBOARD_UPLOAD_CATEGORIES.join(", ")}`,
          },
          { status: 400 },
        );
      }
      const dashboardCategory = category as DashboardUploadCategory;
      if (dashboardCategory === "branding" && activeAccount.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const patientId =
        dashboardCategory === "patient-photos" &&
        typeof patientIdValue === "string" &&
        IDEMPOTENCY_KEY_PATTERN.test(patientIdValue)
          ? patientIdValue
          : null;
      if (dashboardCategory === "patient-photos" && !patientId) {
        return NextResponse.json(
          { error: "A canonical patientId is required for patient photos" },
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
      if (!mimeType.startsWith("image/")) {
        return NextResponse.json(
          { error: "Dashboard uploads must be image files" },
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

      const buffer = Buffer.from(await file.arrayBuffer());
      if (!uploadBytesMatchMimeType(mimeType, buffer)) {
        return NextResponse.json(
          { error: "File contents do not match the declared file type" },
          { status: 400 },
        );
      }

      const checksumSha256 = checksumSha256Hex(buffer);
      const reservation = await withTenant(db, practiceId, async (tx) => {
        if (dashboardCategory === "patient-photos") {
          const [activePatient] = await tx
            .select({ id: patients.id })
            .from(patients)
            .where(
              and(
                eq(patients.id, patientId!),
                eq(patients.practiceId, practiceId),
                isNull(patients.deletedAt),
              ),
            )
            .limit(1);
          if (!activePatient) return null;
        }

        return reserveManagedUpload(tx, {
          practiceId,
          uploadedBy: session.user.id,
          idempotencyKey,
          fileName: file.name,
          mimeType,
          fileSizeBytes: buffer.length,
          checksumSha256,
          category: dashboardCategory,
          source:
            dashboardCategory === "branding"
              ? "practice_logo"
              : "profile_photo",
          entityType: dashboardCategory === "branding" ? "practice" : "patient",
          entityId: dashboardCategory === "branding" ? practiceId : patientId!,
          patientId: dashboardCategory === "patient-photos" ? patientId : null,
        });
      });
      if (!reservation) {
        return NextResponse.json(
          { error: "Patient not found" },
          { status: 404 },
        );
      }

      if (reservation.storageStatus === "available") {
        return NextResponse.json(
          { url: reservation.fileUrl, key: reservation.fileKey },
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
        const marked = await withTenant(db, practiceId, (tx) =>
          markManagedUploadCorrupt(tx, reservation),
        );
        if (!marked) {
          throw new Error("Upload reservation changed before quarantine");
        }
        return NextResponse.json(
          { error: "Uploaded object failed integrity verification" },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }

      if (
        !(await finalizeManagedUploadManifest(
          leaseTx,
          reservation,
          writeResult.evidence,
        ))
      ) {
        throw new Error("Upload reservation disappeared before finalization");
      }

      if (dashboardCategory === "branding") {
        const [linked] = await leaseTx
          .update(practices)
          .set({ logoUrl: reservation.fileUrl, updatedAt: new Date() })
          .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
          .returning({ id: practices.id });
        if (!linked) throw new Error("Practice disappeared during upload");
      } else {
        const [linked] = await leaseTx
          .update(patients)
          .set({ photoUrl: reservation.fileUrl, updatedAt: new Date() })
          .where(
            and(
              eq(patients.id, patientId!),
              eq(patients.practiceId, practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .returning({ id: patients.id });
        if (!linked) throw new Error("Patient disappeared during upload");
      }

      postCommit.replicationToQueue = () =>
        queueManagedUploadReplication(reservation, writeResult.evidence);

      return NextResponse.json(
        { url: reservation.fileUrl, key: reservation.fileKey },
        { status: reservation.created ? 201 : 200 },
      );
    });
    await postCommit.replicationToQueue?.();
    return response;
  } catch (error) {
    if (error instanceof ManagedUploadConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[upload] managed upload failed");
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
