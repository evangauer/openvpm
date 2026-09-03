import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  auditLog,
  consentReceiptCapabilities,
  consentRequests,
  files,
  practices,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  captureRateLimitKey,
  hashConsentReceiptToken,
  isCaptureTokenShape,
} from "@/lib/consult/tokens";
import { checksumSha256Hex } from "@/lib/file-replication";
import { UPLOAD_FILE_MAX_BYTES } from "@/lib/upload-limits";
import { normalizeS3VersionId, readPrimaryObject } from "@/lib/s3";
import { uploadBytesMatchMimeType } from "@/lib/upload-security";
import { readRequestBytesWithLimit } from "@/lib/request-body";

export const dynamic = "force-dynamic";

const RECEIPT_REQUEST_MAX_BYTES = 1_024;
const RECEIPT_IP_LIMIT = 30;
const RECEIPT_TOKEN_LIMIT = 10;
const RECEIPT_WINDOW_MS = 10 * 60 * 1000;

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found" },
    {
      status: 404,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

export async function POST(request: NextRequest) {
  const ip = clientIpFromRequest(request);
  let ipLimit: Awaited<ReturnType<typeof rateLimit>>;
  try {
    ipLimit = await rateLimit({
      key: `consent-receipt:ip:${ip}`,
      limit: RECEIPT_IP_LIMIT,
      windowMs: RECEIPT_WINDOW_MS,
    });
  } catch {
    return notFound();
  }
  if (!ipLimit.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: rateLimitResponseHeaders(RECEIPT_IP_LIMIT, ipLimit),
      },
    );
  }

  const body = await readRequestBytesWithLimit(
    request,
    RECEIPT_REQUEST_MAX_BYTES,
  );
  if (!body.ok) return notFound();

  let token = "";
  try {
    const payload = JSON.parse(Buffer.from(body.bytes).toString("utf8")) as {
      receiptToken?: unknown;
    };
    token =
      typeof payload?.receiptToken === "string" ? payload.receiptToken : "";
  } catch {
    return notFound();
  }
  if (!isCaptureTokenShape(token)) return notFound();

  let tokenLimit: Awaited<ReturnType<typeof rateLimit>>;
  try {
    tokenLimit = await rateLimit({
      key: captureRateLimitKey("consent-receipt", token),
      limit: RECEIPT_TOKEN_LIMIT,
      windowMs: RECEIPT_WINDOW_MS,
    });
  } catch {
    return notFound();
  }
  if (!tokenLimit.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: rateLimitResponseHeaders(RECEIPT_TOKEN_LIMIT, tokenLimit),
      },
    );
  }

  const tokenHash = hashConsentReceiptToken(token);
  let practiceId: string | null;
  try {
    practiceId = await withSystem(db, async (tx) => {
      const [candidate] = await tx
        .select({ practiceId: consentReceiptCapabilities.practiceId })
        .from(consentReceiptCapabilities)
        .innerJoin(
          practices,
          and(
            eq(practices.id, consentReceiptCapabilities.practiceId),
            eq(practices.recoveryHold, false),
            isNull(practices.deletedAt),
          ),
        )
        .where(
          and(
            eq(consentReceiptCapabilities.tokenHash, tokenHash),
            isNull(consentReceiptCapabilities.deletedAt),
          ),
        )
        .limit(1);
      return candidate?.practiceId ?? null;
    });
  } catch {
    return notFound();
  }
  if (!practiceId) return notFound();

  let claimed: Awaited<ReturnType<typeof claimReceipt>>;
  try {
    claimed = await claimReceipt(practiceId, tokenHash, ip);
  } catch {
    return notFound();
  }
  if (!claimed) return notFound();

  // The claim transaction is fully committed before any provider call. This
  // preserves the bounded replay budget without holding a connection or RLS
  // context across object-store I/O.
  const requestedVersion = normalizeS3VersionId(claimed.objectVersionId);
  let object: Awaited<ReturnType<typeof readPrimaryObject>>;
  try {
    object = await readPrimaryObject(claimed.fileKey, {
      maxBytes: claimed.size,
      ...(requestedVersion ? { versionId: requestedVersion } : {}),
    });
  } catch {
    return notFound();
  }
  if (object.status !== "available") return notFound();
  if (
    (requestedVersion &&
      normalizeS3VersionId(object.versionId) !== requestedVersion) ||
    object.body.byteLength !== claimed.size ||
    checksumSha256Hex(object.body) !== claimed.checksum ||
    !uploadBytesMatchMimeType("application/pdf", object.body)
  ) {
    return notFound();
  }

  return new NextResponse(Buffer.from(object.body), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(object.body.byteLength),
      "Content-Disposition": 'attachment; filename="signed-consent.pdf"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox",
    },
  });
}

async function claimReceipt(practiceId: string, tokenHash: string, ip: string) {
  return withTenant(db, practiceId, async (tx) => {
    const [capability] = await tx
      .update(consentReceiptCapabilities)
      .set({
        claimCount: sql`${consentReceiptCapabilities.claimCount} + 1`,
        lastClaimedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(consentReceiptCapabilities.practiceId, practiceId),
          eq(consentReceiptCapabilities.tokenHash, tokenHash),
          gt(consentReceiptCapabilities.expiresAt, sql`clock_timestamp()`),
          lt(
            consentReceiptCapabilities.claimCount,
            consentReceiptCapabilities.maxClaims,
          ),
          isNull(consentReceiptCapabilities.deletedAt),
        ),
      )
      .returning({ id: consentReceiptCapabilities.id });
    if (!capability) return null;

    const [metadata] = await tx
      .select({
        consentRequestId: consentReceiptCapabilities.consentRequestId,
        fileId: files.id,
        fileName: files.fileName,
        fileKey: files.fileKey,
        objectVersionId: files.objectVersionId,
        checksum: files.checksumSha256,
        size: files.fileSizeBytes,
        claimCount: consentReceiptCapabilities.claimCount,
      })
      .from(consentReceiptCapabilities)
      .innerJoin(
        practices,
        and(
          eq(practices.id, consentReceiptCapabilities.practiceId),
          eq(practices.recoveryHold, false),
          isNull(practices.deletedAt),
        ),
      )
      .innerJoin(
        consentRequests,
        and(
          eq(consentRequests.id, consentReceiptCapabilities.consentRequestId),
          eq(consentRequests.practiceId, practiceId),
          eq(consentRequests.status, "signed"),
          eq(consentRequests.fileId, consentReceiptCapabilities.fileId),
          isNull(consentRequests.deletedAt),
        ),
      )
      .innerJoin(
        files,
        and(
          eq(files.id, consentReceiptCapabilities.fileId),
          eq(files.practiceId, practiceId),
          eq(
            files.checksumSha256,
            consentReceiptCapabilities.fileChecksumSha256,
          ),
          eq(files.fileSizeBytes, consentReceiptCapabilities.fileSizeBytes),
          eq(files.storageStatus, "available"),
          eq(files.mimeType, "application/pdf"),
          eq(files.category, "consents"),
          isNull(files.deletedAt),
        ),
      )
      .where(eq(consentReceiptCapabilities.id, capability.id))
      .limit(1);
    if (!metadata?.checksum || metadata.size === null) return null;
    if (metadata.size <= 0 || metadata.size > UPLOAD_FILE_MAX_BYTES)
      return null;

    await tx.insert(auditLog).values({
      practiceId,
      userId: null,
      action: "download_claim",
      entityType: "consent_receipt",
      entityId: capability.id,
      ipAddress: ip,
      changes: {
        actorType: "client",
        provenance: "public_consent_receipt_capability",
        consentRequestId: metadata.consentRequestId,
        fileId: metadata.fileId,
        fileChecksumSha256: metadata.checksum,
        claimCount: metadata.claimCount,
      },
    });
    return {
      ...metadata,
      checksum: metadata.checksum,
      size: metadata.size,
    };
  });
}
