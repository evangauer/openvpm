import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
  cleanupExpiredRateLimitBuckets: vi.fn(async () => ({
    deleted: 3,
    cutoff: new Date("2026-06-28T04:30:00Z"),
  })),
  cronAuthError: vi.fn(() => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  cleanupExpiredRateLimitBuckets: mocks.cleanupExpiredRateLimitBuckets,
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
  mocks.cleanupExpiredRateLimitBuckets.mockResolvedValue({
    deleted: 3,
    cutoff: new Date("2026-06-28T04:30:00Z"),
  });
});

describe("rate-limit cleanup cron", () => {
  it("requires cron authorization before deleting buckets", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/rate-limit-cleanup")
    );

    expect(response.status).toBe(401);
    expect(mocks.cleanupExpiredRateLimitBuckets).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("deletes expired buckets and reports heartbeat metrics", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/rate-limit-cleanup")
    );

    await expect(response.json()).resolves.toEqual({
      deleted: 3,
      cutoff: "2026-06-28T04:30:00.000Z",
    });
    expect(mocks.cleanupExpiredRateLimitBuckets).toHaveBeenCalledTimes(1);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "rate-limit-cleanup",
      status: "ok",
      detail: "3 expired rate-limit buckets deleted",
      metrics: {
        deleted: 3,
      },
    });
  });

  it("alerts and reports failed heartbeat when cleanup crashes", async () => {
    mocks.cleanupExpiredRateLimitBuckets.mockRejectedValueOnce(
      new Error("database unavailable")
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/rate-limit-cleanup")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Rate-limit cleanup failed",
      "database unavailable"
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "rate-limit-cleanup",
      status: "failed",
      detail: "database unavailable",
    });
  });
});
