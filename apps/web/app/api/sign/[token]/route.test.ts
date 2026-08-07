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
  const consentId = "00000000-0000-0000-0000-000000000005";

  const consentRow = (overrides: Record<string, unknown> = {}) => ({
    id: consentId,
    practiceId,
    patientId,
    createdBy,
    title: "Consent to treatment",
    bodyText: "I agree to treatment for my pet.",
    status: "pending",
    signerName: null,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    patientName: "Peanut",
    practiceName: "Drill Vet",
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

  const updateReturningResults: unknown[][] = [];
  const updateReturning = vi.fn(async () => updateReturningResults.shift() ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertReturning = vi.fn(async () => [{ id: fileId }]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const tx = { select, insert, update };

  return {
    practiceId,
    patientId,
    createdBy,
    fileId,
    consentId,
    consentRow,
    selectResults,
    updateReturningResults,
    updateSet,
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

const { GET, POST } = await import("./route");

const TOKEN = "ab".repeat(32);
// 1x1 PNG (valid magic bytes, decodes as a real image).
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function signRequest(tokenParam: string, body?: unknown) {
  return new Request(`https://openvpm.test/api/sign/${tokenParam}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{" : JSON.stringify(body),
  }) as never;
}

function viewRequest(tokenParam: string) {
  return new Request(`https://openvpm.test/api/sign/${tokenParam}`) as never;
}

function callPost(tokenParam: string, body?: unknown) {
  return POST(signRequest(tokenParam, body), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

function callGet(tokenParam: string) {
  return GET(viewRequest(tokenParam), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    signerName: "Jordan Marsh",
    signaturePngDataUrl: SIGNATURE_DATA_URL,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.updateReturningResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date("2026-07-10T13:00:00Z"),
  });
  mocks.insertReturning.mockResolvedValue([{ id: mocks.fileId }]);
});

describe("GET /api/sign/[token]", () => {
  it("404s on malformed tokens before doing any work", async () => {
    for (const bad of ["short", "Z".repeat(64), "../etc", `${TOKEN}x`]) {
      const res = await callGet(bad);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("returns the consent content for a live token", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    const res = await callGet(TOKEN);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      title: "Consent to treatment",
      bodyText: "I agree to treatment for my pet.",
      patientName: "Peanut",
      practiceName: "Drill Vet",
      status: "pending",
      signerName: null,
    });
  });

  it("returns identical generic 404s for unknown and expired tokens", async () => {
    mocks.selectResults.push([]);
    const unknownRes = await callGet(TOKEN);
    mocks.selectResults.push([]);
    const expiredRes = await callGet(TOKEN);
    expect(unknownRes.status).toBe(404);
    expect(expiredRes.status).toBe(404);
    expect(await expiredRes.json()).toEqual(await unknownRes.json());
  });

  it("shows the signer name only once signed", async () => {
    mocks.selectResults.push([
      mocks.consentRow({ status: "signed", signerName: "Jordan Marsh" }),
    ]);
    const res = await callGet(TOKEN);
    const body = await res.json();
    expect(body.status).toBe("signed");
    expect(body.signerName).toBe("Jordan Marsh");
  });

  it("429s when a limit trips", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const res = await callGet(TOKEN);
    expect(res.status).toBe(429);
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });
});

describe("POST /api/sign/[token]", () => {
  it("404s on malformed tokens before doing any work", async () => {
    const res = await callPost("nope", validBody());
    expect(res.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rate limits both the token and the caller IP with a hashed token key", async () => {
    mocks.selectResults.push([]);
    await callPost(TOKEN, validBody());
    const keys = (
      mocks.rateLimit.mock.calls as unknown as [{ key: string }][]
    ).map((c) => c[0].key);
    expect(keys.some((k) => k.startsWith("consent-sign:ip:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("consent-sign:token:"))).toBe(true);
    expect(keys.every((k) => !k.includes(TOKEN))).toBe(true);
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await callPost(TOKEN);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("requires a signer name within bounds", async () => {
    for (const signerName of ["", "   ", "x".repeat(121)]) {
      const res = await callPost(TOKEN, validBody({ signerName }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Please type your full name",
      });
    }
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects signatures that are not PNG data URLs", async () => {
    for (const signaturePngDataUrl of [
      "",
      "data:image/jpeg;base64,abcd",
      "https://evil.test/sig.png",
      // Declared PNG but the bytes are HTML.
      `data:image/png;base64,${Buffer.from("<html></html>").toString("base64")}`,
    ]) {
      const res = await callPost(TOKEN, validBody({ signaturePngDataUrl }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "Please draw your signature",
      });
    }
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("returns identical generic 404s for unknown and expired tokens", async () => {
    mocks.selectResults.push([]);
    const unknownRes = await callPost(TOKEN, validBody());
    mocks.selectResults.push([]);
    const expiredRes = await callPost(TOKEN, validBody());
    expect(unknownRes.status).toBe(404);
    expect(expiredRes.status).toBe(404);
    expect(await expiredRes.json()).toEqual(await unknownRes.json());
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("404s generically on orphaned requests without a creator", async () => {
    mocks.selectResults.push([mocks.consentRow({ createdBy: null })]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("hides hosted read-only practices behind the same generic 404", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([
      mocks.consentRow({
        tier: "basic",
        billingStatus: "past_due",
        trialEndsAt: null,
      }),
    ]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("treats already-signed requests as a generic miss (single-use links)", async () => {
    mocks.selectResults.push([mocks.consentRow({ status: "signed" })]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("stores the signed PDF, claims the request, and audits the signing", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.updateReturningResults.push([{ id: mocks.consentId }]);

    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^${mocks.practiceId}/consents/.+\\.pdf$`)
      ),
      expect.any(Buffer),
      "application/pdf"
    );
    // The uploaded artifact really is a PDF.
    const pdfBuffer = (
      mocks.uploadFile.mock.calls as unknown as [string, Buffer, string][]
    )[0][1];
    expect(pdfBuffer.subarray(0, 4).toString()).toBe("%PDF");

    expect(mocks.withTenant).toHaveBeenCalledWith(
      expect.anything(),
      mocks.practiceId,
      expect.any(Function)
    );
    // Claim marks the row signed.
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "signed",
        signerName: "Jordan Marsh",
      })
    );
    // The file row links to the patient under the consents category.
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        uploadedBy: mocks.createdBy,
        mimeType: "application/pdf",
        category: "consents",
        entityType: "patient",
        entityId: mocks.patientId,
      })
    );
    // The audit row records the signing against the dispatching staff user.
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        userId: mocks.createdBy,
        action: "sign",
        entityType: "consent",
        entityId: mocks.consentId,
      })
    );
  });

  it("cleans up the uploaded PDF when a concurrent submission wins the claim", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.updateReturningResults.push([]); // claim misses: someone else won

    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${mocks.practiceId}/consents/.+\\.pdf$`))
    );
  });

  it("cleans up the uploaded PDF when persistence fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.updateReturningResults.push([{ id: mocks.consentId }]);
    mocks.insertReturning.mockRejectedValueOnce(new Error("db unavailable"));

    try {
      const res = await callPost(TOKEN, validBody());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Signing failed" });
      expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("checks the token shape, practice liveness, and expiry in source", () => {
    expect(ROUTE_SOURCE).toContain("isCaptureTokenShape(token)");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("gt(consentRequests.expiresAt, now)");
    expect(ROUTE_SOURCE).toContain("readRequestBytesWithLimit(");
    expect(ROUTE_SOURCE).toContain('export const dynamic = "force-dynamic"');
  });
});
