import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
  cronAuthError: vi.fn((): Response | null => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
  reconcileFileReplicas: vi.fn(async () => ({
    intended: true,
    required: true,
    configured: true,
    enabled: true,
    candidates: 1,
    claimed: 1,
    deferred: 0,
    copied: 1,
    alreadyPresent: 0,
    repairedPrimary: 0,
    sourceMissing: 0,
    sourceCorrupt: 0,
    failed: 0,
    bytesCopied: 3,
    backlog: 0,
    available: 1,
    activeFiles: 1,
    coveragePct: 100,
  })),
}));

vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/file-replication", () => ({
  reconcileFileReplicas: mocks.reconcileFileReplicas,
}));

const { GET } = await import("./route");

const request = () =>
  new Request("https://openvpm.test/api/cron/file-replicas");

afterEach(() => {
  vi.clearAllMocks();
  mocks.cronAuthError.mockReturnValue(null);
  mocks.reconcileFileReplicas.mockResolvedValue({
    intended: true,
    required: true,
    configured: true,
    enabled: true,
    candidates: 1,
    claimed: 1,
    deferred: 0,
    copied: 1,
    alreadyPresent: 0,
    repairedPrimary: 0,
    sourceMissing: 0,
    sourceCorrupt: 0,
    failed: 0,
    bytesCopied: 3,
    backlog: 0,
    available: 1,
    activeFiles: 1,
    coveragePct: 100,
  });
});

describe("file replica reconciliation cron", () => {
  it("requires cron authorization before starting reconciliation", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.reconcileFileReplicas).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("reports verified independent coverage", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "ok",
      detail: "1/1 active files independently available (100%)",
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "file-replicas",
      status: "ok",
      detail: "1/1 active files independently available (100%)",
      metrics: expect.objectContaining({ copied: 1, coveragePct: 100 }),
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("keeps an intentionally disabled rollout non-degraded", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: false,
      required: false,
      configured: false,
      enabled: false,
      candidates: 0,
      claimed: 0,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 0,
      sourceCorrupt: 0,
      failed: 0,
      bytesCopied: 0,
      backlog: 0,
      available: 0,
      activeFiles: 0,
      coveragePct: 0,
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "ok",
      detail: "Independent file replica rollout is not enabled",
    });
  });

  it("keeps a fully configured target staged until execution is explicitly enabled", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: true,
      required: false,
      configured: true,
      enabled: false,
      candidates: 0,
      claimed: 0,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 0,
      sourceCorrupt: 0,
      failed: 0,
      bytesCopied: 0,
      backlog: 0,
      available: 0,
      activeFiles: 0,
      coveragePct: 0,
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      detail:
        "Independent file replica target is staged but execution is disabled",
    });
  });

  it("degrades when replica protection is required but execution is disabled", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: true,
      required: true,
      configured: true,
      enabled: false,
      candidates: 0,
      claimed: 0,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 0,
      sourceCorrupt: 0,
      failed: 0,
      bytesCopied: 0,
      backlog: 0,
      available: 0,
      activeFiles: 0,
      coveragePct: 0,
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      detail: "Independent file replica is required but execution is disabled",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "File replica reconciliation degraded",
      "Independent file replica is required but execution is disabled.",
    );
  });

  it("degrades incomplete coverage after replica protection becomes required", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: true,
      required: true,
      configured: true,
      enabled: true,
      candidates: 0,
      claimed: 0,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 0,
      sourceCorrupt: 0,
      failed: 0,
      bytesCopied: 0,
      backlog: 1,
      available: 2,
      activeFiles: 3,
      coveragePct: 66.67,
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      metrics: { backlog: 1, coveragePct: 66.67 },
    });
  });

  it("reports an incomplete intended rollout as degraded", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: true,
      required: true,
      configured: false,
      enabled: true,
      candidates: 0,
      claimed: 0,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 0,
      sourceCorrupt: 0,
      failed: 0,
      bytesCopied: 0,
      backlog: 0,
      available: 0,
      activeFiles: 0,
      coveragePct: 0,
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      detail: "Independent file replica configuration is incomplete",
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ job: "file-replicas", status: "degraded" }),
    );
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("alerts and reports degraded state for failed or unrecoverable files", async () => {
    mocks.reconcileFileReplicas.mockResolvedValueOnce({
      intended: true,
      required: true,
      configured: true,
      enabled: true,
      candidates: 0,
      claimed: 3,
      deferred: 0,
      copied: 0,
      alreadyPresent: 0,
      repairedPrimary: 0,
      sourceMissing: 1,
      sourceCorrupt: 1,
      failed: 1,
      bytesCopied: 0,
      backlog: 3,
      available: 7,
      activeFiles: 10,
      coveragePct: 70,
    });

    const response = await GET(request());

    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      metrics: { failed: 1, sourceMissing: 1, sourceCorrupt: 1 },
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "File replica reconciliation degraded",
      "1 failed, 1 primary missing, 1 integrity mismatch, 3 in backlog, 70% independently available.",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ job: "file-replicas", status: "degraded" }),
    );
  });

  it("returns 500 and reports a failed heartbeat when the worker crashes", async () => {
    mocks.reconcileFileReplicas.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "File replica reconciliation crashed",
      "database unavailable",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "file-replicas",
      status: "failed",
      detail: "File replica reconciliation crashed",
    });
  });
});
