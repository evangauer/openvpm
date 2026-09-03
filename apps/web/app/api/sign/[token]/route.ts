import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLog,
  consentReceiptCapabilities,
  consentRequests,
  files,
  patients,
  practices,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  captureRateLimitKey,
  generateConsentReceiptToken,
  hashConsentToken,
  hashConsentReceiptToken,
  isCaptureTokenShape,
} from "@/lib/consult/tokens";
import {
  CONSENT_ELECTRONIC_SIGNATURE_INTENT,
  CONSENT_SIGNER_ATTESTATION_VERSION,
  CONSENT_SIGNER_AUTHORITY_ATTESTATION,
  CONSENT_SIGNER_NAME_MAX_LENGTH,
} from "@/lib/consult/consent-template";
import {
  buildConsentPdfForVersion,
  CONSENT_PDF_RENDERER_V1,
  CONSENT_PDF_RENDERER_V2,
  consentSignaturePngDecodes,
  type ConsentPdfRendererVersion,
} from "@/lib/consult/consent-pdf";
import { uploadBytesMatchMimeType } from "@/lib/upload-security";
import { readRequestBytesWithLimit } from "@/lib/request-body";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { CONSENT_FILE_CATEGORY as CONSENT_CATEGORY } from "@/lib/records/file-kinds";
import { checksumSha256Hex } from "@/lib/file-replication";
import {
  finalizeManagedUploadManifest,
  ManagedUploadConflictError,
  markManagedUploadCorrupt,
  putAndVerifyManagedUpload,
  queueManagedUploadReplication,
  reserveManagedUpload,
  type ManagedUploadReservation,
} from "@/lib/managed-file-upload";
import { finalizeTreatmentPlanResponseForConsent } from "@/lib/treatment-plan-presentations/finalize";
import { treatmentPlanClientDecisionsEnabled } from "@/lib/treatment-plan-presentations/policy";
import { sanitizedExceptionTelemetry } from "@/lib/sanitized-exception-telemetry";
import { rowsFromExecute } from "@/lib/db/execute-rows";

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
const SIGNATURE_PNG_MAX_DIMENSION = 2_048;
const SIGNATURE_PNG_MAX_PIXELS = 2_000_000;
const SIGNATURE_DATA_URL_PREFIX = "data:image/png;base64,";
const CONSENT_FILE_CATEGORY = CONSENT_CATEGORY;
/** Public recovery is deliberately short. After this window an operator must
 * reconcile the pending manifest; an expired bearer can never retry forever. */
const CONSENT_SIGNING_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
/** Object storage performs at most three 15-second bounded operations. This
 * fence is longer than that full path and prevents recovery from starting
 * while the database connection is released for provider I/O. */
const CONSENT_STORAGE_LEASE_MS = 2 * 60 * 1000;

function signaturePngDimensionsAllowed(bytes: Buffer): boolean {
  // A PNG must begin with a 13-byte IHDR chunk. Bounding both dimensions and
  // total pixels prevents a tiny compressed payload from making jsPDF decode
  // an attacker-controlled, memory-heavy canvas.
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return false;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return (
    width > 0 &&
    height > 0 &&
    width <= SIGNATURE_PNG_MAX_DIMENSION &&
    height <= SIGNATURE_PNG_MAX_DIMENSION &&
    width * height <= SIGNATURE_PNG_MAX_PIXELS
  );
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

async function enforceRateLimits(
  request: NextRequest,
  token: string,
  scope: string,
): Promise<NextResponse | null> {
  const ipResult = await rateLimit({
    key: `${scope}:ip:${clientIpFromRequest(request)}`,
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
      },
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
  tokenHash: string | null;
  title: string;
  bodyText: string;
  status: string;
  signerName: string | null;
  signedAt: Date | null;
  signaturePngBytes: Uint8Array | null;
  signatureSha256: string | null;
  signatureMethod: string | null;
  signerAttestationVersion: string | null;
  documentRenderVersion: string | null;
  storageLeaseToken: string | null;
  storageLeaseExpiresAt: Date | null;
  fileId: string | null;
  expiresAt: Date;
  patientName: string;
  practiceName: string;
  tier: string | null;
  billingStatus: string | null;
  trialEndsAt: Date | null;
};

async function lookupConsent(
  database: Database,
  token: string,
): Promise<ConsentLookup | null> {
  const now = new Date();
  const [row] = await database
    .select({
      id: consentRequests.id,
      practiceId: consentRequests.practiceId,
      patientId: consentRequests.patientId,
      createdBy: consentRequests.createdBy,
      appointmentId: consentRequests.appointmentId,
      tokenHash: consentRequests.tokenHash,
      title: consentRequests.title,
      bodyText: consentRequests.bodyText,
      status: consentRequests.status,
      signerName: consentRequests.signerName,
      signedAt: consentRequests.signedAt,
      signaturePngBytes: consentRequests.signaturePngBytes,
      signatureSha256: consentRequests.signatureSha256,
      signatureMethod: consentRequests.signatureMethod,
      signerAttestationVersion: consentRequests.signerAttestationVersion,
      documentRenderVersion: consentRequests.documentRenderVersion,
      storageLeaseToken: consentRequests.storageLeaseToken,
      storageLeaseExpiresAt: consentRequests.storageLeaseExpiresAt,
      fileId: consentRequests.fileId,
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
        eq(practices.recoveryHold, false),
        isNull(practices.deletedAt),
      ),
    )
    .innerJoin(
      patients,
      and(
        eq(patients.id, consentRequests.patientId),
        eq(patients.practiceId, consentRequests.practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .where(
      and(
        or(
          eq(consentRequests.tokenHash, hashConsentToken(token)),
          eq(consentRequests.token, token),
        ),
        isNull(consentRequests.deletedAt),
        or(
          gt(consentRequests.expiresAt, now),
          and(
            eq(consentRequests.status, "signing"),
            gt(
              consentRequests.signedAt,
              new Date(now.getTime() - CONSENT_SIGNING_RECOVERY_WINDOW_MS),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

function billingBlocked(session: ConsentLookup): boolean {
  return (
    billingEnforced() &&
    !hasHostedFullAccess(
      session.tier,
      session.billingStatus,
      session.trialEndsAt,
    )
  );
}

class ConsentFileBindingConflictError extends Error {}
class ConsentSignatureConflictError extends Error {}
class ConsentRecoveryHoldError extends Error {}
class ConsentStorageBusyError extends Error {}

type SigningSession = ConsentLookup & {
  status: "signing";
  signerName: string;
  signedAt: Date;
  signaturePngBytes: Buffer;
  signatureSha256: string;
  signatureMethod: "drawn" | "typed";
  signerAttestationVersion: string;
  documentRenderVersion: ConsentPdfRendererVersion;
};

function persistedRendererVersion(
  session: ConsentLookup,
): ConsentPdfRendererVersion | null {
  return session.documentRenderVersion === CONSENT_PDF_RENDERER_V1 ||
    session.documentRenderVersion === CONSENT_PDF_RENDERER_V2
    ? session.documentRenderVersion
    : null;
}

/**
 * Persist the renderer used by an in-flight row created before renderer
 * versioning. A durable reservation is authoritative: render both historical
 * byte formats and require exactly one checksum+size match. Attestation is a
 * safe discriminator only when no file reservation exists yet.
 */
async function recordDocumentRenderVersion(
  session: ConsentLookup,
): Promise<ConsentLookup | null> {
  if (persistedRendererVersion(session)) return session;
  if (
    session.status !== "signing" ||
    !signingRecoveryIsLive(session) ||
    !session.signerName ||
    !session.signedAt ||
    !session.signaturePngBytes ||
    !session.signatureSha256
  ) {
    return null;
  }

  const originalFileId = session.fileId;
  // A durable reservation predates the immutable renderer label and cannot be
  // classified safely from caller-supplied checksum mappings. Keep it frozen
  // for explicit owner recovery instead of letting the public bearer choose
  // which historical renderer label to persist.
  if (originalFileId) {
    return null;
  }

  return withTenant(db, session.practiceId, async (tx) => {
    if (!(await lockPracticeForExternalSideEffects(tx, session.practiceId))) {
      return null;
    }
    const resolved = await tx.execute(sql`
      select public.resolve_unreserved_consent_document_render_version(
        ${session.practiceId}::uuid,
        ${session.id}::uuid
      ) as document_render_version
    `);
    const selectedVersion = rowsFromExecute<{
      document_render_version: ConsentPdfRendererVersion | null;
    }>(resolved)[0]?.document_render_version;
    return selectedVersion === CONSENT_PDF_RENDERER_V1 ||
      selectedVersion === CONSENT_PDF_RENDERER_V2
      ? { ...session, documentRenderVersion: selectedVersion }
      : null;
  });
}

function signingRecoveryIsLive(session: ConsentLookup): boolean {
  return (
    session.status === "signing" &&
    session.signedAt !== null &&
    session.signedAt.getTime() + CONSENT_SIGNING_RECOVERY_WINDOW_MS > Date.now()
  );
}

function signingFromPersistedEvidence(
  session: ConsentLookup,
): SigningSession | null {
  if (
    session.status !== "signing" ||
    !signingRecoveryIsLive(session) ||
    !session.signerName ||
    !session.signedAt ||
    !session.signaturePngBytes ||
    !session.signatureSha256 ||
    session.signerAttestationVersion !== CONSENT_SIGNER_ATTESTATION_VERSION ||
    !persistedRendererVersion(session)
  ) {
    return null;
  }
  return {
    ...session,
    status: "signing",
    signerName: session.signerName,
    signedAt: session.signedAt,
    signaturePngBytes: Buffer.from(session.signaturePngBytes),
    signatureSha256: session.signatureSha256,
    signatureMethod: session.signatureMethod === "typed" ? "typed" : "drawn",
    signerAttestationVersion: session.signerAttestationVersion,
    documentRenderVersion: persistedRendererVersion(session)!,
  };
}

function signatureEvidenceMatches(
  persistedBytes: Uint8Array,
  persistedSha256: string,
  submittedBytes: Buffer,
  submittedSha256: string,
): boolean {
  if (
    persistedSha256 !== submittedSha256 ||
    persistedBytes.byteLength !== submittedBytes.byteLength
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(persistedBytes), submittedBytes);
}

/**
 * Claim is deliberately its own transaction and happens before PDF render or
 * provider I/O. A failed render/upload leaves durable signing metadata that a
 * later POST with the same capability can resume.
 */
async function claimSigning(
  session: ConsentLookup,
  signerName: string,
  signaturePngBytes: Buffer,
  signatureSha256: string,
  signatureMethod: "drawn" | "typed",
): Promise<SigningSession | null> {
  if (session.status === "pending") {
    const claimed = await withTenant(db, session.practiceId, async (tx) => {
      if (!(await lockPracticeForExternalSideEffects(tx, session.practiceId))) {
        return null;
      }
      const [row] = await tx
        .update(consentRequests)
        .set({
          status: "signing",
          signerName,
          signedAt: sql`clock_timestamp()`,
          signaturePngBytes,
          signatureSha256,
          signatureMethod,
          signerAttestationVersion: CONSENT_SIGNER_ATTESTATION_VERSION,
          documentRenderVersion: CONSENT_PDF_RENDERER_V2,
        })
        .where(
          and(
            eq(consentRequests.id, session.id),
            eq(consentRequests.practiceId, session.practiceId),
            eq(consentRequests.status, "pending"),
            // Database time makes expiry part of the same atomic claim as the
            // pending->signing transition; request/body timing cannot extend
            // the capability lifetime.
            gt(consentRequests.expiresAt, sql`clock_timestamp()`),
            isNull(consentRequests.deletedAt),
          ),
        )
        .returning({
          signerName: consentRequests.signerName,
          signedAt: consentRequests.signedAt,
          signaturePngBytes: consentRequests.signaturePngBytes,
          signatureSha256: consentRequests.signatureSha256,
          signatureMethod: consentRequests.signatureMethod,
          signerAttestationVersion: consentRequests.signerAttestationVersion,
          documentRenderVersion: consentRequests.documentRenderVersion,
        });
      return row ?? null;
    });
    if (
      !claimed?.signerName ||
      !claimed.signedAt ||
      !claimed.signaturePngBytes ||
      !claimed.signatureSha256 ||
      (claimed.signatureMethod !== "drawn" &&
        claimed.signatureMethod !== "typed") ||
      claimed.signerAttestationVersion !== CONSENT_SIGNER_ATTESTATION_VERSION ||
      claimed.documentRenderVersion !== CONSENT_PDF_RENDERER_V2
    ) {
      return null;
    }
    return {
      ...session,
      status: "signing",
      signerName: claimed.signerName,
      signedAt: claimed.signedAt,
      signaturePngBytes: Buffer.from(claimed.signaturePngBytes),
      signatureSha256: claimed.signatureSha256,
      signatureMethod: claimed.signatureMethod,
      signerAttestationVersion: claimed.signerAttestationVersion,
      documentRenderVersion: claimed.documentRenderVersion,
    };
  }

  if (session.status === "signing" && session.signerName === signerName) {
    const signing = signingFromPersistedEvidence(session);
    if (!signing) return null;
    if (
      signing.signatureMethod !== signatureMethod ||
      !signatureEvidenceMatches(
        signing.signaturePngBytes,
        signing.signatureSha256,
        signaturePngBytes,
        signatureSha256,
      )
    ) {
      throw new ConsentSignatureConflictError();
    }
    return signing;
  }
  return null;
}

async function recordSignerAttestation(
  session: ConsentLookup,
): Promise<ConsentLookup | null> {
  if (session.signerAttestationVersion === CONSENT_SIGNER_ATTESTATION_VERSION) {
    return session;
  }
  if (session.status !== "signing" || session.expiresAt <= new Date()) {
    return null;
  }
  return withTenant(db, session.practiceId, async (tx) => {
    if (!(await lockPracticeForExternalSideEffects(tx, session.practiceId))) {
      return null;
    }
    const [recorded] = await tx
      .update(consentRequests)
      .set({
        signerAttestationVersion: CONSENT_SIGNER_ATTESTATION_VERSION,
      })
      .where(
        and(
          eq(consentRequests.id, session.id),
          eq(consentRequests.practiceId, session.practiceId),
          eq(consentRequests.status, "signing"),
          isNull(consentRequests.signerAttestationVersion),
          gt(consentRequests.expiresAt, sql`clock_timestamp()`),
          isNull(consentRequests.deletedAt),
        ),
      )
      .returning({
        signerAttestationVersion: consentRequests.signerAttestationVersion,
      });
    return recorded?.signerAttestationVersion ===
      CONSENT_SIGNER_ATTESTATION_VERSION
      ? {
          ...session,
          signerAttestationVersion: recorded.signerAttestationVersion,
        }
      : null;
  });
}

/** Reserve and bind the file manifest atomically, before any provider PUT. */
async function reserveConsentFile(
  session: SigningSession,
  pdf: Buffer,
): Promise<ManagedUploadReservation> {
  return withTenant(db, session.practiceId, async (tx) => {
    if (!(await lockPracticeForExternalSideEffects(tx, session.practiceId))) {
      throw new ConsentRecoveryHoldError();
    }
    const reservation = await reserveManagedUpload(tx, {
      practiceId: session.practiceId,
      uploadedBy: session.createdBy!,
      idempotencyKey: session.id,
      fileName: `signed-consent-${session.id.slice(0, 8)}.pdf`,
      mimeType: "application/pdf",
      fileSizeBytes: pdf.length,
      checksumSha256: checksumSha256Hex(pdf),
      category: CONSENT_FILE_CATEGORY,
      source: "consent_signature",
      entityType: "patient",
      entityId: session.patientId,
      patientId: session.patientId,
      appointmentId: session.appointmentId,
    });

    const [bound] = await tx
      .update(consentRequests)
      .set({ fileId: reservation.id })
      .where(
        and(
          eq(consentRequests.id, session.id),
          eq(consentRequests.practiceId, session.practiceId),
          eq(consentRequests.status, "signing"),
          isNull(consentRequests.deletedAt),
          or(
            isNull(consentRequests.fileId),
            eq(consentRequests.fileId, reservation.id),
          ),
        ),
      )
      .returning({ id: consentRequests.id });
    if (!bound) throw new ConsentFileBindingConflictError();
    return reservation;
  });
}

/**
 * Acquire a durable, bounded provider-I/O fence in a short transaction. The
 * recovery path takes an exclusive practice lock before checking this marker,
 * while this path takes a shared lock before creating it. That ordering closes
 * the check/start race without retaining a database connection during storage
 * calls. A crashed worker can be superseded only after every bounded object
 * storage operation for this attempt has timed out.
 */
async function beginConsentStorageLease(
  session: SigningSession,
  reservation: ManagedUploadReservation,
): Promise<string | null> {
  return withTenant(db, session.practiceId, async (tx) => {
    if (!(await lockPracticeForExternalSideEffects(tx, session.practiceId))) {
      return null;
    }
    const [leased] = await tx
      .update(consentRequests)
      .set({
        storageLeaseToken: sql`gen_random_uuid()`,
        storageLeaseExpiresAt: sql`clock_timestamp() + (${CONSENT_STORAGE_LEASE_MS} * interval '1 millisecond')`,
      })
      .where(
        and(
          eq(consentRequests.id, session.id),
          eq(consentRequests.practiceId, session.practiceId),
          eq(consentRequests.status, "signing"),
          eq(consentRequests.fileId, reservation.id),
          or(
            isNull(consentRequests.storageLeaseToken),
            lte(consentRequests.storageLeaseExpiresAt, sql`clock_timestamp()`),
          ),
          gt(
            consentRequests.signedAt,
            sql`clock_timestamp() - (${CONSENT_SIGNING_RECOVERY_WINDOW_MS} * interval '1 millisecond')`,
          ),
          isNull(consentRequests.deletedAt),
        ),
      )
      .returning({ token: consentRequests.storageLeaseToken });
    return leased?.token ?? null;
  });
}

async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  const limited = await enforceRateLimits(request, token, "consent-view");
  if (limited) return limited;

  return withSystem(db, async (systemTx) => {
    const session = await lookupConsent(systemTx, token);
    if (!session || !session.createdBy || billingBlocked(session)) {
      return notFound();
    }
    if (session.tokenHash !== null && !treatmentPlanClientDecisionsEnabled()) {
      return notFound();
    }
    // Keep the shared practice-row lease until the response is constructed,
    // so recovery cannot commit a hold between capability resolution and
    // returning pending consent content.
    if (
      !(await lockPracticeForExternalSideEffects(systemTx, session.practiceId))
    ) {
      return notFound();
    }
    if (
      session.expiresAt <= new Date() &&
      !signingFromPersistedEvidence(session)
    ) {
      return notFound();
    }

    if (session.status === "signed") {
      return NextResponse.json({ status: "signed" });
    }
    if (session.status === "signing") {
      return NextResponse.json({ status: "signing" });
    }
    if (session.status !== "pending") return notFound();

    return NextResponse.json({
      title: session.title,
      bodyText: session.bodyText,
      patientName: session.patientName,
      practiceName: session.practiceName,
      status: "pending",
    });
  });
}

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  const limited = await enforceRateLimits(request, token, "consent-sign");
  if (limited) return limited;

  const session = await withSystem(db, async (systemTx) => {
    const found = await lookupConsent(systemTx, token);
    // Unknown, expired, orphaned, deleted-practice, and recovery-held requests
    // all get the same generic miss before request-body or provider work.
    if (!found || !found.createdBy || billingBlocked(found)) {
      return null;
    }
    if (found.tokenHash !== null && !treatmentPlanClientDecisionsEnabled()) {
      return null;
    }
    // This first lease makes capability resolution fail closed. Every later
    // tenant transaction re-acquires the same lease, so no transaction ever
    // needs a nested pool connection when DATABASE_POOL_MAX=1.
    if (
      !(await lockPracticeForExternalSideEffects(systemTx, found.practiceId))
    ) {
      return null;
    }
    if (found.expiresAt <= new Date() && !signingFromPersistedEvidence(found)) {
      return null;
    }
    return found;
  });
  if (!session) return notFound();
  // Signed is a terminal state. A live capability may acknowledge a lost
  // response, but it must never render, reserve, read, write, or reverify the
  // signed artifact. Expired signed rows were excluded by lookupConsent.
  if (session.status === "signed") {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const body = await readRequestBytesWithLimit(request, SIGN_REQUEST_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { error: "Request exceeds maximum size" },
      { status: 413 },
    );
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(Buffer.from(body.bytes).toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    parsedPayload === null ||
    typeof parsedPayload !== "object" ||
    Array.isArray(parsedPayload)
  ) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = parsedPayload as {
    signerName?: unknown;
    signaturePngDataUrl?: unknown;
    signerAuthorityAccepted?: unknown;
    signatureMethod?: unknown;
    resume?: unknown;
  };

  const resume = payload.resume === true;
  // Expiry terminates every new or replacement signing attempt. Only an
  // explicit server-side replay of exact evidence durably claimed while the
  // capability was live may finish afterward.
  if (!resume && session.expiresAt <= new Date()) return notFound();
  if (resume && session.status === "pending") return notFound();
  if (
    session.signerAttestationVersion !== CONSENT_SIGNER_ATTESTATION_VERSION &&
    payload.signerAuthorityAccepted !== true
  ) {
    return NextResponse.json(
      { error: "Please confirm you are authorized to sign" },
      { status: 400 },
    );
  }
  let signerName = "";
  let signatureBytes: Buffer | null = null;
  let signatureMethod: "drawn" | "typed" = "drawn";
  if (!resume) {
    signerName =
      typeof payload.signerName === "string" ? payload.signerName.trim() : "";
    if (
      signerName.length === 0 ||
      signerName.length > CONSENT_SIGNER_NAME_MAX_LENGTH
    ) {
      return NextResponse.json(
        { error: "Please type your full name" },
        { status: 400 },
      );
    }

    if (
      payload.signatureMethod !== undefined &&
      payload.signatureMethod !== "drawn" &&
      payload.signatureMethod !== "typed"
    ) {
      return NextResponse.json(
        { error: "Please provide a valid signature" },
        { status: 400 },
      );
    }
    signatureMethod = payload.signatureMethod === "typed" ? "typed" : "drawn";

    const dataUrl =
      typeof payload.signaturePngDataUrl === "string"
        ? payload.signaturePngDataUrl
        : "";
    if (!dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) {
      return NextResponse.json(
        { error: "Please provide your signature" },
        { status: 400 },
      );
    }

    try {
      signatureBytes = Buffer.from(
        dataUrl.slice(SIGNATURE_DATA_URL_PREFIX.length),
        "base64",
      );
    } catch {
      return NextResponse.json(
        { error: "Please provide your signature" },
        { status: 400 },
      );
    }
    if (
      signatureBytes.length === 0 ||
      signatureBytes.length > SIGNATURE_PNG_MAX_BYTES ||
      !uploadBytesMatchMimeType("image/png", signatureBytes) ||
      !signaturePngDimensionsAllowed(signatureBytes) ||
      !consentSignaturePngDecodes(
        `${SIGNATURE_DATA_URL_PREFIX}${signatureBytes.toString("base64")}`,
      )
    ) {
      return NextResponse.json(
        { error: "Please provide your signature" },
        { status: 400 },
      );
    }
  }

  try {
    // Renderer inference must happen before attestation upgrade: existing v1
    // reservations may otherwise become indistinguishable from parent-v2 rows.
    const rendererSession =
      session.status === "signing" && session.documentRenderVersion === null
        ? await recordDocumentRenderVersion(session)
        : session;
    if (!rendererSession) return notFound();
    const attestedSession =
      rendererSession.signerAttestationVersion ===
        CONSENT_SIGNER_ATTESTATION_VERSION ||
      rendererSession.status === "pending"
        ? rendererSession
        : await recordSignerAttestation(rendererSession);
    if (!attestedSession) return notFound();
    const signing = resume
      ? signingFromPersistedEvidence(attestedSession)
      : await claimSigning(
          attestedSession,
          signerName,
          signatureBytes!,
          checksumSha256Hex(signatureBytes!),
          signatureMethod,
        );
    // A failed pending->signing compare-and-swap is the concurrent loser. It
    // exits before rendering, reserving, or touching object storage.
    if (!signing) return notFound();

    const persistedSignatureDataUrl = `${SIGNATURE_DATA_URL_PREFIX}${signing.signaturePngBytes.toString("base64")}`;
    const pdf = buildConsentPdfForVersion(signing.documentRenderVersion, {
      documentId: signing.id,
      practiceId: signing.practiceId,
      patientId: signing.patientId,
      title: signing.title,
      bodyText: signing.bodyText,
      signerName: signing.signerName,
      signerAttestation: `${CONSENT_SIGNER_AUTHORITY_ATTESTATION} ${CONSENT_ELECTRONIC_SIGNATURE_INTENT}`,
      signedAtIso: signing.signedAt.toISOString(),
      signaturePngDataUrl: persistedSignatureDataUrl,
    });
    const reservation = await reserveConsentFile(signing, pdf);
    const storageLeaseToken = await beginConsentStorageLease(
      signing,
      reservation,
    );
    if (!storageLeaseToken) throw new ConsentStorageBusyError();

    // No transaction, RLS context, pooled connection, or practice row lock is
    // retained across provider I/O. The durable lease above is what recovery
    // checks before it may commit a hold.
    const writeResult = await putAndVerifyManagedUpload({
      reservation,
      body: pdf,
    });
    if (writeResult.status === "unavailable") {
      // The provider result is ambiguous. Keep the short lease until its
      // conservative timeout so recovery and another writer cannot overlap a
      // late provider completion.
      return NextResponse.json(
        { error: "Signing outcome is still being verified. Please retry." },
        { status: 503, headers: { "Retry-After": "120" } },
      );
    }
    if (writeResult.status === "corrupt") {
      const quarantined = await withTenant(
        db,
        signing.practiceId,
        async (tx) => {
          if (
            !(await lockPracticeForExternalSideEffects(tx, signing.practiceId))
          ) {
            return false;
          }
          // Claim this exact lease before mutating the shared manifest. An old
          // provider attempt may finish after its lease expires and a newer
          // attempt takes over; the stale worker must not quarantine the newer
          // worker's reservation.
          const releaseResult = await tx.execute(sql`
            select public.release_consent_storage_lease(
              ${signing.practiceId}::uuid,
              ${signing.id}::uuid,
              ${reservation.id}::uuid,
              ${storageLeaseToken}::uuid
            ) as released
          `);
          if (
            rowsFromExecute<{ released: boolean }>(releaseResult)[0]
              ?.released !== true
          ) {
            return false;
          }
          if (!(await markManagedUploadCorrupt(tx, reservation))) {
            throw new Error("Consent reservation changed before quarantine");
          }
          return true;
        },
      );
      if (!quarantined) return notFound();
      return NextResponse.json(
        { error: "Signed document failed integrity verification" },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }

    const receiptToken = generateConsentReceiptToken();
    const outcome = await withTenant(db, signing.practiceId, async (tx) => {
      if (!(await lockPracticeForExternalSideEffects(tx, signing.practiceId))) {
        return { status: "not_found" as const };
      }
      const finalizeResult = await tx.execute(sql`
        select public.finalize_consent_request(
          ${signing.practiceId}::uuid,
          ${signing.id}::uuid,
          ${reservation.id}::uuid,
          ${storageLeaseToken}::uuid,
          ${reservation.fileKey}::text,
          ${reservation.checksumSha256}::text,
          ${reservation.fileSizeBytes}::integer,
          ${writeResult.evidence.etag ?? null}::text,
          ${writeResult.evidence.versionId ?? null}::text
        ) as finalized
      `);
      if (
        rowsFromExecute<{ finalized: boolean }>(finalizeResult)[0]
          ?.finalized !== true
      ) {
        return { status: "not_found" as const };
      }

      if (
        !(await finalizeManagedUploadManifest(
          tx,
          reservation,
          writeResult.evidence,
        ))
      ) {
        throw new Error("Consent file disappeared before finalization");
      }

      if (signing.tokenHash !== null) {
        await finalizeTreatmentPlanResponseForConsent(tx, {
          practiceId: signing.practiceId,
          consentRequestId: signing.id,
          signedFileId: reservation.id,
          signedDocumentSha256: reservation.checksumSha256,
          signatureSha256: signing.signatureSha256,
          signerName: signing.signerName,
        });
      }

      await tx.insert(consentReceiptCapabilities).values({
        practiceId: signing.practiceId,
        consentRequestId: signing.id,
        fileId: reservation.id,
        fileChecksumSha256: reservation.checksumSha256,
        fileSizeBytes: reservation.fileSizeBytes,
        tokenHash: hashConsentReceiptToken(receiptToken),
        // baseColumns.created_at also uses transaction_timestamp()/now(), so
        // this is exactly inside the database-enforced 15-minute maximum.
        expiresAt: sql`transaction_timestamp() + interval '15 minutes'`,
      });

      await tx.insert(auditLog).values({
        practiceId: signing.practiceId,
        // The client performed this public capability action. The staff
        // dispatcher remains explicit provenance, but must not be recorded
        // as the signer merely because they minted the link.
        userId: null,
        action: "sign",
        entityType: "consent",
        entityId: signing.id,
        ipAddress: clientIpFromRequest(request),
        changes: {
          actorType: "client",
          provenance: "public_consent_capability",
          dispatchedByUserId: signing.createdBy,
          signerName: signing.signerName,
          signerAuthorityAccepted: true,
          signerAttestationVersion: CONSENT_SIGNER_ATTESTATION_VERSION,
          documentRenderVersion: signing.documentRenderVersion,
          signedAt: signing.signedAt.toISOString(),
          signatureSha256: signing.signatureSha256,
          signatureMethod: signing.signatureMethod,
          patientId: signing.patientId,
          fileId: reservation.id,
        },
      });
      return {
        status: "verified" as const,
        evidence: writeResult.evidence,
      };
    });

    if (outcome.status === "not_found") return notFound();

    await queueManagedUploadReplication(reservation, outcome.evidence);
    return NextResponse.json({ ok: true, receiptToken }, { status: 201 });
  } catch (err) {
    if (err instanceof ConsentRecoveryHoldError) return notFound();
    if (err instanceof ConsentStorageBusyError) {
      return NextResponse.json(
        { error: "Signing is already being finalized. Please retry." },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    if (
      err instanceof ManagedUploadConflictError ||
      err instanceof ConsentFileBindingConflictError ||
      err instanceof ConsentSignatureConflictError
    ) {
      return NextResponse.json(
        {
          error: "This signing attempt does not match the in-progress request",
        },
        { status: 409 },
      );
    }
    console.error("Consent signing failed:", sanitizedExceptionTelemetry(err));
    return NextResponse.json({ error: "Signing failed" }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  return privateNoStore(await handleGet(request, context));
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  return privateNoStore(await handlePost(request, context));
}
