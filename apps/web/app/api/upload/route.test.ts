import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000002";
  const patientId = "00000000-0000-4000-8000-000000000003";
  const fileId = "00000000-0000-4000-8000-000000000004";
  class ManagedUploadConflictError extends Error {}
  class ManagedUploadStateError extends ManagedUploadConflictError {}
  const activeAccount = (overrides: Record<string, unknown> = {}) => ({
    userId,
    role: "admin",
    tier: "free",
    billingStatus: "trialing",
    trialEndsAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  });
  const reservation = (overrides: Record<string, unknown> = {}) => ({
    id: fileId,
    practiceId,
    uploadedBy: userId,
    idempotencyKey: "00000000-0000-4000-8000-000000000099",
    fileName: "logo.png",
    fileKey: `${practiceId}/branding/${fileId}`,
    fileUrl: `/api/files/${practiceId}/branding/${fileId}`,
    mimeType: "image/png",
    fileSizeBytes: 8,
    checksumSha256: "a".repeat(64),
    storageStatus: "pending_upload",
    category: "branding",
    source: "practice_logo",
    entityType: "practice",
    entityId: practiceId,
    patientId: null,
    appointmentId: null,
    created: true,
    ...overrides,
  });
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [activeAccount()];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const updateSets: Record<string, unknown>[] = [];
  const updateReturningResults: unknown[][] = [];
  const update = vi.fn(() => {
    const builder = {
      set: vi.fn((value: Record<string, unknown>) => {
        updateSets.push(value);
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(
        async () => updateReturningResults.shift() ?? [{ id: "linked" }],
      ),
    };
    return builder;
  });
  const tx = { select, update };

  return {
    tx,
    practiceId,
    userId,
    patientId,
    ManagedUploadConflictError,
    ManagedUploadStateError,
    activeAccount,
    reservation,
    selectResults,
    updateSets,
    updateReturningResults,
    getServerSession: vi.fn(async () => ({
      user: { id: userId, practiceId },
    })),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
    withTenant: vi.fn(
      async (_db: unknown, _practiceId: string, fn: (tx: unknown) => unknown) =>
        fn(tx),
    ),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 29,
      resetAt: new Date("2026-08-10T12:10:00Z"),
    })),
    reserveManagedUpload: vi.fn(async () => reservation()),
    putAndVerifyManagedUpload: vi.fn(async () => ({
      status: "verified" as const,
      evidence: {
        url: "https://storage.example/object",
        etag: "etag-1",
        versionId: "version-1",
      },
    })),
    finalizeManagedUploadManifest: vi.fn(async () => true),
    markManagedUploadCorrupt: vi.fn(async (): Promise<boolean> => true),
    queueManagedUploadReplication: vi.fn(async () => true),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
  };
});

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));
vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: vi.fn(() => "a".repeat(64)),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});
vi.mock("@/lib/managed-file-upload", () => ({
  ManagedUploadConflictError: mocks.ManagedUploadConflictError,
  reserveManagedUpload: mocks.reserveManagedUpload,
  putAndVerifyManagedUpload: mocks.putAndVerifyManagedUpload,
  finalizeManagedUploadManifest: mocks.finalizeManagedUploadManifest,
  markManagedUploadCorrupt: mocks.markManagedUploadCorrupt,
  queueManagedUploadReplication: mocks.queueManagedUploadReplication,
}));
vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "Practice recovery is in progress.",
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

const { POST } = await import("./route");
const { UPLOAD_REQUEST_MAX_BYTES } = await import("@/lib/upload-limits");

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function uploadRequest(
  options: {
    file?: File;
    category?: string;
    patientId?: string;
    idempotencyKey?: string | null;
    contentLength?: number;
  } = {},
) {
  const formData = new FormData();
  formData.append(
    "file",
    options.file ?? new File([PNG_BYTES], "logo.png", { type: "image/png" }),
  );
  formData.append("category", options.category ?? "branding");
  if (options.patientId) formData.append("patientId", options.patientId);
  const headers = new Headers();
  if (options.idempotencyKey !== null) {
    headers.set(
      "Idempotency-Key",
      options.idempotencyKey ?? "00000000-0000-4000-8000-000000000099",
    );
  }
  if (options.contentLength != null) {
    headers.set("content-length", String(options.contentLength));
  }
  return new Request("https://openvpm.test/api/upload", {
    method: "POST",
    headers,
    body: formData,
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.selectResults.length = 0;
  mocks.updateSets.length = 0;
  mocks.updateReturningResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.getServerSession.mockResolvedValue({
    user: { id: mocks.userId, practiceId: mocks.practiceId },
  });
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 29,
    resetAt: new Date("2026-08-10T12:10:00Z"),
  });
  mocks.reserveManagedUpload.mockResolvedValue(mocks.reservation());
  mocks.putAndVerifyManagedUpload.mockResolvedValue({
    status: "verified",
    evidence: {
      url: "https://storage.example/object",
      etag: "etag-1",
      versionId: "version-1",
    },
  });
  mocks.finalizeManagedUploadManifest.mockResolvedValue(true);
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
});

describe("managed dashboard upload route", () => {
  it("rejects oversized requests before auth or database work", async () => {
    const response = await POST(
      uploadRequest({ contentLength: UPLOAD_REQUEST_MAX_BYTES + 1 }),
    );
    expect(response.status).toBe(413);
    expect(mocks.getServerSession).toHaveBeenCalledTimes(1);
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("fails closed when the configured auth secret is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");
    const response = await POST(uploadRequest());
    expect(response.status).toBe(401);
    expect(mocks.getServerSession).not.toHaveBeenCalled();
  });

  it("rejects stale sessions and viewer mutations", async () => {
    mocks.selectResults.push([]);
    expect((await POST(uploadRequest())).status).toBe(401);

    mocks.selectResults.push([mocks.activeAccount({ role: "viewer" })]);
    expect((await POST(uploadRequest())).status).toBe(403);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("preserves the hosted billing write gate", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([
      mocks.activeAccount({
        tier: "cloud",
        billingStatus: "past_due",
        trialEndsAt: null,
      }),
    ]);
    expect((await POST(uploadRequest())).status).toBe(403);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("rate-limits by active user and practice before multipart parsing", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-08-10T12:10:00Z"),
    });
    const response = await POST(uploadRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `dashboard-upload:user:${mocks.userId}`,
      }),
    );
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("requires a UUID idempotency key and rejects generic clinical categories", async () => {
    expect((await POST(uploadRequest({ idempotencyKey: null }))).status).toBe(
      400,
    );
    expect((await POST(uploadRequest({ category: "documents" }))).status).toBe(
      400,
    );
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("allows only admins to change public branding", async () => {
    mocks.selectResults.push([mocks.activeAccount({ role: "veterinarian" })]);
    expect((await POST(uploadRequest())).status).toBe(403);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("requires and verifies an exact active patient for profile photos", async () => {
    expect(
      (await POST(uploadRequest({ category: "patient-photos" }))).status,
    ).toBe(400);

    mocks.selectResults.push([mocks.activeAccount()], []);
    expect(
      (
        await POST(
          uploadRequest({
            category: "patient-photos",
            patientId: mocks.patientId,
          }),
        )
      ).status,
    ).toBe(404);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("rejects non-images and signature mismatches", async () => {
    const pdf = new File([new TextEncoder().encode("%PDF-1.7\n")], "logo.pdf", {
      type: "application/pdf",
    });
    expect((await POST(uploadRequest({ file: pdf }))).status).toBe(400);

    const fake = new File(["<html></html>"], "fake.png", {
      type: "image/png",
    });
    expect((await POST(uploadRequest({ file: fake }))).status).toBe(400);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("reserves before PUT and atomically links a practice logo", async () => {
    const response = await POST(uploadRequest());
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      url: `/api/files/${mocks.practiceId}/branding/00000000-0000-4000-8000-000000000004`,
      key: `${mocks.practiceId}/branding/00000000-0000-4000-8000-000000000004`,
    });
    expect(mocks.reserveManagedUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        category: "branding",
        source: "practice_logo",
        entityType: "practice",
        entityId: mocks.practiceId,
      }),
    );
    expect(mocks.reserveManagedUpload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.putAndVerifyManagedUpload.mock.invocationCallOrder[0]!,
    );
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        logoUrl: expect.stringContaining("/api/files/"),
      }),
    );
    expect(mocks.queueManagedUploadReplication).toHaveBeenCalledTimes(1);
  });

  it("rejects a held practice before reading or calling storage", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    const response = await POST(uploadRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      error: "Practice recovery is in progress.",
    });
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("keeps the practice lease active through provider PUT and finalization", async () => {
    let leaseActive = false;
    let replicationQueuedAfterCommit = false;
    let resolvePut:
      | ((value: {
          status: "verified";
          evidence: { url: string; etag: string; versionId: string };
        }) => void)
      | undefined;
    mocks.withTenant.mockImplementationOnce(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown,
      ) => {
        leaseActive = true;
        try {
          return await fn(mocks.tx);
        } finally {
          leaseActive = false;
        }
      },
    );
    mocks.putAndVerifyManagedUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          expect(leaseActive).toBe(true);
          resolvePut = resolve;
        }),
    );
    mocks.finalizeManagedUploadManifest.mockImplementationOnce(async () => {
      expect(leaseActive).toBe(true);
      return true;
    });
    mocks.queueManagedUploadReplication.mockImplementationOnce(async () => {
      expect(leaseActive).toBe(false);
      replicationQueuedAfterCommit = true;
      return true;
    });

    const responsePromise = POST(uploadRequest());
    await vi.waitFor(() =>
      expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledOnce(),
    );
    expect(leaseActive).toBe(true);
    resolvePut?.({
      status: "verified",
      evidence: {
        url: "https://storage.example/object",
        etag: "etag-1",
        versionId: "version-1",
      },
    });

    expect((await responsePromise).status).toBe(201);
    expect(leaseActive).toBe(false);
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledOnce();
    expect(replicationQueuedAfterCommit).toBe(true);
  });

  it("rolls back finalization when entity linking fails and allows a retry", async () => {
    let transactionCallbackRejected = false;
    mocks.withTenant.mockImplementationOnce(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown,
      ) => {
        try {
          return await fn(mocks.tx);
        } catch (error) {
          transactionCallbackRejected = true;
          throw error;
        }
      },
    );
    mocks.updateReturningResults.push([]);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const failed = await POST(uploadRequest());

    expect(failed.status).toBe(500);
    expect(transactionCallbackRejected).toBe(true);
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledOnce();
    expect(mocks.queueManagedUploadReplication).not.toHaveBeenCalled();

    const retry = await POST(uploadRequest());

    expect(retry.status).toBe(201);
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledTimes(2);
    expect(mocks.queueManagedUploadReplication).toHaveBeenCalledOnce();
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        logoUrl: expect.stringContaining("/api/files/"),
      }),
    );
    consoleError.mockRestore();
  });

  it("binds patient-photo ownership and link in the same finalization", async () => {
    mocks.selectResults.push(
      [mocks.activeAccount()],
      [{ id: mocks.patientId }],
    );
    mocks.reserveManagedUpload.mockResolvedValueOnce(
      mocks.reservation({
        category: "patient-photos",
        patientId: mocks.patientId,
        entityType: "patient",
        entityId: mocks.patientId,
        source: "profile_photo",
        fileKey: `${mocks.practiceId}/patient-photos/00000000-0000-4000-8000-000000000004`,
        fileUrl: `/api/files/${mocks.practiceId}/patient-photos/00000000-0000-4000-8000-000000000004`,
      }),
    );

    const response = await POST(
      uploadRequest({
        category: "patient-photos",
        patientId: mocks.patientId,
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.reserveManagedUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patientId: mocks.patientId,
        entityType: "patient",
        entityId: mocks.patientId,
      }),
    );
    expect(mocks.updateSets).toContainEqual(
      expect.objectContaining({
        photoUrl: expect.stringContaining("/api/files/"),
      }),
    );
  });

  it("returns a completed reservation idempotently without another PUT", async () => {
    mocks.reserveManagedUpload.mockResolvedValueOnce(
      mocks.reservation({ created: false, storageStatus: "available" }),
    );
    const response = await POST(uploadRequest());
    expect(response.status).toBe(200);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("returns 409 when an idempotency key is reused for another payload", async () => {
    mocks.reserveManagedUpload.mockRejectedValueOnce(
      new mocks.ManagedUploadConflictError("conflict"),
    );
    expect((await POST(uploadRequest())).status).toBe(409);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("returns definitive 409 for a deleted managed-upload reservation", async () => {
    mocks.reserveManagedUpload.mockRejectedValueOnce(
      new mocks.ManagedUploadStateError(
        "Upload reservation is deleted and cannot be retried",
      ),
    );

    const response = await POST(uploadRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Upload reservation is deleted and cannot be retried",
    });
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
    expect(mocks.queueManagedUploadReplication).not.toHaveBeenCalled();
    expect(mocks.updateSets).toEqual([]);
  });

  it("leaves ambiguous provider outcomes reserved and retryable", async () => {
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "unavailable",
    } as never);
    const response = await POST(uploadRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("marks checksum mismatches corrupt without deleting ambiguous bytes", async () => {
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    } as never);
    const response = await POST(uploadRequest());
    expect(response.status).toBe(503);
    expect(mocks.markManagedUploadCorrupt).toHaveBeenCalledTimes(1);
    expect(ROUTE_SOURCE).not.toContain("deleteFile(");
  });

  it("fails closed when quarantine loses the exact reservation generation", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    } as never);
    mocks.markManagedUploadCorrupt.mockResolvedValueOnce(false);

    const response = await POST(uploadRequest());
    expect(response.status).toBe(500);
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[upload] managed upload failed");
    consoleError.mockRestore();
  });

  it("uses bounded parsing and revalidates the active database role", () => {
    expect(ROUTE_SOURCE).toContain("readRequestBytesWithLimit(");
    expect(ROUTE_SOURCE).not.toContain("req.formData()");
    expect(ROUTE_SOURCE).toContain("role: users.role");
    expect(ROUTE_SOURCE).toContain('activeAccount.role === "viewer"');
    expect(ROUTE_SOURCE).toContain("eq(patients.practiceId, practiceId)");
    expect(ROUTE_SOURCE).toContain("isNull(patients.deletedAt)");
  });
});
