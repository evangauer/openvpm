import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { auditLog, consentRequests, files, patients, practices } from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  captureRateLimitKey,
  isCaptureTokenShape,
} from "@/lib/consult/tokens";
import { CONSENT_SIGNER_NAME_MAX_LENGTH } from "@/lib/consult/consent-template";
import { buildConsentPdf } from "@/lib/consult/consent-pdf";
import { deleteFile, uploadFile } from "@/lib/s3";
import { uploadBytesMatchMimeType } from "@/lib/upload-security";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { CONSENT_FILE_CATEGORY as CONSENT_CATEGORY } from "@/lib/records/file-kinds";

export const dynamic = "force-dynamic";

/**
 * No-login e-sign endpoints behind the consent QR link (see
 * server/routers/records.ts createConsentRequest).
 *
 * Security model mirrors the capture route: token shape is validated before
 * any work, lookups run under withSystem with an explicit practice-alive
 * check, and every miss is the same generic 404. Unlike photo capture, the
 * signer must read the consent text before signing, so GET returns the
 * consent content for a live token (rate-limited the same way).
 */

const TOKEN_LIMIT = 60;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;

/** JSON body cap: a canvas signature PNG is tens of KB; 1 MB is generous. */
const SIGN_REQUEST_MAX_BYTES = 1_000_000;
/** Decoded signature image cap. */
const SIGNATURE_PNG_MAX_BYTES = 500_000;
const SIGNATURE_DATA_URL_PREFIX = "data:image/png;base64,";
const CONSENT_FILE_CATEGORY = CONSENT_CATEGORY;

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function enforceRateLimits(
  request: NextRequest,
  token: string,
  scope: string
): Promise<NextResponse | null> {
  const ipResult = await rateLimit({
    key: `${scope}:ip:${clientIpFromRequest(request)}`,
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
    key: captureRateLimitKey(scope, token),
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
  return null;
}

type ConsentLookup = {
  id: string;
  practiceId: string;
  patientId: string;
  createdBy: string | null;
  appointmentId: string | null;
  title: string;
  bodyText: string;
  status: string;
  signerName: string | null;
  expiresAt: Date;
  patientName: string;
  practiceName: string;
  tier: string | null;
  billingStatus: string | null;
  trialEndsAt: Date | null;
};

async function lookupConsent(token: string): Promise<ConsentLookup | null> {
  const now = new Date();
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({
        id: consentRequests.id,
        practiceId: consentRequests.practiceId,
        patientId: consentRequests.patientId,
        createdBy: consentRequests.createdBy,
        appointmentId: consentRequests.appointmentId,
        title: consentRequests.title,
        bodyText: consentRequests.bodyText,
        status: consentRequests.status,
        signerName: consentRequests.signerName,
        expiresAt: consentRequests.expiresAt,
        patientName: patients.name,
        practiceName: practices.name,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
      })
      .from(consentRequests)
      .innerJoin(
        practices,
        and(
          eq(practices.id, consentRequests.practiceId),
          isNull(practices.deletedAt)
        )
      )
      .innerJoin(patients, eq(patients.id, consentRequests.patientId))
      .where(
        and(
          eq(consentRequests.token, token),
          isNull(consentRequests.deletedAt),
          gt(consentRequests.expiresAt, now)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

function billingBlocked(session: ConsentLookup): boolean {
  return (
    billingEnforced() &&
    !hasHostedFullAccess(session.tier, session.billingStatus, session.trialEndsAt)
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  const limited = await enforceRateLimits(request, token, "consent-view");
  if (limited) return limited;

  const session = await lookupConsent(token);
  if (!session || !session.createdBy || billingBlocked(session)) {
    return notFound();
  }

  return NextResponse.json({
    title: session.title,
    bodyText: session.bodyText,
    patientName: session.patientName,
    practiceName: session.practiceName,
    status: session.status,
    signerName: session.status === "signed" ? session.signerName : null,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  const limited = await enforceRateLimits(request, token, "consent-sign");
  if (limited) return limited;

  const body = await readRequestBytesWithLimit(request, SIGN_REQUEST_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { error: "Request exceeds maximum size" },
      { status: 413 }
    );
  }

  let payload: { signerName?: unknown; signaturePngDataUrl?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body.bytes).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const signerName =
    typeof payload.signerName === "string" ? payload.signerName.trim() : "";
  if (
    signerName.length === 0 ||
    signerName.length > CONSENT_SIGNER_NAME_MAX_LENGTH
  ) {
    return NextResponse.json(
      { error: "Please type your full name" },
      { status: 400 }
    );
  }

  const dataUrl =
    typeof payload.signaturePngDataUrl === "string"
      ? payload.signaturePngDataUrl
      : "";
  if (!dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) {
    return NextResponse.json(
      { error: "Please draw your signature" },
      { status: 400 }
    );
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(
      dataUrl.slice(SIGNATURE_DATA_URL_PREFIX.length),
      "base64"
    );
  } catch {
    return NextResponse.json(
      { error: "Please draw your signature" },
      { status: 400 }
    );
  }
  if (
    signatureBytes.length === 0 ||
    signatureBytes.length > SIGNATURE_PNG_MAX_BYTES ||
    !uploadBytesMatchMimeType("image/png", signatureBytes)
  ) {
    return NextResponse.json(
      { error: "Please draw your signature" },
      { status: 400 }
    );
  }

  const session = await lookupConsent(token);
  // Unknown, expired, and orphaned requests all get the same generic miss.
  if (!session || !session.createdBy || billingBlocked(session)) {
    return notFound();
  }
  // A consent link is single-use.
  if (session.status !== "pending") {
    return notFound();
  }

  const signedAt = new Date();
  const pdf = buildConsentPdf({
    practiceName: session.practiceName,
    patientName: session.patientName,
    title: session.title,
    bodyText: session.bodyText,
    signerName,
    signedAtIso: signedAt.toISOString(),
    signaturePngDataUrl: dataUrl,
  });

  const uuid = randomUUID();
  const fileName = `signed-consent-${uuid.slice(0, 8)}.pdf`;
  const key = `${session.practiceId}/${CONSENT_FILE_CATEGORY}/${uuid}-${fileName}`;
  let uploadedKey: string | null = null;

  try {
    await uploadFile(key, pdf, "application/pdf");
    uploadedKey = key;
    const url = `/api/files/${key}`;

    const result = await withTenant(db, session.practiceId, async (tx) => {
      // Claim the pending row first: the guard makes concurrent submissions
      // for the same token single-winner.
      const [claimed] = await tx
        .update(consentRequests)
        .set({ status: "signed", signerName, signedAt })
        .where(
          and(
            eq(consentRequests.id, session.id),
            eq(consentRequests.status, "pending"),
            isNull(consentRequests.deletedAt)
          )
        )
        .returning({ id: consentRequests.id });
      if (!claimed) return null;

      const [inserted] = await tx
        .insert(files)
        .values({
          practiceId: session.practiceId,
          uploadedBy: session.createdBy!,
          fileName,
          fileKey: key,
          fileUrl: url,
          mimeType: "application/pdf",
          fileSizeBytes: pdf.length,
          category: CONSENT_FILE_CATEGORY,
          entityType: "patient",
          entityId: session.patientId,
          appointmentId: session.appointmentId,
        })
        .returning({ id: files.id });

      await tx
        .update(consentRequests)
        .set({ fileId: inserted!.id })
        .where(eq(consentRequests.id, session.id));

      await tx.insert(auditLog).values({
        practiceId: session.practiceId,
        userId: session.createdBy!,
        action: "sign",
        entityType: "consent",
        entityId: session.id,
        changes: {
          signerName,
          patientId: session.patientId,
          fileId: inserted!.id,
        },
      });

      return { fileId: inserted!.id };
    });

    if (!result) {
      // Another submission won the race after our lookup; drop our upload.
      try {
        await deleteFile(uploadedKey);
      } catch (cleanupErr) {
        console.error("Failed to clean up uploaded object:", cleanupErr);
      }
      return notFound();
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("Consent signing failed:", err);
    if (uploadedKey) {
      try {
        await deleteFile(uploadedKey);
      } catch (cleanupErr) {
        console.error("Failed to clean up uploaded object:", cleanupErr);
      }
    }
    return NextResponse.json({ error: "Signing failed" }, { status: 500 });
  }
}
