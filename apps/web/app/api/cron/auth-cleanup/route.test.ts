import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
  cleanupExpiredAuthArtifacts: vi.fn(async () => ({
    deleted: 10,
    authTokensDeleted: 2,
    sessionsDeleted: 3,
    verificationTokensDeleted: 1,
    portalSessionsDeleted: 4,
    cutoff: new Date("2026-06-28T04:45:00Z"),
  })),
  cronAuthError: vi.fn(() => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth-tokens", () => ({
  cleanupExpiredAuthArtifacts: mocks.cleanupExpiredAuthArtifacts,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { GET } = await import("./route");

afterEach(() => {
  vi.clearAllMocks();
  mocks.cleanupExpiredAuthArtifacts.mockResolvedValue({
    deleted: 10,
    authTokensDeleted: 2,
    sessionsDeleted: 3,
    verificationTokensDeleted: 1,
    portalSessionsDeleted: 4,
    cutoff: new Date("2026-06-28T04:45:00Z"),
  });
});

describe("auth cleanup cron", () => {
  it("requires cron authorization before deleting auth artifacts", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/auth-cleanup")
    );

    expect(response.status).toBe(401);
    expect(mocks.cleanupExpiredAuthArtifacts).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("deletes expired auth artifacts and reports heartbeat metrics", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/auth-cleanup")
    );

    await expect(response.json()).resolves.toEqual({
      deleted: 10,
      authTokensDeleted: 2,
      sessionsDeleted: 3,
      verificationTokensDeleted: 1,
      portalSessionsDeleted: 4,
      cutoff: "2026-06-28T04:45:00.000Z",
    });
    expect(mocks.cleanupExpiredAuthArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "auth-cleanup",
      status: "ok",
      detail: "10 expired auth artifacts deleted",
      metrics: {
        deleted: 10,
        authTokensDeleted: 2,
        sessionsDeleted: 3,
        verificationTokensDeleted: 1,
        portalSessionsDeleted: 4,
      },
    });
  });

  it("alerts and reports failed heartbeat when cleanup crashes", async () => {
    mocks.cleanupExpiredAuthArtifacts.mockRejectedValueOnce(
      new Error("database unavailable")
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/auth-cleanup")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Auth cleanup failed",
      "database unavailable"
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "auth-cleanup",
      status: "failed",
      detail: "database unavailable",
    });
  });
});
