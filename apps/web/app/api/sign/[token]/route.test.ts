import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const practiceId = "00000000-0000-0000-0000-000000000001";
  const patientId = "00000000-0000-0000-0000-000000000002";
  const createdBy = "00000000-0000-0000-0000-000000000003";
  const fileId = "00000000-0000-0000-0000-000000000004";
  const consentId = "00000000-0000-0000-0000-000000000005";
  const signedAt = new Date("2026-07-10T12:00:00.000Z");
  const signaturePngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const signatureSha256 = "a".repeat(64);

  const consentRow = (overrides: Record<string, unknown> = {}) => {
    const status =
      typeof overrides.status === "string" ? overrides.status : "pending";
    return {
      id: consentId,
      practiceId,
      patientId,
      createdBy,
      appointmentId: null,
      tokenHash: null,
      title: "Consent to treatment",
      bodyText: "I agree to treatment for my pet.",
      status,
      signerName: null,
      signedAt: status === "pending" ? null : new Date(),
      signaturePngBytes: status === "pending" ? null : signaturePngBytes,
      signatureSha256: status === "pending" ? null : signatureSha256,
      signatureMethod: status === "pending" ? null : "drawn",
      signerAttestationVersion:
        status === "pending" ? null : "owner-authority-v1",
      documentRenderVersion: status === "pending" ? null : "consent-pdf-v2",
      storageLeaseToken: null,
      storageLeaseExpiresAt: null,
      fileId: null,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      patientName: "Peanut",
      practiceName: "Drill Vet",
      tier: "free",
      billingStatus: "trialing",
      trialEndsAt: new Date("2099-01-01T00:00:00Z"),
      ...overrides,
    };
  };

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
  const updateReturning = vi.fn(
    async () => updateReturningResults.shift() ?? [],
  );
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const executeResults: unknown[] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const tx = { select, insert, update, execute };

  const reservation = {
    id: fileId,
    practiceId,
    uploadedBy: createdBy,
    idempotencyKey: consentId,
    fileName: "signed-consent-00000000.pdf",
    fileKey: `${practiceId}/consents/${fileId}`,
    fileUrl: `/api/files/${practiceId}/consents/${fileId}`,
    mimeType: "application/pdf",
    fileSizeBytes: 2_000,
    checksumSha256: "a".repeat(64),
    storageStatus: "pending_upload",
    category: "consents",
    source: "consent_signature",
    entityType: "patient",
    entityId: patientId,
    patientId,
    appointmentId: null,
    created: true,
  };

  class ManagedUploadConflictError extends Error {}

  return {
    practiceId,
    patientId,
    createdBy,
    fileId,
    consentId,
    signedAt,
    signaturePngBytes,
    signatureSha256,
    tx,
    consentRow,
    selectResults,
    executeResults,
    updateReturningResults,
    updateReturning,
    updateSet,
    insertValues,
    reservation,
    ManagedUploadConflictError,
    reserveManagedUpload: vi.fn(async () => reservation),
    putAndVerifyManagedUpload: vi.fn(
      async (): Promise<
        | {
            status: "verified";
            evidence: { etag: string; versionId: string };
          }
        | { status: "unavailable" }
        | { status: "corrupt" }
      > => ({
        status: "verified",
        evidence: { etag: "etag-1", versionId: "version-1" },
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
    checksumSha256Hex: vi.fn((body: Uint8Array) =>
      Buffer.from(body).equals(signaturePngBytes)
        ? signatureSha256
        : "b".repeat(64),
    ),
    readRequestBytesWithLimit: vi.fn(),
    finalizeTreatmentPlanResponseForConsent: vi.fn(async () => null),
    treatmentPlanClientDecisionsEnabled: vi.fn(() => false),
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
vi.mock("@/lib/managed-file-upload", () => ({
  ManagedUploadConflictError: mocks.ManagedUploadConflictError,
  reserveManagedUpload: mocks.reserveManagedUpload,
  putAndVerifyManagedUpload: mocks.putAndVerifyManagedUpload,
  finalizeManagedUploadManifest: mocks.finalizeManagedUploadManifest,
  markManagedUploadCorrupt: mocks.markManagedUploadCorrupt,
  queueManagedUploadReplication: mocks.queueManagedUploadReplication,
}));
vi.mock("@/lib/file-replication", () => ({
  checksumSha256Hex: mocks.checksumSha256Hex,
}));
vi.mock("@/lib/treatment-plan-presentations/finalize", () => ({
  finalizeTreatmentPlanResponseForConsent:
    mocks.finalizeTreatmentPlanResponseForConsent,
}));
vi.mock("@/lib/treatment-plan-presentations/policy", () => ({
  treatmentPlanClientDecisionsEnabled:
    mocks.treatmentPlanClientDecisionsEnabled,
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

const { GET, POST } = await import("./route");

const TOKEN = "ab".repeat(32);
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const CHANGED_VALID_SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function signatureDataUrlWithDimensions(width: number, height: number) {
  const bytes = Buffer.from(
    SIGNATURE_DATA_URL.slice("data:image/png;base64,".length),
    "base64",
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function corruptSignatureDataUrl() {
  const bytes = Buffer.from(mocks.signaturePngBytes);
  bytes[40] = bytes[40]! ^ 1;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function signRequest(tokenParam: string, body?: unknown) {
  return new Request(`https://openvpm.test/api/sign/${tokenParam}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{" : JSON.stringify(body),
  }) as never;
}

function callPost(tokenParam: string, body?: unknown) {
  return POST(signRequest(tokenParam, body), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

function callGet(tokenParam: string) {
  return GET(
    new Request(`https://openvpm.test/api/sign/${tokenParam}`) as never,
    { params: Promise.resolve({ token: tokenParam }) },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    signerName: "Jordan Marsh",
    signaturePngDataUrl: SIGNATURE_DATA_URL,
    signerAuthorityAccepted: true,
    ...overrides,
  };
}

function queueHappyPending(signatureMethod: "drawn" | "typed" = "drawn") {
  mocks.selectResults.push([mocks.consentRow()]);
  mocks.executeResults.push([{ finalized: true }]);
  mocks.updateReturningResults.push(
    [
      {
        signerName: "Jordan Marsh",
        signedAt: mocks.signedAt,
        signaturePngBytes: mocks.signaturePngBytes,
        signatureSha256: mocks.signatureSha256,
        signatureMethod,
        signerAttestationVersion: "owner-authority-v1",
        documentRenderVersion: "consent-pdf-v2",
      },
    ],
    [{ id: mocks.consentId }],
    [{ token: "00000000-0000-4000-8000-000000000099" }],
    [{ id: mocks.consentId }],
  );
}

function queueHappySigning() {
  mocks.executeResults.push([{ finalized: true }]);
  mocks.updateReturningResults.push(
    [{ id: mocks.consentId }],
    [{ token: "00000000-0000-4000-8000-000000000099" }],
    [{ id: mocks.consentId }],
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.executeResults.length = 0;
  mocks.updateReturningResults.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.withSystem.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
  );
  mocks.withTenant.mockImplementation(
    async (_db: unknown, _practiceId: string, fn: (tx: unknown) => unknown) =>
      fn(mocks.tx),
  );
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date("2026-07-10T13:00:00Z"),
  });
  mocks.reserveManagedUpload.mockResolvedValue(mocks.reservation);
  mocks.putAndVerifyManagedUpload.mockResolvedValue({
    status: "verified",
    evidence: { etag: "etag-1", versionId: "version-1" },
  });
  mocks.finalizeManagedUploadManifest.mockResolvedValue(true);
  mocks.finalizeTreatmentPlanResponseForConsent.mockResolvedValue(null);
  mocks.treatmentPlanClientDecisionsEnabled.mockReturnValue(false);
  mocks.queueManagedUploadReplication.mockResolvedValue(true);
});

describe("GET /api/sign/[token]", () => {
  it("404s malformed tokens before doing any work", async () => {
    const res = await callGet("short");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("returns full content only while pending and minimizes terminal states", async () => {
    mocks.selectResults.push([mocks.consentRow({ status: "pending" })]);
    const pending = await callGet(TOKEN);
    await expect(pending.json()).resolves.toEqual({
      status: "pending",
      title: "Consent to treatment",
      bodyText: "I agree to treatment for my pet.",
      patientName: "Peanut",
      practiceName: "Drill Vet",
    });

    mocks.selectResults.push([mocks.consentRow({ status: "signing" })]);
    const signing = await callGet(TOKEN);
    await expect(signing.json()).resolves.toEqual({ status: "signing" });

    mocks.selectResults.push([
      mocks.consentRow({ status: "signed", signerName: "Jordan Marsh" }),
    ]);
    const signed = await callGet(TOKEN);
    await expect(signed.json()).resolves.toEqual({ status: "signed" });
    expect(signed.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("allows only bounded incomplete recovery after the original expiry", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      }),
    ]);
    await expect((await callGet(TOKEN)).json()).resolves.toEqual({
      status: "signing",
    });

    mocks.selectResults.push([
      mocks.consentRow({
        status: "signed",
        signerName: "Jordan Marsh",
        signedAt: mocks.signedAt,
        fileId: mocks.fileId,
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      }),
    ]);
    const signed = await callGet(TOKEN);
    expect(signed.status).toBe(404);
    await expect(signed.json()).resolves.toEqual({ error: "Not found" });
  });

  it("rate-limits shaped tokens before generic database misses", async () => {
    for (const _state of ["missing", "deleted", "recovery-held"]) {
      mocks.selectResults.push([]);
      const missing = await callGet(TOKEN);
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.rateLimit).toHaveBeenCalledTimes(6);

    mocks.selectResults.push([mocks.consentRow()]);
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const limited = await callGet(TOKEN);
    expect(limited.status).toBe(429);
  });

  it("fails closed after rate limiting when recovery wins after lookup", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    const response = await callGet(TOKEN);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledWith(
      expect.anything(),
      mocks.practiceId,
    );
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/sign/[token]", () => {
  it("rejects JSON null and arrays as invalid request bodies", async () => {
    for (const payload of [null, []]) {
      mocks.selectResults.push([mocks.consentRow()]);
      const response = await callPost(TOKEN, payload);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid JSON body",
      });
    }
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("resolves a live capability before validating JSON, signer, and PNG", async () => {
    expect((await callPost("nope", validBody())).status).toBe(404);
    mocks.selectResults.push([mocks.consentRow()]);
    expect((await callPost(TOKEN)).status).toBe(400);
    mocks.selectResults.push([mocks.consentRow()]);
    expect((await callPost(TOKEN, validBody({ signerName: " " }))).status).toBe(
      400,
    );
    mocks.selectResults.push([mocks.consentRow()]);
    expect(
      (
        await callPost(
          TOKEN,
          validBody({ signaturePngDataUrl: "data:image/png;base64,YmFk" }),
        )
      ).status,
    ).toBe(400);
    mocks.selectResults.push([mocks.consentRow()]);
    expect(
      (
        await callPost(
          TOKEN,
          validBody({ signaturePngDataUrl: corruptSignatureDataUrl() }),
        )
      ).status,
    ).toBe(400);
    mocks.selectResults.push([mocks.consentRow()]);
    expect(
      (
        await callPost(
          TOKEN,
          validBody({
            signaturePngDataUrl: signatureDataUrlWithDimensions(20_000, 1),
          }),
        )
      ).status,
    ).toBe(400);
    mocks.selectResults.push([mocks.consentRow()]);
    expect(
      (
        await callPost(
          TOKEN,
          validBody({
            signaturePngDataUrl: signatureDataUrlWithDimensions(2_000, 2_000),
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.withSystem).toHaveBeenCalledTimes(6);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("requires an explicit owner or authorized-agent acknowledgement", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    const response = await callPost(
      TOKEN,
      validBody({ signerAuthorityAccepted: false }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Please confirm you are authorized to sign",
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("uses hashed token and IP rate-limit keys", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    await callPost(TOKEN, validBody());
    const keys = (
      mocks.rateLimit.mock.calls as unknown as [{ key: string }][]
    ).map((call) => call[0].key);
    expect(keys.some((key) => key.startsWith("consent-sign:ip:"))).toBe(true);
    expect(keys.some((key) => key.startsWith("consent-sign:token:"))).toBe(
      true,
    );
    expect(keys.every((key) => !key.includes(TOKEN))).toBe(true);
  });

  it("hides missing, deleted, and recovery-held practices before body or provider work", async () => {
    for (const _state of ["missing", "deleted", "recovery-held"]) {
      mocks.selectResults.push([]);
      const response = await callPost(TOKEN, validBody());
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe(
        "private, no-store, max-age=0",
      );
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
    }
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(6);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("fails closed before body or provider work when recovery wins after lookup", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    const response = await callPost(TOKEN, validBody());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledWith(
      expect.anything(),
      mocks.practiceId,
    );
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("rejects an expired pending request before reading or claiming evidence", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "pending",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      }),
    ]);
    const response = await callPost(TOKEN, validBody());
    expect(response.status).toBe(404);
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("does not claim evidence when body reading crosses capability expiry", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.selectResults.push([
      mocks.consentRow({ status: "pending", expiresAt }),
    ]);

    let bodyReadStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    mocks.readRequestBytesWithLimit.mockImplementationOnce(async () => {
      bodyReadStarted();
      await bodyGate;
      return {
        ok: true,
        bytes: Buffer.from(JSON.stringify(validBody())),
      };
    });

    const responsePromise = callPost(TOKEN, validBody());
    await bodyStarted;
    vi.setSystemTime(new Date(expiresAt.getTime() + 1));
    releaseBody();

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("fails closed when expiry wins at the atomic pending claim", async () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.selectResults.push([
      mocks.consentRow({ status: "pending", expiresAt }),
    ]);
    // The database update returns no row when its wall-clock expiry CAS loses,
    // even though application validation ran while the capability was live.
    mocks.updateReturningResults.push([]);

    let claimTransactionStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      claimTransactionStarted = resolve;
    });
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    mocks.withTenant.mockImplementationOnce(async (_db, _practiceId, fn) => {
      claimTransactionStarted();
      await claimGate;
      return fn(mocks.tx);
    });

    const responsePromise = callPost(TOKEN, validBody());
    await claimStarted;
    expect(mocks.updateSet).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(expiresAt.getTime() + 1));
    releaseClaim();

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("hides unknown, orphaned, billing-blocked, and invalid-state requests", async () => {
    mocks.selectResults.push([]);
    expect((await callPost(TOKEN, validBody())).status).toBe(404);

    mocks.selectResults.push([mocks.consentRow({ createdBy: null })]);
    expect((await callPost(TOKEN, validBody())).status).toBe(404);

    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    mocks.selectResults.push([mocks.consentRow()]);
    expect((await callPost(TOKEN, validBody())).status).toBe(404);
    mocks.billingEnforced.mockReturnValue(false);

    mocks.selectResults.push([mocks.consentRow({ status: "cancelled" })]);
    expect((await callPost(TOKEN, validBody())).status).toBe(404);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("claims pending before render/reservation/PUT, binds the manifest, and commits once", async () => {
    queueHappyPending();
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(res.json()).resolves.toEqual({
      ok: true,
      receiptToken: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expect(mocks.updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: expect.anything(),
        signaturePngBytes: mocks.signaturePngBytes,
        signatureSha256: mocks.signatureSha256,
        signatureMethod: "drawn",
        signerAttestationVersion: "owner-authority-v1",
        documentRenderVersion: "consent-pdf-v2",
      }),
    );
    expect(mocks.reserveManagedUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: mocks.consentId,
        category: "consents",
        source: "consent_signature",
        patientId: mocks.patientId,
      }),
    );
    expect(mocks.updateSet).toHaveBeenNthCalledWith(2, {
      fileId: mocks.fileId,
    });
    expect(mocks.updateReturning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserveManagedUpload.mock.invocationCallOrder[0]!,
    );
    expect(mocks.updateReturning.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.putAndVerifyManagedUpload.mock.invocationCallOrder[0]!,
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

    const pdf = (
      mocks.putAndVerifyManagedUpload.mock.calls as unknown as [
        { body: Buffer },
      ][]
    )[0][0].body;
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: mocks.practiceId,
        userId: null,
        action: "sign",
        entityType: "consent",
        entityId: mocks.consentId,
        ipAddress: "unknown",
        changes: expect.objectContaining({
          actorType: "client",
          provenance: "public_consent_capability",
          signerAuthorityAccepted: true,
          signerAttestationVersion: "owner-authority-v1",
          documentRenderVersion: "consent-pdf-v2",
          dispatchedByUserId: mocks.createdBy,
          signatureSha256: mocks.signatureSha256,
        }),
      }),
    );
    expect(mocks.queueManagedUploadReplication).toHaveBeenCalledTimes(1);
  });

  it("persists typed signatures as the same validated PNG evidence", async () => {
    queueHappyPending("typed");

    const response = await callPost(
      TOKEN,
      validBody({ signatureMethod: "typed" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        signatureMethod: "typed",
        signaturePngBytes: mocks.signaturePngBytes,
        signatureSha256: mocks.signatureSha256,
      }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sign",
        changes: expect.objectContaining({ signatureMethod: "typed" }),
      }),
    );
  });

  it("rejects unknown signature methods before claiming evidence", async () => {
    mocks.selectResults.push([mocks.consentRow()]);

    const response = await callPost(
      TOKEN,
      validBody({ signatureMethod: "voice" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("releases every database connection before provider I/O", async () => {
    queueHappyPending();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.putAndVerifyManagedUpload.mockImplementationOnce(async () => {
      await providerGate;
      return {
        status: "verified",
        evidence: { etag: "etag-1", versionId: "version-1" },
      };
    });

    let systemTransactionFinished = false;
    mocks.withSystem.mockImplementationOnce(async (_db, fn) => {
      const result = await fn(mocks.tx);
      systemTransactionFinished = true;
      return result;
    });
    let activeTenantTransactions = 0;
    let maxTenantTransactions = 0;
    mocks.withTenant.mockImplementation(async (_db, _practiceId, fn) => {
      activeTenantTransactions += 1;
      maxTenantTransactions = Math.max(
        maxTenantTransactions,
        activeTenantTransactions,
      );
      try {
        return await fn(mocks.tx);
      } finally {
        activeTenantTransactions -= 1;
      }
    });

    const responsePromise = callPost(TOKEN, validBody());
    await vi.waitFor(() => {
      expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledTimes(1);
    });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledTimes(4);
    expect(systemTransactionFinished).toBe(true);
    expect(activeTenantTransactions).toBe(0);
    expect(maxTenantTransactions).toBe(1);

    releaseProvider();
    expect((await responsePromise).status).toBe(201);
    expect(mocks.finalizeManagedUploadManifest).toHaveBeenCalledTimes(1);
    expect(activeTenantTransactions).toBe(0);
    expect(maxTenantTransactions).toBe(1);
  });

  it("makes the compare-and-swap loser exit before reservation or provider I/O", async () => {
    mocks.selectResults.push([mocks.consentRow()]);
    mocks.updateReturningResults.push([]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("resumes stale signing state with persisted signer and timestamp", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      }),
    ]);
    queueHappySigning();

    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(201);
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ signerName: "Jordan Marsh" }),
    );
    expect(mocks.reserveManagedUpload).toHaveBeenCalledTimes(1);
    expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledTimes(1);
  });

  it("upgrades a live legacy in-progress signature only after fresh authority acknowledgement", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        signerAttestationVersion: null,
        fileId: mocks.fileId,
      }),
    ]);
    mocks.updateReturningResults.push(
      [{ signerAttestationVersion: "owner-authority-v1" }],
      [{ id: mocks.consentId }],
      [{ token: "00000000-0000-4000-8000-000000000099" }],
      [{ id: mocks.consentId }],
    );
    mocks.executeResults.push([{ finalized: true }]);

    const response = await callPost(TOKEN, {
      resume: true,
      signerAuthorityAccepted: true,
    });

    expect(response.status).toBe(201);
    expect(mocks.updateSet).toHaveBeenNthCalledWith(1, {
      signerAttestationVersion: "owner-authority-v1",
    });
    expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledTimes(1);
  });

  it("does not retrofit authority evidence after a legacy signing link expires", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        signerAttestationVersion: null,
        expiresAt: new Date("2000-01-01T00:00:00Z"),
        fileId: mocks.fileId,
      }),
    ]);

    const response = await callPost(TOKEN, {
      resume: true,
      signerAuthorityAccepted: true,
    });

    expect(response.status).toBe(404);
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("rejects expired incomplete signing after the bounded recovery window", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(Date.now() - 16 * 60 * 1000),
        expiresAt: new Date("2000-01-01T00:00:00Z"),
        fileId: mocks.fileId,
      }),
    ]);

    const response = await callPost(TOKEN, { resume: true });

    expect(response.status).toBe(404);
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("keeps digest-only treatment-plan signing dark with the default-off flag", async () => {
    mocks.selectResults.push([
      mocks.consentRow({ tokenHash: "d".repeat(64), token: null }),
    ]);

    expect((await callPost(TOKEN, validBody())).status).toBe(404);
    expect(mocks.treatmentPlanClientDecisionsEnabled).toHaveBeenCalledOnce();
    expect(mocks.readRequestBytesWithLimit).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("resumes persisted signing evidence after expiry without accepting new bytes", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      }),
    ]);
    queueHappySigning();

    const res = await callPost(TOKEN, { resume: true });
    expect(res.status).toBe(201);
    expect(mocks.reserveManagedUpload).toHaveBeenCalledTimes(1);
    expect(mocks.putAndVerifyManagedUpload).toHaveBeenCalledTimes(1);
    expect(mocks.checksumSha256Hex).not.toHaveBeenCalledWith(
      mocks.signaturePngBytes,
    );
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({
        signerName: expect.anything(),
        signaturePngBytes: expect.anything(),
        signatureSha256: expect.anything(),
      }),
    );
  });

  it("rejects replacement signature bytes after expiry; only resume may replay", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      }),
    ]);

    const response = await callPost(
      TOKEN,
      validBody({ signaturePngDataUrl: CHANGED_VALID_SIGNATURE_DATA_URL }),
    );
    expect(response.status).toBe(404);
    expect(mocks.readRequestBytesWithLimit).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("does not let a resume-only request create signing evidence", async () => {
    mocks.selectResults.push([mocks.consentRow({ status: "pending" })]);
    const res = await callPost(TOKEN, { resume: true });
    expect(res.status).toBe(404);
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("rejects changed retry bytes without replacing persisted signature evidence", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    const res = await callPost(
      TOKEN,
      validBody({ signaturePngDataUrl: CHANGED_VALID_SIGNATURE_DATA_URL }),
    );
    expect(res.status).toBe(409);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({
        signaturePngBytes: expect.anything(),
        signatureSha256: expect.anything(),
      }),
    );
  });

  it("treats even legacy signed rows as terminal without touching storage", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signed",
        signerName: "Jordan Marsh",
        signedAt: mocks.signedAt,
        signaturePngBytes: null,
        signatureSha256: null,
        fileId: mocks.fileId,
      }),
    ]);

    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(200);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("does not rewrite persisted signing identity on a mismatched retry", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "First Signer",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
  });

  it("leaves signing and its reservation retryable when PUT outcome is ambiguous", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    mocks.updateReturningResults.push(
      [{ id: mocks.consentId }],
      [{ token: "00000000-0000-4000-8000-000000000099" }],
    );
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "unavailable",
    });

    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
    expect(mocks.queueManagedUploadReplication).not.toHaveBeenCalled();
  });

  it("marks integrity failures without deleting possibly committed objects", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    mocks.updateReturningResults.push(
      [{ id: mocks.consentId }],
      [{ token: "00000000-0000-4000-8000-000000000099" }],
      [{ id: mocks.consentId }],
    );
    mocks.executeResults.push([{ released: true }]);
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    });
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(503);
    expect(mocks.markManagedUploadCorrupt).toHaveBeenCalledWith(
      expect.anything(),
      mocks.reservation,
    );
  });

  it("does not quarantine a newer attempt when a stale corrupt result loses its lease", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    mocks.updateReturningResults.push(
      [{ id: mocks.consentId }],
      [{ token: "00000000-0000-4000-8000-000000000099" }],
    );
    mocks.putAndVerifyManagedUpload.mockResolvedValueOnce({
      status: "corrupt",
    });
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(404);
    expect(mocks.markManagedUploadCorrupt).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("returns an idempotent terminal 200 without render, storage, or audit", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signed",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(200);
    expect(mocks.reserveManagedUpload).not.toHaveBeenCalled();
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.queueManagedUploadReplication).not.toHaveBeenCalled();
  });

  it("returns 409 when the durable reservation does not match retry bytes", async () => {
    mocks.selectResults.push([
      mocks.consentRow({
        status: "signing",
        signerName: "Jordan Marsh",
        signedAt: new Date(),
        fileId: mocks.fileId,
      }),
    ]);
    mocks.reserveManagedUpload.mockRejectedValueOnce(
      new mocks.ManagedUploadConflictError(),
    );
    const res = await callPost(TOKEN, validBody());
    expect(res.status).toBe(409);
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
  });

  it("fails closed before provider I/O when the consent manifest was tombstoned", async () => {
    queueHappyPending();
    mocks.reserveManagedUpload.mockRejectedValueOnce(
      new mocks.ManagedUploadConflictError(
        "Upload reservation is not retryable from state: deleted",
      ),
    );

    const response = await callPost(TOKEN, validBody());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This signing attempt does not match the in-progress request",
    });
    expect(mocks.putAndVerifyManagedUpload).not.toHaveBeenCalled();
    expect(mocks.finalizeManagedUploadManifest).not.toHaveBeenCalled();
  });

  it("checks capability shape, tenant liveness, expiry, and claim-before-render in source", () => {
    expect(ROUTE_SOURCE).toContain("isCaptureTokenShape(token)");
    expect(ROUTE_SOURCE).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain("eq(practices.recoveryHold, false)");
    expect(ROUTE_SOURCE).toContain("isNull(patients.deletedAt)");
    expect(ROUTE_SOURCE).toContain("gt(consentRequests.expiresAt, now)");
    expect(ROUTE_SOURCE).toContain(
      "gt(consentRequests.expiresAt, sql`clock_timestamp()`)",
    );
    expect(ROUTE_SOURCE).toContain("signedAt: sql`clock_timestamp()`");
    expect(ROUTE_SOURCE).toContain('eq(consentRequests.status, "pending")');
    const claimIndex = ROUTE_SOURCE.lastIndexOf("await claimSigning(");
    expect(claimIndex).toBeGreaterThan(0);
    expect(claimIndex).toBeLessThan(
      ROUTE_SOURCE.indexOf("buildConsentPdfForVersion(", claimIndex),
    );
    expect(ROUTE_SOURCE.indexOf("consentSignaturePngDecodes(")).toBeLessThan(
      claimIndex,
    );
    const renderSource = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf("const pdf = buildConsentPdfForVersion("),
      ROUTE_SOURCE.indexOf("const reservation = await reserveConsentFile"),
    );
    expect(renderSource).toContain("practiceId: signing.practiceId");
    expect(renderSource).toContain("patientId: signing.patientId");
    expect(renderSource).not.toContain("signing.practiceName");
    expect(renderSource).not.toContain("signing.patientName");
    const postSource = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf("async function handlePost("),
      ROUTE_SOURCE.indexOf("export async function GET("),
    );
    expect(postSource).toContain("const session = await withSystem(");
    expect(postSource.indexOf("enforceRateLimits(")).toBeLessThan(
      postSource.indexOf("withSystem("),
    );
    expect(
      postSource.indexOf("lockPracticeForExternalSideEffects("),
    ).toBeLessThan(postSource.indexOf("readRequestBytesWithLimit("));
    expect(
      postSource.indexOf("queueManagedUploadReplication("),
    ).toBeGreaterThan(postSource.lastIndexOf("withTenant("));
    expect(ROUTE_SOURCE).toContain("consentRequests.tokenHash");
    expect(ROUTE_SOURCE).toContain("hashConsentToken(token)");
    expect(ROUTE_SOURCE).toContain(
      'response.headers.set("Cache-Control", "private, no-store, max-age=0")',
    );
  });
});
