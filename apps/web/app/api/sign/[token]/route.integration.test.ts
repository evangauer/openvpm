import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { consentRequests, files } from "@openpims/db";
import { db } from "@openpims/db/client";
import { hashConsentToken } from "@/lib/consult/tokens";
import { withTenant } from "@/lib/tenant-db";

const storageMocks = vi.hoisted(() => ({
  putAndVerifyManagedUpload: vi.fn(async () => ({
    status: "verified" as const,
    evidence: { etag: "isolated-etag", versionId: "isolated-version" },
  })),
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
const TOKEN = "cd".repeat(32);
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

runDatabaseIntegration("consent signing pool-size-one route", () => {
  afterAll(async () => {
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
    await expect(response.json()).resolves.toEqual({ ok: true });
    const [signed] = await withTenant(db, PRACTICE_ID, (tx) =>
      tx
        .select({
          status: consentRequests.status,
          token: consentRequests.token,
          signerAttestationVersion: consentRequests.signerAttestationVersion,
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
      storageStatus: "available",
    });
    expect(storageMocks.putAndVerifyManagedUpload).toHaveBeenCalledOnce();
    expect(storageMocks.queueManagedUploadReplication).toHaveBeenCalledOnce();
  }, 5_000);
});
