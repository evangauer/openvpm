import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-4000-8000-000000000001";
  const patientId = "00000000-0000-4000-8000-000000000002";
  const createdBy = "00000000-0000-4000-8000-000000000003";
  const fileId = "00000000-0000-4000-8000-000000000004";
  const captureSessionId = "00000000-0000-4000-8000-000000000005";
  const appointmentId = "00000000-0000-4000-8000-000000000006";

  const captureSession = (overrides: Record<string, unknown> = {}) => ({
    id: captureSessionId,
    practiceId,
    patientId,
    createdBy,
    appointmentId,
    tier: "free",
    billingStatus: "trialing",
    trialEndsAt: new Date("2099-01-01T00:00:00Z"),
    ...overrides,
  });

  const reservation = (overrides: Record<string, unknown> = {}) => ({
    id: fileId,
    practiceId,
    uploadedBy: createdBy,
    idempotencyKey: "00000000-0000-4000-8000-000000000099",
    fileName: "photo.png",
    fileKey: `${practiceId}/patient-photos/${fileId}`,
    fileUrl: `/api/files/${practiceId}/patient-photos/${fileId}`,
    mimeType: "image/png",
    fileSizeBytes: 8,
    checksumSha256: "a".repeat(64),
    storageStatus: "pending_upload",
    category: "patient-photos",
    source: `capture:${captureSessionId}`,
    entityType: "patient",
    entityId: patientId,
    patientId,
    appointmentId,
    created: true,
    ...overrides,
  });

  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });
  const tx = { select };
  class ManagedUploadConflictError extends Error {}

  return {
    practiceId,
    patientId,
    createdBy,
    fileId,
    captureSessionId,
    appointmentId,
    tx,
    captureSession,
    reservation,
    selectResults,
    ManagedUploadConflictError,
    reserveManagedUpload: vi.fn(
      async (_tx: unknown, _input: Record<string, unknown>) => reservation(),
    ),
    putAndVerifyManagedUpload: vi.fn(
      async (
        _input: unknown,
      ): Promise<
        | {
            status: "verified";
            evidence: { url: string; etag: string; versionId: string };
          }
        | { status: "unavailable" }
        | { status: "corrupt" }
      > => ({
        status: "verified",
        evidence: {
          url: "https://storage.example/object",
          etag: "etag-1",
          versionId: "version-1",
        },
      }),
    ),
    finalizeManagedUploadManifest: vi.fn(async () => true),
    markManagedUploadCorrupt: vi.fn(async (): Promise<boolean> => true),
    queueManagedUploadReplication: vi.fn(async () => true),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
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
      remaining: 10,
      resetAt: new Date("2026-07-10T13:00:00Z"),
    })),
    readRequestBytesWithLimit: vi.fn(),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/recovery-hold", () => ({
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));
vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: vi.fn(() => "a".repeat(64)),
}));
vi.mock("@/lib/managed-file-upload", () => {
  return {
    ManagedUploadConflictError: mocks.ManagedUploadConflictError,
    reserveManagedUpload: mocks.reserveManagedUpload,
    putAndVerifyManagedUpload: mocks.putAndVerifyManagedUpload,
    finalizeManagedUploadManifest: mocks.finalizeManagedUploadManifest,
    markManagedUploadCorrupt: mocks.markManagedUploadCorrupt,
    queueManagedUploadReplication: mocks.queueManagedUploadReplication,
  };
});
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    rateLimit: mocks.rateLimit,
    rateLimitResponseHeaders: actual.rateLimitResponseHeaders,
  };
});
vi.mock("@/lib/request-body", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/request-body")>();
  mocks.readRequestBytesWithLimit.mockImplementation(
    actual.readRequestBytesWithLimit,
  );
  return {
    ...actual,
    readRequestBytesWithLimit: mocks.readRequestBytesWithLimit,
  };
});

const { POST } = await import("./route");

const TOKEN = "ab".repeat(32);
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000099";
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function captureRequest(
  tokenParam: string,
  file?: File,
  idempotencyKey: string | null = IDEMPOTENCY_KEY,
) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  const headers = new Headers();
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request(`https://openvpm.test/api/capture/${tokenParam}`, {
    method: "POST",
    headers,
    body: formData,
  }) as never;
}

function call(
  tokenParam: string,
  file?: File,
  idempotencyKey: string | null = IDEMPOTENCY_KEY,
) {
  return POST(captureRequest(tokenParam, file, idempotencyKey), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

function pngFile(name = "photo.png") {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function queueValidContext(
  input: {
    appointmentId?: string | null;
    usage?: { count: number; replayCount: number };
  } = {},
) {
  const session = mocks.captureSession({
    appointmentId:
      input.appointmentId === undefined
        ? mocks.appointmentId
        : input.appointmentId,
  });
  mocks.selectResults.push(
    [session],
    [{ id: mocks.captureSessionId }],
    [{ id: mocks.patientId }],
    [{ id: mocks.createdBy }],
  );
  if (session.appointmentId) {
    mocks.selectResults.push([{ id: session.appointmentId }]);
  }
  mocks.selectResults.push([input.usage ?? { count: 0, replayCount: 0 }]);
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.withSystem.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
  );
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date("2026-07-10T13:00:00Z"),
  });
  mocks.reserveManagedUpload.mockImplementation(async () =>
    mocks.reservation(),
  );
  mocks.putAndVerifyManagedUpload.mockResolvedValue({
    status: "verified",
    evidence: {
      url: "https://storage.example/object",
      etag: "etag-1",
      versionId: "version-1",
    },
  });
  mocks.finalizeManagedUploadManifest.mockResolvedValue(true);
});

describe("POST /api/capture/[token]", () => {
  it("404s on malformed tokens before doing any work", async () => {
    for (const bad of ["short", "Z".repeat(64), "../etc", `${TOKEN}x`]) {
      const res = await call(bad, pngFile());
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe(
        "private, no-store, max-age=0",
      );
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("returns identical generic 404s for unknown and expired tokens", async () => {
    mocks.selectResults.push([]);
    const unknownRes = await call(TOKEN, pngFile());
    mocks.selectResults.push([]);
    const expiredRes = await call(TOKEN, pngFile());

    expect(unknownRes.status).toBe(404);
    expect(expiredRes.status).toBe(404);
    await expect(unknownRes.json()).resolves.toEqual({ error: "Not found" });
    await expect(expiredRes.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("hides missing, deleted, and recovery-held practices before body or provider work", async () => {
    for (const _state of ["missing", "deleted", "recovery-held"]) {
      mocks.selectResults.push([]);
      const response = await call(TOKEN, pngFile());
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("fails closed before body or provider work when recovery wins after lookup", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    const response = await call(TOKEN, pngFile());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledWith(
      expect.anything(),
      mocks.practiceId,
    );
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("requires a client-generated canonical UUID after validating the link", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    const res = await call(TOKEN, pngFile(), null);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "A canonical UUID Idempotency-Key header is required",
    });
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("rate limits both the token and caller IP without storing the raw token", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    await call(TOKEN, pngFile());
    const calls = mocks.rateLimit.mock.calls as unknown as [
      { key: string; limit: number; windowMs: number },
    ][];
    const keys = calls.map((call) => call[0].key);
    expect(keys.some((key) => key.startsWith("capture-upload:ip:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("capture-upload:token:"))).toBe(
      true,
    );
    expect(keys.every((key) => !key.includes(TOKEN))).toBe(true);
    expect(calls[0]?.[0]).toMatchObject({
      limit: 300,
      windowMs: 10 * 60 * 1000,
    });
    expect(calls[1]?.[0]).toMatchObject({
      limit: 60,
      windowMs: 10 * 60 * 1000,
    });
  });

  it("429s with retry headers after resolving an active capability", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
  });

  it("hides inactive billing and orphaned creator states behind a generic 404", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([mocks.captureSession()]);
    const billingRes = await call(TOKEN, pngFile());
    expect(billingRes.status).toBe(404);

    mocks.billingEnforced.mockReturnValue(false);
    mocks.selectResults.push([mocks.captureSession({ createdBy: null })]);
    const orphanRes = await call(TOKEN, pngFile());
    expect(orphanRes.status).toBe(404);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("rejects missing, non-image, and spoofed image payloads", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    expect((await call(TOKEN)).status).toBe(400);

    mocks.selectResults.push([mocks.captureSession()]);
    const pdf = new File([new TextEncoder().encode("%PDF-1.7\n")], "lab.pdf", {
      type: "application/pdf",
    });
    expect((await call(TOKEN, pdf)).status).toBe(400);

    mocks.selectResults.push([mocks.captureSession()]);
    const fake = new File(
      [new TextEncoder().encode("<html></html>")],
      "fake.png",
      {
        type: "image/png",
      },
    );
    const spoofed = await call(TOKEN, fake);
    expect(spoofed.status).toBe(400);
    await expect(spoofed.json()).resolves.toEqual({
      error: "File contents do not match the declared file type",
    });
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["capture session", 1],
    ["patient", 2],
    ["creator", 3],
    ["appointment", 4],
  ])(
    "404s when the exact active %s ownership check fails",
    async (_label, missAt) => {
      const results: unknown[][] = [
        [mocks.captureSession()],
        [{ id: mocks.captureSessionId }],
        [{ id: mocks.patientId }],
        [{ id: mocks.createdBy }],
        [{ id: mocks.appointmentId }],
        [{ count: 0, replayCount: 0 }],
      ];
      results[missAt] = [];
      mocks.selectResults.push(...results);

      const res = await call(TOKEN, pngFile());
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
      expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
      expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    },
  );

  it("reserves a semantically bound manifest before provider I/O", async () => {
    queueValidContext();
    const res = await call(TOKEN, pngFile("side view.png"));

    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(res.json()).resolves.toEqual({
      ok: true,
      fileId: mocks.fileId,
    });
    expect(mocks.reserveManagedUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        practiceId: mocks.practiceId,
        uploadedBy: mocks.createdBy,
        idempotencyKey: IDEMPOTENCY_KEY,
        fileName: "side view.png",
        category: "patient-photos",
        source: `capture:${mocks.captureSessionId}`,
        entityType: "patient",
        entityId: mocks.patientId,
        patientId: mocks.patientId,
        appointmentId: mocks.appointmentId,
      }),
    );
    expect(mocks.reserveManagedUpload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.putAndVerifyManagedUpload.mock.invocationCallOrder[0],
    );
    expect(
      mocks.lockPracticeForExternalSideEffects.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.readRequestBytesWithLimit.mock.invocationCallOrder[0]!,
    );
    expect(
      mocks.readRequestBytesWithLimit.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.putAndVerifyManagedUpload.mock.invocationCallOrder[0]!,
    );
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalled();
    expect(mocks.queueManagedUploadReplication).toHaveBeenCalledWith(
      expect.objectContaining({ id: mocks.fileId }),
      expect.objectContaining({ versionId: "version-1" }),
    );
  });

  it("retains the shared-lock transaction until provider work and finalization finish", async () => {
    queueValidContext();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.putAndVerifyManagedUpload.mockImplementationOnce(async () => {
      await providerGate;
      return {
        status: "verified",
        evidence: {
          url: "https://storage.example/object",
          etag: "etag-1",
          versionId: "version-1",
        },
      };
    });

    let systemTransactionFinished = false;
    mocks.withSystem.mockImplementationOnce(async (_db, fn) => {
      const result = await fn(mocks.tx);
      systemTransactionFinished = true;
      return result;
    });

    const responsePromise = call(TOKEN, pngFile());
    await vi.waitFor(() => {
      expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledTimes(1);
    });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledTimes(1);
    expect(systemTransactionFinished).toBe(false);

    releaseProvider();
    expect((await responsePromise).status).toBe(201);
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledTimes(1);
    expect(systemTransactionFinished).toBe(true);
  });

  it("supports capture sessions without an appointment while retaining patient binding", async () => {
    queueValidContext({ appointmentId: null });
    mocks.reserveManagedUpload.mockImplementationOnce(async (_tx, input) =>
      mocks.reservation({ appointmentId: null, ...input }),
    );
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(201);
    expect(mocks.reserveManagedUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patientId: mocks.patientId,
        appointmentId: null,
      }),
    );
  });

  it("enforces a hard 20-photo session cap but permits an idempotent replay", async () => {
    queueValidContext({ usage: { count: 20, replayCount: 0 } });
    const capped = await call(TOKEN, pngFile());
    expect(capped.status).toBe(409);
    await expect(capped.json()).resolves.toEqual({
      error: "This capture link has reached its 20-photo limit",
    });
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();

    queueValidContext({ usage: { count: 20, replayCount: 1 } });
    mocks.reserveManagedUpload.mockResolvedValueOnce(
      mocks.reservation({ created: false, storageStatus: "available" }),
    );
    const replay = await call(TOKEN, pngFile());
    expect(replay.status).toBe(200);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("fails closed when an idempotency replay resolves to a tombstoned manifest", async () => {
    queueValidContext();
    mocks.reserveManagedUpload.mockRejectedValueOnce(
      new mocks.ManagedUploadConflictError(
        "Upload reservation is not retryable from state: deleted",
      ),
    );

    const response = await call(TOKEN, pngFile());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Upload reservation is not retryable from state: deleted",
    });
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("leaves ambiguous provider outcomes retryable without finalizing", async () => {
    queueValidContext();
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "unavailable",
    });
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("marks a checksum-mismatched object corrupt and does not finalize it", async () => {
    queueValidContext();
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    });
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(503);
    expect(mocks.markManagedUploadCorrupt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: mocks.fileId }),
    );
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("fails closed when quarantine loses the exact reservation generation", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    queueValidContext();
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    });
    mocks.markManagedUploadCorrupt.mockResolvedValueOnce(false);

    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(500);
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[capture] managed upload failed",
    );
    consoleError.mockRestore();
  });

  it("locks the capture row and filters exact patient, creator, and visit ownership", () => {
    expect(ROUTE_SOURCE).toContain('.for("update")');
    expect(ROUTE_SOURCE).toContain('eq(patients.status, "active")');
    expect(ROUTE_SOURCE).toContain("eq(users.practiceId, session.practiceId)");
    expect(ROUTE_SOURCE).toContain(
      "eq(appointments.patientId, session.patientId)",
    );
    expect(ROUTE_SOURCE).toContain("source = `capture:${session.id}`");
    expect(ROUTE_SOURCE).toContain("CAPTURE_SESSION_FILE_LIMIT = 20");
    expect(ROUTE_SOURCE).toContain("eq(practices.recoveryHold, false)");
    expect(ROUTE_SOURCE).toContain("readRequestBytesWithLimit(");
    const postSource = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf("async function handlePost("),
      ROUTE_SOURCE.indexOf("export async function POST("),
    );
    expect(postSource).toContain("return withSystem(db, async (systemTx) => {");
    expect(
      postSource.indexOf("lockPracticeForExternalSideEffects("),
    ).toBeLessThan(postSource.indexOf("readRequestBytesWithLimit("));
    expect(postSource.lastIndexOf("});")).toBeGreaterThan(
      postSource.indexOf("queueManagedUploadReplication("),
    );
    expect(ROUTE_SOURCE).toContain(
      'response.headers.set("Cache-Control", "private, no-store, max-age=0")',
    );
    expect(ROUTE_SOURCE).toContain('export const dynamic = "force-dynamic"');
  });
});
