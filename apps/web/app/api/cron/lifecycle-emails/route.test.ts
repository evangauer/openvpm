import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cronAuthError: vi.fn((): Response | null => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
  runLifecycleEmailBatch: vi.fn(),
}));

vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/billing/lifecycle-email-outbox", () => ({
  runLifecycleEmailBatch: mocks.runLifecycleEmailBatch,
}));

const { GET } = await import("./route");

const METRICS = {
  claimed: 2,
  errors: 0,
  delivered: 1,
  retried: 1,
  blocked: 0,
  suppressed: 0,
  failed: 0,
  outcomeUnknown: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cronAuthError.mockReturnValue(null);
  mocks.runLifecycleEmailBatch.mockResolvedValue(METRICS);
});

describe("lifecycle email cron", () => {
  it("authorizes before claiming cross-tenant jobs", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const response = await GET(
      new Request("https://openvpm.test/api/cron/lifecycle-emails"),
    );
    expect(response.status).toBe(401);
    expect(mocks.runLifecycleEmailBatch).not.toHaveBeenCalled();
  });

  it("runs the bounded worker and reports durable counts", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/lifecycle-emails"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(METRICS);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "lifecycle-emails",
      status: "ok",
      detail: "Durable subscription lifecycle email sweep completed",
      metrics: METRICS,
    });
  });

  it("reports a degraded heartbeat when a claimed job is contained", async () => {
    mocks.runLifecycleEmailBatch.mockResolvedValueOnce({
      ...METRICS,
      errors: 1,
    });
    const response = await GET(
      new Request("https://openvpm.test/api/cron/lifecycle-emails"),
    );
    expect(response.status).toBe(200);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ status: "degraded" }),
    );
  });

  it("reports a redacted failure without leaking the thrown detail", async () => {
    mocks.runLifecycleEmailBatch.mockRejectedValueOnce(
      new Error("owner@example.com provider payload"),
    );
    const response = await GET(
      new Request("https://openvpm.test/api/cron/lifecycle-emails"),
    );
    expect(response.status).toBe(500);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "lifecycle-emails",
      status: "failed",
      detail: "Durable lifecycle email worker crashed",
    });
    expect(JSON.stringify(await response.json())).not.toContain("owner@");
  });
});
