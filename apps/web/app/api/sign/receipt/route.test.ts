import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const capabilityId = "00000000-0000-0000-0000-000000000002";
  const consentRequestId = "00000000-0000-0000-0000-000000000003";
  const fileId = "00000000-0000-0000-0000-000000000004";
  const pdf = Buffer.from("%PDF-1.4\nexact signed receipt\n%%EOF");
  const checksum = "a".repeat(64);
  const metadata = {
    consentRequestId,
    fileId,
    fileName: "signed-consent.pdf",
    fileKey: `${practiceId}/consents/${fileId}`,
    objectVersionId: "version-1",
    checksum,
    size: pdf.length,
    claimCount: 1,
  };
  const selectResults: unknown[][] = [];
  const updateResults: unknown[][] = [];
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
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => updateResults.shift() ?? []),
      })),
    })),
  }));
  const insertValues = vi.fn(async () => undefined);
  const tx = {
    select,
    update,
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    practiceId,
    capabilityId,
    pdf,
    metadata,
    selectResults,
    updateResults,
    insertValues,
    tx,
    activeTenantTransactions: 0,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
    withTenant: vi.fn(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown,
      ) => {
        mocks.activeTenantTransactions += 1;
        try {
          return await fn(tx);
        } finally {
          mocks.activeTenantTransactions -= 1;
        }
      },
    ),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 5,
      resetAt: new Date(Date.now() + 60_000),
    })),
    readPrimaryObject: vi.fn(async () => ({
      status: "available" as const,
      body: pdf,
      contentType: "application/pdf",
      versionId: "version-1",
    })),
    checksumSha256Hex: vi.fn((body: Uint8Array) =>
      Buffer.from(body).equals(pdf) ? checksum : "b".repeat(64),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    rateLimit: mocks.rateLimit,
    rateLimitResponseHeaders: actual.rateLimitResponseHeaders,
  };
});
vi.mock("@/lib/s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/s3")>();
  return { ...actual, readPrimaryObject: mocks.readPrimaryObject };
});
vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: mocks.checksumSha256Hex,
}));

const { POST } = await import("./route");
const TOKEN = "cd".repeat(32);

function request(token: unknown = TOKEN) {
  return new Request("https://openvpm.test/api/sign/receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receiptToken: token }),
  }) as never;
}

function queueHappyClaim() {
  mocks.selectResults.push(
    [{ practiceId: mocks.practiceId }],
    [mocks.metadata],
  );
  mocks.updateResults.push([{ id: mocks.capabilityId }]);
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.updateResults.length = 0;
  mocks.activeTenantTransactions = 0;
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 5,
    resetAt: new Date(Date.now() + 60_000),
  });
  mocks.readPrimaryObject.mockResolvedValue({
    status: "available",
    body: mocks.pdf,
    contentType: "application/pdf",
    versionId: "version-1",
  });
});

describe("POST /api/sign/receipt", () => {
  it("rejects malformed credentials generically before database or storage", async () => {
    const response = await POST(request("short"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("fails generically when the distributed rate limiter is unavailable", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.readPrimaryObject).not.toHaveBeenCalled();
  });

  it("claims first, releases the transaction, then returns only exact PDF bytes", async () => {
    queueHappyClaim();
    mocks.readPrimaryObject.mockImplementationOnce(async () => {
      expect(mocks.activeTenantTransactions).toBe(0);
      return {
        status: "available",
        body: mocks.pdf,
        contentType: "application/pdf",
        versionId: "version-1",
      };
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mocks.pdf);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "download_claim",
        entityType: "consent_receipt",
        changes: expect.not.objectContaining({ token: expect.anything() }),
      }),
    );
  });

  it("consumes a claim but fails closed on an integrity mismatch", async () => {
    queueHappyClaim();
    mocks.readPrimaryObject.mockResolvedValueOnce({
      status: "available",
      body: Buffer.from("%PDF-1.4\nwrong\n%%EOF"),
      contentType: "application/pdf",
      versionId: "version-1",
    });

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.insertValues).toHaveBeenCalledOnce();
  });

  it("lets one atomic claimant read while a concurrent exhausted claim fails", async () => {
    mocks.selectResults.push(
      [{ practiceId: mocks.practiceId }],
      [mocks.metadata],
      [{ practiceId: mocks.practiceId }],
    );
    mocks.updateResults.push([{ id: mocks.capabilityId }], []);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.readPrimaryObject.mockImplementationOnce(async () => {
      await providerGate;
      return {
        status: "available",
        body: mocks.pdf,
        contentType: "application/pdf",
        versionId: "version-1",
      };
    });

    const winner = POST(request());
    await vi.waitFor(() => expect(mocks.readPrimaryObject).toHaveBeenCalled());
    const loser = await POST(request());
    expect(loser.status).toBe(404);
    releaseProvider();
    expect((await winner).status).toBe(200);
  });

  it("keeps the bearer out of paths, query strings, storage calls, and logs", () => {
    expect(SOURCE).not.toContain("searchParams");
    expect(SOURCE).not.toContain("console.");
    expect(SOURCE).toContain("hashConsentReceiptToken(token)");
    expect(SOURCE).toContain("readPrimaryObject(claimed.fileKey");
  });
});
