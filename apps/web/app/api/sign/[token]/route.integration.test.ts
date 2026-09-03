import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@openpims/db";
import { consentRequests, files, practices } from "@openpims/db";
import { db } from "@openpims/db/client";
import { hashConsentToken } from "@/lib/consult/tokens";
import { withTenant } from "@/lib/tenant-db";
import { checksumSha256Hex } from "@/lib/file-replication";
import {
  buildConsentPdf,
  buildConsentPdfV1,
  CONSENT_PDF_RENDERER_V1,
  CONSENT_PDF_RENDERER_V2,
} from "@/lib/consult/consent-pdf";
import {
  CONSENT_ELECTRONIC_SIGNATURE_INTENT,
  CONSENT_SIGNER_ATTESTATION_VERSION,
  CONSENT_SIGNER_AUTHORITY_ATTESTATION,
} from "@/lib/consult/consent-template";
import type { ManagedUploadReservation } from "@/lib/managed-file-upload";
import {
  PRACTICE_EXPORT_SECTIONS,
  restorePracticeData,
} from "@/lib/backup/export";

const storageMocks = vi.hoisted(() => ({
  putAndVerifyManagedUpload: vi.fn(
    async (_input: {
      reservation: ManagedUploadReservation;
      body: Buffer;
    }) => ({
      status: "verified" as const,
      evidence: { etag: "isolated-etag", versionId: "isolated-version" },
    }),
  ),
  queueManagedUploadReplication: vi.fn(async () => true),
}));

vi.mock("@/lib/managed-file-upload", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/managed-file-upload")>();
  return {
    ...actual,
    putAndVerifyManagedUpload: storageMocks.putAndVerifyManagedUpload,
    queueManagedUploadReplication: storageMocks.queueManagedUploadReplication,
  };
});

const runDatabaseIntegration =
  process.env.CONSENT_SIGN_POOL_ONE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const PRACTICE_ID = "33333333-3333-4333-8333-333333333331";
const PATIENT_ID = "33333333-3333-4333-8333-333333333334";
const CREATED_BY = "33333333-3333-4333-8333-333333333332";
const CONSENT_ID = "33333333-3333-4333-8333-333333333344";
const LEGACY_CONSENT_ID = "33333333-3333-4333-8333-333333333345";
const LEGACY_FILE_ID = "33333333-3333-4333-8333-333333333346";
const LEASE_CONSENT_ID = "33333333-3333-4333-8333-333333333347";
const PARENT_V2_CONSENT_ID = "33333333-3333-4333-8333-333333333348";
const PARENT_V2_FILE_ID = "33333333-3333-4333-8333-333333333349";
const MISMATCH_CONSENT_ID = "33333333-3333-4333-8333-333333333350";
const MISMATCH_FILE_ID = "33333333-3333-4333-8333-333333333351";
const TOKEN = "cd".repeat(32);
const LEGACY_TOKEN = "ce".repeat(32);
const LEASE_TOKEN = "cf".repeat(32);
const PARENT_V2_TOKEN = "d0".repeat(32);
const MISMATCH_TOKEN = "d1".repeat(32);
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

runDatabaseIntegration("consent signing pool-size-one route", () => {
  beforeAll(() => {
    process.env.TREATMENT_PLAN_CLIENT_DECISIONS_ENABLED = "true";
  });

  beforeEach(() => {
    storageMocks.putAndVerifyManagedUpload.mockClear();
    storageMocks.queueManagedUploadReplication.mockClear();
  });

  afterAll(async () => {
    delete process.env.TREATMENT_PLAN_CLIENT_DECISIONS_ENABLED;
    await globalThis.__openpimsDb?.client.end();
    globalThis.__openpimsDb = undefined;
  });

  it("claims, reserves, writes, and finalizes sequentially with one pooled connection", async () => {
    await withTenant(db, PRACTICE_ID, async (tx) => {
      await tx.insert(consentRequests).values({
        id: CONSENT_ID,
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: CREATED_BY,
        token: null,
        tokenHash: hashConsentToken(TOKEN),
        expiresAt: new Date(Date.now() + 60_000),
        title: "Pool-size-one consent",
        bodyText: "I reviewed this isolated test consent.",
      });
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request(`https://openvpm.test/api/sign/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signerName: "Client Pool",
          signerAuthorityAccepted: true,
          signaturePngDataUrl: SIGNATURE_DATA_URL,
        }),
      }) as never,
      { params: Promise.resolve({ token: TOKEN }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      receiptToken: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const [signed] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          status: consentRequests.status,
          token: consentRequests.token,
          signerAttestationVersion: consentRequests.signerAttestationVersion,
          documentRenderVersion: consentRequests.documentRenderVersion,
          storageLeaseToken: consentRequests.storageLeaseToken,
          storageLeaseExpiresAt: consentRequests.storageLeaseExpiresAt,
          storageStatus: files.storageStatus,
        })
        .from(consentRequests)
        .innerJoin(
          files,
          and(
            eq(files.id, consentRequests.fileId),
            eq(files.practiceId, consentRequests.practiceId),
          ),
        )
        .where(
          and(
            eq(consentRequests.id, CONSENT_ID),
            eq(consentRequests.practiceId, PRACTICE_ID),
          ),
        )
        .limit(1),
    );
    expect(signed).toEqual({
      status: "signed",
      token: null,
      signerAttestationVersion: "owner-authority-v1",
      documentRenderVersion: "consent-pdf-v2",
      storageLeaseToken: null,
      storageLeaseExpiresAt: null,
      storageStatus: "available",
    });
    expect(storageMocks.putAndVerifyManagedUpload).toHaveBeenCalledOnce();
    expect(storageMocks.queueManagedUploadReplication).toHaveBeenCalledOnce();

    let rendererMutationError: unknown;
    try {
      await withTenant(db, PRACTICE_ID, (tx) =>
        tx
          .update(consentRequests)
          .set({ documentRenderVersion: CONSENT_PDF_RENDERER_V1 })
          .where(eq(consentRequests.id, CONSENT_ID)),
      );
    } catch (error) {
      rendererMutationError = error;
    }
    expect(rendererMutationError).toBeInstanceOf(Error);
    expect(
      [
        (rendererMutationError as Error).message,
        (rendererMutationError as Error & { cause?: Error }).cause?.message,
      ].join("\n"),
    ).toContain("Signed consent evidence is terminal");

    const replay = await POST(
      new Request(`https://openvpm.test/api/sign/${TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      }) as never,
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(replay.status).toBe(200);
    expect(storageMocks.putAndVerifyManagedUpload).toHaveBeenCalledOnce();
  }, 5_000);

  it("fails closed for a preexisting v1 reservation until owner repair", async () => {
    const signedAt = new Date();
    const signatureBytes = Buffer.from(
      SIGNATURE_DATA_URL.slice("data:image/png;base64,".length),
      "base64",
    );
    const legacyPdf = buildConsentPdfV1({
      documentId: LEGACY_CONSENT_ID,
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      title: "Legacy in-flight consent",
      bodyText: "These bytes were reserved by the pre-version renderer.",
      signerName: "Legacy Client",
      signedAtIso: signedAt.toISOString(),
      signaturePngDataUrl: SIGNATURE_DATA_URL,
    });
    const legacyChecksum = checksumSha256Hex(legacyPdf);

    await withFixtureOwner(async (tx) => {
      await tx.insert(files).values({
        id: LEGACY_FILE_ID,
        practiceId: PRACTICE_ID,
        uploadedBy: CREATED_BY,
        idempotencyKey: LEGACY_CONSENT_ID,
        fileName: `signed-consent-${LEGACY_CONSENT_ID.slice(0, 8)}.pdf`,
        fileKey: `${PRACTICE_ID}/consents/${LEGACY_FILE_ID}`,
        fileUrl: `/api/files/${PRACTICE_ID}/consents/${LEGACY_FILE_ID}`,
        mimeType: "application/pdf",
        fileSizeBytes: legacyPdf.length,
        checksumSha256: legacyChecksum,
        storageStatus: "pending_upload",
        category: "consents",
        source: "consent_signature",
        entityType: "patient",
        entityId: PATIENT_ID,
        patientId: PATIENT_ID,
      });
      await tx.insert(consentRequests).values({
        id: LEGACY_CONSENT_ID,
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: CREATED_BY,
        token: LEGACY_TOKEN,
        tokenHash: null,
        expiresAt: new Date(Date.now() + 60_000),
        title: "Legacy in-flight consent",
        bodyText: "These bytes were reserved by the pre-version renderer.",
        status: "signing",
        signerName: "Legacy Client",
        signedAt,
        signaturePngBytes: signatureBytes,
        signatureSha256: checksumSha256Hex(signatureBytes),
        // This row models a reservation created before the hardening
        // migration, when neither attestation nor renderer version existed.
        signerAttestationVersion: null,
        documentRenderVersion: null,
        fileId: LEGACY_FILE_ID,
      });
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request(`https://openvpm.test/api/sign/${LEGACY_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume: true,
          signerAuthorityAccepted: true,
        }),
      }) as never,
      { params: Promise.resolve({ token: LEGACY_TOKEN }) },
    );

    expect(response.status).toBe(404);
    expect(storageMocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    const [completed] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          status: consentRequests.status,
          signerAttestationVersion: consentRequests.signerAttestationVersion,
          documentRenderVersion: consentRequests.documentRenderVersion,
          storageLeaseToken: consentRequests.storageLeaseToken,
          storageStatus: files.storageStatus,
        })
        .from(consentRequests)
        .innerJoin(files, eq(files.id, consentRequests.fileId))
        .where(eq(consentRequests.id, LEGACY_CONSENT_ID))
        .limit(1),
    );
    expect(completed).toEqual({
      status: "signing",
      signerAttestationVersion: null,
      documentRenderVersion: null,
      storageLeaseToken: null,
      storageStatus: "pending_upload",
    });
  }, 5_000);

  it("fails closed for an exact parent-generation v2 reservation until owner repair", async () => {
    const signedAt = new Date();
    const signatureBytes = Buffer.from(
      SIGNATURE_DATA_URL.slice("data:image/png;base64,".length),
      "base64",
    );
    const v2Pdf = buildConsentPdf({
      documentId: PARENT_V2_CONSENT_ID,
      practiceId: PRACTICE_ID,
      patientId: PATIENT_ID,
      title: "Parent in-flight consent",
      bodyText: "These bytes were reserved by the parent v2 renderer.",
      signerName: "Parent Client",
      signerAttestation: `${CONSENT_SIGNER_AUTHORITY_ATTESTATION} ${CONSENT_ELECTRONIC_SIGNATURE_INTENT}`,
      signedAtIso: signedAt.toISOString(),
      signaturePngDataUrl: SIGNATURE_DATA_URL,
    });
    const v2Checksum = checksumSha256Hex(v2Pdf);

    await withFixtureOwner(async (tx) => {
      await tx.insert(files).values({
        id: PARENT_V2_FILE_ID,
        practiceId: PRACTICE_ID,
        uploadedBy: CREATED_BY,
        idempotencyKey: PARENT_V2_CONSENT_ID,
        fileName: `signed-consent-${PARENT_V2_CONSENT_ID.slice(0, 8)}.pdf`,
        fileKey: `${PRACTICE_ID}/consents/${PARENT_V2_FILE_ID}`,
        fileUrl: `/api/files/${PRACTICE_ID}/consents/${PARENT_V2_FILE_ID}`,
        mimeType: "application/pdf",
        fileSizeBytes: v2Pdf.length,
        checksumSha256: v2Checksum,
        storageStatus: "pending_upload",
        category: "consents",
        source: "consent_signature",
        entityType: "patient",
        entityId: PATIENT_ID,
        patientId: PATIENT_ID,
      });
      await tx.insert(consentRequests).values({
        id: PARENT_V2_CONSENT_ID,
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: CREATED_BY,
        token: PARENT_V2_TOKEN,
        expiresAt: new Date(Date.now() + 60_000),
        title: "Parent in-flight consent",
        bodyText: "These bytes were reserved by the parent v2 renderer.",
        status: "signing",
        signerName: "Parent Client",
        signedAt,
        signaturePngBytes: signatureBytes,
        signatureSha256: checksumSha256Hex(signatureBytes),
        // Exact parent 5414/b5 generation: attestation was persisted but the
        // renderer column did not exist when the reservation was created.
        signerAttestationVersion: CONSENT_SIGNER_ATTESTATION_VERSION,
        documentRenderVersion: null,
        fileId: PARENT_V2_FILE_ID,
      });
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request(`https://openvpm.test/api/sign/${PARENT_V2_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      }) as never,
      { params: Promise.resolve({ token: PARENT_V2_TOKEN }) },
    );

    expect(response.status).toBe(404);
    expect(storageMocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    const [completed] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          status: consentRequests.status,
          documentRenderVersion: consentRequests.documentRenderVersion,
        })
        .from(consentRequests)
        .where(eq(consentRequests.id, PARENT_V2_CONSENT_ID))
        .limit(1),
    );
    expect(completed).toEqual({
      status: "signing",
      documentRenderVersion: null,
    });
  }, 5_000);

  it("fails closed when a preexisting reservation matches neither renderer", async () => {
    const signedAt = new Date();
    const signatureBytes = Buffer.from(
      SIGNATURE_DATA_URL.slice("data:image/png;base64,".length),
      "base64",
    );
    await withFixtureOwner(async (tx) => {
      await tx.insert(files).values({
        id: MISMATCH_FILE_ID,
        practiceId: PRACTICE_ID,
        uploadedBy: CREATED_BY,
        idempotencyKey: MISMATCH_CONSENT_ID,
        fileName: `signed-consent-${MISMATCH_CONSENT_ID.slice(0, 8)}.pdf`,
        fileKey: `${PRACTICE_ID}/consents/${MISMATCH_FILE_ID}`,
        fileUrl: `/api/files/${PRACTICE_ID}/consents/${MISMATCH_FILE_ID}`,
        mimeType: "application/pdf",
        fileSizeBytes: 123,
        checksumSha256: "f".repeat(64),
        storageStatus: "pending_upload",
        category: "consents",
        source: "consent_signature",
        entityType: "patient",
        entityId: PATIENT_ID,
        patientId: PATIENT_ID,
      });
      await tx.insert(consentRequests).values({
        id: MISMATCH_CONSENT_ID,
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: CREATED_BY,
        token: MISMATCH_TOKEN,
        expiresAt: new Date(Date.now() + 60_000),
        title: "Mismatched in-flight consent",
        bodyText: "This reservation must not be replaced.",
        status: "signing",
        signerName: "Mismatch Client",
        signedAt,
        signaturePngBytes: signatureBytes,
        signatureSha256: checksumSha256Hex(signatureBytes),
        signerAttestationVersion: CONSENT_SIGNER_ATTESTATION_VERSION,
        documentRenderVersion: null,
        fileId: MISMATCH_FILE_ID,
      });
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request(`https://openvpm.test/api/sign/${MISMATCH_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      }) as never,
      { params: Promise.resolve({ token: MISMATCH_TOKEN }) },
    );

    expect(response.status).toBe(404);
    expect(storageMocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    const [row] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({ version: consentRequests.documentRenderVersion })
        .from(consentRequests)
        .where(eq(consentRequests.id, MISMATCH_CONSENT_ID))
        .limit(1),
    );
    expect(row?.version).toBeNull();
  }, 5_000);

  it("leaves pool=1 free while the durable lease blocks concurrent recovery", async () => {
    await withTenant(db, PRACTICE_ID, (tx) =>
      tx.insert(consentRequests).values({
        id: LEASE_CONSENT_ID,
        practiceId: PRACTICE_ID,
        patientId: PATIENT_ID,
        createdBy: CREATED_BY,
        token: LEASE_TOKEN,
        expiresAt: new Date(Date.now() + 60_000),
        title: "Recovery fence consent",
        bodyText: "Provider I/O must not hold the only database connection.",
      }),
    );

    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    storageMocks.putAndVerifyManagedUpload.mockImplementationOnce(async () => {
      await providerGate;
      return {
        status: "verified" as const,
        evidence: {
          etag: "lease-isolated-etag",
          versionId: "lease-isolated-version",
        },
      };
    });

    const { POST } = await import("./route");
    const signing = POST(
      new Request(`https://openvpm.test/api/sign/${LEASE_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signerName: "Lease Client",
          signerAuthorityAccepted: true,
          signaturePngDataUrl: SIGNATURE_DATA_URL,
        }),
      }) as never,
      { params: Promise.resolve({ token: LEASE_TOKEN }) },
    );
    await vi.waitFor(() =>
      expect(storageMocks.putAndVerifyManagedUpload).toHaveBeenCalledOnce(),
    );

    const emptyBackup = Object.fromEntries(
      PRACTICE_EXPORT_SECTIONS.map((section) => [section, []]),
    );
    await expect(
      restorePracticeData(db, PRACTICE_ID, emptyBackup, {
        recoveryHoldDb: db,
      }),
    ).rejects.toThrow(
      "Recovery cannot begin while a signed-document storage operation is in flight",
    );
    const [practice] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({ recoveryHold: practices.recoveryHold })
        .from(practices)
        .where(eq(practices.id, PRACTICE_ID))
        .limit(1),
    );
    expect(practice?.recoveryHold).toBe(false);

    releaseProvider();
    expect((await signing).status).toBe(201);
  }, 5_000);
});
