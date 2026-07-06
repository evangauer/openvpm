import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
  cronAuthError: vi.fn((): Response | null => null),
  reconcileUnmeteredUsage: vi.fn(async () => ({
    attempted: 2,
    metered: 2,
    skipped: 0,
  })),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/billing/usage", () => ({
  reconcileUnmeteredUsage: mocks.reconcileUnmeteredUsage,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));

const { GET } = await import("./route");

afterEach(() => {
  vi.clearAllMocks();
  mocks.cronAuthError.mockReturnValue(null);
  mocks.reconcileUnmeteredUsage.mockResolvedValue({
    attempted: 2,
    metered: 2,
    skipped: 0,
  });
});

describe("usage reconciliation cron", () => {
  it("requires cron authorization before touching usage records", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/usage-reconcile")
    );

    expect(response.status).toBe(401);
    expect(mocks.reconcileUnmeteredUsage).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("reconciles a bounded batch and reports ok heartbeat metrics", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/usage-reconcile")
    );

    await expect(response.json()).resolves.toEqual({
      attempted: 2,
      metered: 2,
      skipped: 0,
      failed: 0,
    });
    expect(mocks.reconcileUnmeteredUsage).toHaveBeenCalledWith({ limit: 250 });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "usage-reconcile",
      status: "ok",
      detail: "2 of 2 usage records metered",
      metrics: {
        attempted: 2,
        metered: 2,
        skipped: 0,
        failed: 0,
      },
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("reports degraded heartbeat and alerts when only part of the batch meters", async () => {
    mocks.reconcileUnmeteredUsage.mockResolvedValueOnce({
      attempted: 5,
      metered: 3,
      skipped: 0,
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/usage-reconcile")
    );

    await expect(response.json()).resolves.toEqual({
      attempted: 5,
      metered: 3,
      skipped: 0,
      failed: 2,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Usage reconciliation incomplete",
      "2 of 5 usage records were not metered."
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "usage-reconcile",
      status: "degraded",
      detail: "3 of 5 usage records metered",
      metrics: {
        attempted: 5,
        metered: 3,
        skipped: 0,
        failed: 2,
      },
    });
  });

  it("treats no-customer usage rows as skipped instead of failed", async () => {
    mocks.reconcileUnmeteredUsage.mockResolvedValueOnce({
      attempted: 5,
      metered: 3,
      skipped: 2,
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/usage-reconcile")
    );

    await expect(response.json()).resolves.toEqual({
      attempted: 5,
      metered: 3,
      skipped: 2,
      failed: 0,
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "usage-reconcile",
      status: "ok",
      detail: "3 of 5 usage records metered; 2 skipped",
      metrics: {
        attempted: 5,
        metered: 3,
        skipped: 2,
        failed: 0,
      },
    });
  });

  it("alerts and reports failed heartbeat when reconciliation crashes", async () => {
    mocks.reconcileUnmeteredUsage.mockRejectedValueOnce(
      new Error("stripe unavailable")
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/usage-reconcile")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Usage reconciliation failed",
      "stripe unavailable"
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "usage-reconcile",
      status: "failed",
      detail: "stripe unavailable",
    });
  });
});
