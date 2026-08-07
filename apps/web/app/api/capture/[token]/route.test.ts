import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8"
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const patientId = "00000000-0000-0000-0000-000000000002";
  const createdBy = "00000000-0000-0000-0000-000000000003";
  const fileId = "00000000-0000-0000-0000-000000000004";

  const captureSession = (overrides: Record<string, unknown> = {}) => ({
    id: "00000000-0000-0000-0000-000000000005",
    practiceId,
    patientId,
    createdBy,
    tier: "free",
    billingStatus: "trialing",
    trialEndsAt: new Date("2099-01-01T00:00:00Z"),
    ...overrides,
  });

  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insertReturning = vi.fn(async () => [{ id: fileId }]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const tx = { select, insert };

  return {
    practiceId,
    patientId,
    createdBy,
    fileId,
    captureSession,
    selectResults,
    insertValues,
    insertReturning,
    uploadFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
    withTenant: vi.fn(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown
      ) => fn(tx)
    ),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 10,
      resetAt: new Date("2026-07-10T13:00:00Z"),
    })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/s3", () => ({
  uploadFile: mocks.uploadFile,
  deleteFile: mocks.deleteFile,
}));
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

const { POST } = await import("./route");

const TOKEN = "ab".repeat(32);

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function captureRequest(tokenParam: string, file?: File) {
  const formData = new FormData();
  if (file) formData.append("file", file);

  return new Request(`https://openvpm.test/api/capture/${tokenParam}`, {
    method: "POST",
    body: formData,
  }) as never;
}

function call(tokenParam: string, file?: File) {
  return POST(captureRequest(tokenParam, file), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

function pngFile(name = "photo.png") {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date("2026-07-10T13:00:00Z"),
  });
  mocks.insertReturning.mockResolvedValue([{ id: mocks.fileId }]);
});

describe("POST /api/capture/[token]", () => {
  it("404s on malformed tokens before doing any work", async () => {
    for (const bad of ["short", "Z".repeat(64), "../etc", `${TOKEN}x`]) {
      const res = await call(bad, pngFile());
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("returns identical generic 404s for unknown and expired tokens (no validity oracle)", async () => {
    // Unknown token: the session lookup misses.
    mocks.selectResults.push([]);
    const unknownRes = await call(TOKEN, pngFile());

    // Expired token: the expiresAt > now predicate makes the lookup miss the
    // same way, so the route cannot tell (or reveal) the difference.
    mocks.selectResults.push([]);
    const expiredRes = await call(TOKEN, pngFile());

    expect(unknownRes.status).toBe(404);
    expect(expiredRes.status).toBe(404);
    const unknownBody = await unknownRes.json();
    const expiredBody = await expiredRes.json();
    expect(unknownBody).toEqual({ error: "Not found" });
    expect(expiredBody).toEqual(unknownBody);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("404s generically on orphaned sessions without a creator", async () => {
    mocks.selectResults.push([mocks.captureSession({ createdBy: null })]);
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("429s with rate-limit headers when a limit trips", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rate limits both the token and the caller IP with a hashed token key", async () => {
    mocks.selectResults.push([]);
    await call(TOKEN, pngFile());
    const keys = (
      mocks.rateLimit.mock.calls as unknown as [{ key: string }][]
    ).map((c) => c[0].key);
    expect(keys.some((k) => k.startsWith("capture-upload:ip:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("capture-upload:token:"))).toBe(true);
    // The raw token never appears in a rate-limit key (it is hashed).
    expect(keys.every((k) => !k.includes(TOKEN))).toBe(true);
  });

  it("hides hosted read-only practices behind the same generic 404", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([
      mocks.captureSession({
        tier: "basic",
        billingStatus: "past_due",
        trialEndsAt: null,
      }),
    ]);
    const res = await call(TOKEN, pngFile());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "basic",
      "past_due",
      null
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects missing file fields", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    const res = await call(TOKEN);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Missing file field" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects non-image uploads even when the type is otherwise allowed", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    const pdf = new File([new TextEncoder().encode("%PDF-1.7\n")], "lab.pdf", {
      type: "application/pdf",
    });
    const res = await call(TOKEN, pdf);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Capture uploads must be JPG, PNG, or WebP images",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects uploads whose bytes do not match the declared MIME type", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    const fake = new File([new TextEncoder().encode("<html></html>")], "fake.png", {
      type: "image/png",
    });
    const res = await call(TOKEN, fake);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "File contents do not match the declared file type",
    });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("stores a valid photo and links it to the session's patient", async () => {
    mocks.selectResults.push([mocks.captureSession()]);
    const res = await call(TOKEN, pngFile("side view.png"));

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      fileId: mocks.fileId,
    });
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${mocks.practiceId}/patient-photos/.+-side_view\\.png$`)
      ),
      expect.any(Buffer),
      "image/png"
    );
    expect(mocks.withTenant).toHaveBeenCalledWith(
      expect.anything(),
      mocks.practiceId,
      expect.any(Function)
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        uploadedBy: mocks.createdBy,
        fileName: "side view.png",
        mimeType: "image/png",
        category: "patient-photos",
        entityType: "patient",
        entityId: mocks.patientId,
      })
    );
  });

  it("cleans up the uploaded object when metadata persistence fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.selectResults.push([mocks.captureSession()]);
    mocks.insertReturning.mockRejectedValueOnce(new Error("db unavailable"));

    try {
      const res = await call(TOKEN, pngFile());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Upload failed" });
      expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
      expect(mocks.deleteFile).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^${mocks.practiceId}/patient-photos/.+-photo\\.png$`)
        )
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("checks the token shape and practice liveness in source", () => {
    expect(ROUTE_SOURCE).toContain("isCaptureTokenShape(token)");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("gt(captureSessions.expiresAt, now)");
    expect(ROUTE_SOURCE).toContain("readRequestBytesWithLimit(");
    expect(ROUTE_SOURCE).toContain('export const dynamic = "force-dynamic"');
  });
});
