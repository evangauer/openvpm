import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditLog, consentRequests, patients, practices } from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { captureRateLimitKey, isCaptureTokenShape } from "@/lib/consult/tokens";
import { CONSENT_SIGNER_NAME_MAX_LENGTH } from "@/lib/consult/consent-template";
import {
  buildConsentPdf,
  consentSignaturePngDecodes,
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
  title: string;
  bodyText: string;
  status: string;
  signerName: string | null;
  signedAt: Date | null;
  signaturePngBytes: Uint8Array | null;
  signatureSha256: string | null;
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
      title: consentRequests.title,
      bodyText: consentRequests.bodyText,
      status: consentRequests.status,
      signerName: consentRequests.signerName,
      signedAt: consentRequests.signedAt,
      signaturePngBytes: consentRequests.signaturePngBytes,
      signatureSha256: consentRequests.signatureSha256,
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
        eq(consentRequests.token, token),
        isNull(consentRequests.deletedAt),
        or(
          gt(consentRequests.expiresAt, now),
          and(
            inArray(consentRequests.status, ["signing", "signed"]),
            isNotNull(consentRequests.signerName),
            isNotNull(consentRequests.signedAt),
            isNotNull(consentRequests.signaturePngBytes),
            isNotNull(consentRequests.signatureSha256),
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

type SigningSession = ConsentLookup & {
  status: "signing" | "signed";
  signerName: string;
  signedAt: Date;
  signaturePngBytes: Buffer;
  signatureSha256: string;
};

function signingFromPersistedEvidence(
  session: ConsentLookup,
): SigningSession | null {
  if (
    (session.status !== "signing" && session.status !== "signed") ||
    !session.signerName ||
    !session.signedAt ||
    !session.signaturePngBytes ||
    !session.signatureSha256
  ) {
    return null;
  }
  return {
    ...session,
    status: session.status,
    signerName: session.signerName,
    signedAt: session.signedAt,
    signaturePngBytes: Buffer.from(session.signaturePngBytes),
    signatureSha256: session.signatureSha256,
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
): Promise<SigningSession | null> {
  if (session.status === "pending") {
    const claimed = await withTenant(db, session.practiceId, async (tx) => {
      const [row] = await tx
        .update(consentRequests)
        .set({
          status: "signing",
          signerName,
          signedAt: sql`clock_timestamp()`,
          signaturePngBytes,
          signatureSha256,
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
        });
      return row ?? null;
    });
    if (
      !claimed?.signerName ||
      !claimed.signedAt ||
      !claimed.signaturePngBytes ||
      !claimed.signatureSha256
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
    };
  }

  if (session.signerName === signerName) {
    const signing = signingFromPersistedEvidence(session);
    if (!signing) return null;
    if (
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

/** Reserve and bind the file manifest atomically, before any provider PUT. */
async function reserveConsentFile(
  session: SigningSession,
  pdf: Buffer,
): Promise<ManagedUploadReservation> {
  return withTenant(db, session.practiceId, async (tx) => {
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

    if (session.status === "signed") {
      if (session.fileId !== reservation.id) {
        throw new ConsentFileBindingConflictError();
      }
      return reservation;
    }

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

async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isCaptureTokenShape(token)) {
    return notFound();
  }

  return withSystem(db, async (systemTx) => {
    const session = await lookupConsent(systemTx, token);
    if (!session || !session.createdBy || billingBlocked(session)) {
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

    const limited = await enforceRateLimits(request, token, "consent-view");
    if (limited) return limited;

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

  return withSystem(db, async (systemTx) => {
    const session = await lookupConsent(systemTx, token);
    // Unknown, expired, orphaned, deleted-practice, and recovery-held requests
    // all get the same generic miss before request-body or provider work.
    if (!session || !session.createdBy || billingBlocked(session)) {
      return notFound();
    }
    // Hold this shared row lock across body parsing, durable state changes,
    // object-store work, and the final response. A recovery hold that commits
    // first fails closed here; one that loses waits for this request to end.
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

    const limited = await enforceRateLimits(request, token, "consent-sign");
    if (limited) return limited;

    const body = await readRequestBytesWithLimit(
      request,
      SIGN_REQUEST_MAX_BYTES,
    );
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
      resume?: unknown;
    };

    const resume = payload.resume === true;
    // Expiry terminates every new or replacement signing attempt. Only an
    // explicit server-side replay of exact evidence durably claimed while the
    // capability was live may finish afterward.
    if (!resume && session.expiresAt <= new Date()) return notFound();
    let signerName = "";
    let signatureBytes: Buffer | null = null;
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

      const dataUrl =
        typeof payload.signaturePngDataUrl === "string"
          ? payload.signaturePngDataUrl
          : "";
      if (!dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) {
        return NextResponse.json(
          { error: "Please draw your signature" },
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
          { error: "Please draw your signature" },
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
          { error: "Please draw your signature" },
          { status: 400 },
        );
      }
    }

    try {
      const signing = resume
        ? signingFromPersistedEvidence(session)
        : await claimSigning(
            session,
            signerName,
            signatureBytes!,
            checksumSha256Hex(signatureBytes!),
          );
      // A failed pending->signing compare-and-swap is the concurrent loser. It
      // exits before rendering, reserving, or touching object storage.
      if (!signing) return notFound();

      const persistedSignatureDataUrl = `${SIGNATURE_DATA_URL_PREFIX}${signing.signaturePngBytes.toString("base64")}`;
      const pdf = buildConsentPdf({
        documentId: signing.id,
        practiceId: signing.practiceId,
        patientId: signing.patientId,
        title: signing.title,
        bodyText: signing.bodyText,
        signerName: signing.signerName,
        signedAtIso: signing.signedAt.toISOString(),
        signaturePngDataUrl: persistedSignatureDataUrl,
      });
      const reservation = await reserveConsentFile(signing, pdf);
      const writeResult = await putAndVerifyManagedUpload({
        reservation,
        body: pdf,
      });
      if (writeResult.status === "unavailable") {
        return NextResponse.json(
          { error: "Signing outcome is still being verified. Please retry." },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }
      if (writeResult.status === "corrupt") {
        const marked = await withTenant(db, signing.practiceId, (tx) =>
          markManagedUploadCorrupt(tx, reservation),
        );
        if (!marked) {
          throw new Error("Consent reservation changed before quarantine");
        }
        return NextResponse.json(
          { error: "Signed document failed integrity verification" },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }

      let created = false;
      if (signing.status === "signed") {
        // A response may have been lost after commit. Verify the exact bytes and
        // heal manifest evidence, but never duplicate the audit event.
        await withTenant(db, signing.practiceId, async (tx) => {
          if (
            !(await finalizeManagedUploadManifest(
              tx,
              reservation,
              writeResult.evidence,
            ))
          ) {
            throw new Error("Consent file disappeared before finalization");
          }
        });
      } else {
        created = await withTenant(db, signing.practiceId, async (tx) => {
          const [completed] = await tx
            .update(consentRequests)
            .set({ status: "signed" })
            .where(
              and(
                eq(consentRequests.id, signing.id),
                eq(consentRequests.practiceId, signing.practiceId),
                eq(consentRequests.status, "signing"),
                eq(consentRequests.fileId, reservation.id),
                isNull(consentRequests.deletedAt),
              ),
            )
            .returning({ id: consentRequests.id });
          if (!completed) return false;

          if (
            !(await finalizeManagedUploadManifest(
              tx,
              reservation,
              writeResult.evidence,
            ))
          ) {
            throw new Error("Consent file disappeared before finalization");
          }

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
              signedAt: signing.signedAt.toISOString(),
              signatureSha256: signing.signatureSha256,
              patientId: signing.patientId,
              fileId: reservation.id,
            },
          });
          return true;
        });

        if (!created) {
          // A concurrent retry may have completed the same durable reservation.
          const completed = await lookupConsent(systemTx, token);
          if (
            !completed ||
            completed.status !== "signed" ||
            completed.fileId !== reservation.id
          ) {
            return notFound();
          }
        }
      }

      await queueManagedUploadReplication(reservation, writeResult.evidence);
      return NextResponse.json({ ok: true }, { status: created ? 201 : 200 });
    } catch (err) {
      if (
        err instanceof ManagedUploadConflictError ||
        err instanceof ConsentFileBindingConflictError ||
        err instanceof ConsentSignatureConflictError
      ) {
        return NextResponse.json(
          {
            error:
              "This signing attempt does not match the in-progress request",
          },
          { status: 409 },
        );
      }
      console.error("Consent signing failed:", err);
      return NextResponse.json({ error: "Signing failed" }, { status: 500 });
    }
  });
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
