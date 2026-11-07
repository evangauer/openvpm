import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@openpims/db";
import {
  consentReceiptCapabilities,
  consentRequests,
  files,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import { withTenant } from "@/lib/tenant-db";
import {
  hashConsentReceiptToken,
  hashConsentToken,
} from "@/lib/consult/tokens";
import { checksumSha256Hex } from "@/lib/file-replication";

const storageMocks = vi.hoisted(() => ({
  readPrimaryObject: vi.fn(),
}));

vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, readPrimaryObject: storageMocks.readPrimaryObject };
});

const runDatabaseIntegration =
  process.env.CONSENT_SIGN_POOL_ONE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const PRACTICE_ID = "33333333-3333-4333-8333-333333333331";
const PATIENT_ID = "33333333-3333-4333-8333-333333333334";
const CREATED_BY = "33333333-3333-4333-8333-333333333332";
const CONSENT_ID = "44444444-4444-4444-8444-444444444441";
const FILE_ID = "44444444-4444-4444-8444-444444444442";
const CAPABILITY_ID = "44444444-4444-4444-8444-444444444443";
const INTEGRITY_CONSENT_ID = "44444444-4444-4444-8444-444444444444";
const INTEGRITY_FILE_ID = "44444444-4444-4444-8444-444444444445";
const INTEGRITY_CAPABILITY_ID = "44444444-4444-4444-8444-444444444446";
const RECEIPT_TOKEN = "e4".repeat(32);
const INTEGRITY_RECEIPT_TOKEN = "e5".repeat(32);
const PDF = Buffer.from("%PDF-1.4\nexact signed copy\n%%EOF");

async function withFixtureOwner<T>(
  fn: (ownerDb: typeof db) => Promise<T>,
): Promise<T> {
  const ownerUrl = process.env.CONSENT_TEST_OWNER_DATABASE_URL?.trim();
  if (!ownerUrl) {
    throw new Error("CONSENT_TEST_OWNER_DATABASE_URL is required");
  }
  const ownerSql = postgres(ownerUrl, { max: 1 });
  try {
    const ownerDb = drizzle(ownerSql, { schema }) as unknown as typeof db;
    return await fn(ownerDb);
  } finally {
    await ownerSql.end();
  }
}

async function insertSignedReceiptFixture({
  consentId,
  fileId,
  capabilityId,
  receiptToken,
  maxClaims,
}: {
  consentId: string;
  fileId: string;
  capabilityId: string;
  receiptToken: string;
  maxClaims: number;
}) {
  const checksum = checksumSha256Hex(PDF);
  await withFixtureOwner(async (tx) => {
    await tx.insert(files).values({
      id: fileId,
      practiceId: PRACTICE_ID,
      uploadedBy: CREATED_BY,
      idempotencyKey: consentId,
      fileName: "signed-consent.pdf",
      fileKey: `${PRACTICE_ID}/consents/${fileId}`,
      fileUrl: `/api/files/${PRACTICE_ID}/consents/${fileId}`,
      mimeType: "application/pdf",
      fileSizeBytes: PDF.length,
      checksumSha256: checksum,
      objectVersionId: "receipt-version-1",
      storageStatus: "available",
      storageVerifiedAt: new Date(),
      category: "consents",
      source: "consent_signature",
      entityType: "patient",
      entityId: PATIENT_ID,
      patientId: PATIENT_ID,
    });
    await tx.insert(consentRequests).values({
      id: consentId,
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      createdBy: CREATED_BY,
      token: null,
      tokenHash: hashConsentToken("e6".repeat(32) + consentId.slice(-1)),
      expiresAt: new Date(Date.now() + 60_000),
      title: "Signed receipt fixture",
      bodyText: "Exact signed copy fixture.",
      status: "signed",
      signerName: "Receipt Client",
      signedAt: new Date(),
      fileId,
      signedFileKey: `${PRACTICE_ID}/consents/${fileId}`,
      signedFileChecksumSha256: checksum,
      signedFileSizeBytes: PDF.length,
      signedFileObjectVersionId: "receipt-version-1",
    });
    await tx.insert(consentReceiptCapabilities).values({
      id: capabilityId,
      practiceId: PRACTICE_ID,
      consentRequestId: consentId,
      fileId,
      fileChecksumSha256: checksum,
      fileSizeBytes: PDF.length,
      tokenHash: hashConsentReceiptToken(receiptToken),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      maxClaims,
    });
  });
}

function request(receiptToken: string) {
  return new Request("https://openvpm.test/api/sign/receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiptToken }),
  }) as never;
}

runDatabaseIntegration("consent receipt pool-size-one route", () => {
  beforeEach(() => {
    storageMocks.readPrimaryObject.mockReset();
  });

  afterAll(async () => {
    await globalThis.__openpimsDb?.client.end();
    globalThis.__openpimsDb = undefined;
  });

  it("atomically bounds concurrent claims and releases pool=1 before storage", async () => {
    await insertSignedReceiptFixture({
      consentId: CONSENT_ID,
      fileId: FILE_ID,
      capabilityId: CAPABILITY_ID,
      receiptToken: RECEIPT_TOKEN,
      maxClaims: 1,
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    storageMocks.readPrimaryObject.mockImplementationOnce(async () => {
      await providerGate;
      return {
        status: "available" as const,
        body: PDF,
        contentType: "application/pdf",
        versionId: "receipt-version-1",
      };
    });

    const { POST } = await import("./route");
    const winner = POST(request(RECEIPT_TOKEN));
    await vi.waitFor(() =>
      expect(storageMocks.readPrimaryObject).toHaveBeenCalledOnce(),
    );
    const loser = await POST(request(RECEIPT_TOKEN));
    expect(loser.status).toBe(404);
    releaseProvider();
    expect((await winner).status).toBe(200);

    const [capability] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          claimCount: consentReceiptCapabilities.claimCount,
          lastClaimedAt: consentReceiptCapabilities.lastClaimedAt,
          tokenHash: consentReceiptCapabilities.tokenHash,
        })
        .from(consentReceiptCapabilities)
        .where(eq(consentReceiptCapabilities.id, CAPABILITY_ID))
        .limit(1),
    );
    expect(capability?.claimCount).toBe(1);
    expect(capability?.lastClaimedAt).toBeInstanceOf(Date);
    expect(capability?.tokenHash).toBe(hashConsentReceiptToken(RECEIPT_TOKEN));
    expect(capability?.tokenHash).not.toBe(RECEIPT_TOKEN);
  }, 5_000);

  it("consumes the bounded claim and fails generically on wrong object bytes", async () => {
    await insertSignedReceiptFixture({
      consentId: INTEGRITY_CONSENT_ID,
      fileId: INTEGRITY_FILE_ID,
      capabilityId: INTEGRITY_CAPABILITY_ID,
      receiptToken: INTEGRITY_RECEIPT_TOKEN,
      maxClaims: 2,
    });
    storageMocks.readPrimaryObject.mockResolvedValueOnce({
      status: "available" as const,
      body: Buffer.from("%PDF-1.4\nnot the signed copy\n%%EOF"),
      contentType: "application/pdf",
      versionId: "receipt-version-1",
    });

    const { POST } = await import("./route");
    const response = await POST(request(INTEGRITY_RECEIPT_TOKEN));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });

    const [capability] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({ claimCount: consentReceiptCapabilities.claimCount })
        .from(consentReceiptCapabilities)
        .where(eq(consentReceiptCapabilities.id, INTEGRITY_CAPABILITY_ID))
        .limit(1),
    );
    expect(capability?.claimCount).toBe(1);
  }, 5_000);
});
