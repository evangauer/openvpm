import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => true),
  cronAuthError: vi.fn((): Response | null => null),
  processSmsProviderEventBatch: vi.fn(),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/messaging/sms-provider-events", () => ({
  processSmsProviderEventBatch: mocks.processSmsProviderEventBatch,
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cronAuthError.mockReturnValue(null);
  mocks.processSmsProviderEventBatch.mockResolvedValue({
    claimed: 2,
    projected: 1,
    ignored: 1,
    blockedRecovery: 0,
    retried: 0,
    quarantined: 0,
    remaining: 0,
    budgetExhausted: false,
  });
});

describe("SMS provider-event projection cron", () => {
  it("requires cron authorization before claiming durable events", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-provider-events"),
    );

    expect(response.status).toBe(401);
    expect(mocks.processSmsProviderEventBatch).not.toHaveBeenCalled();
  });

  it("runs a bounded writer and emits a PHI-free heartbeat", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-provider-events"),
    );

    expect(response.status).toBe(200);
    expect(mocks.processSmsProviderEventBatch).toHaveBeenCalledWith({
      limit: 50,
      budgetMs: 240_000,
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "sms-provider-events",
      status: "ok",
      detail: "1 projected, 1 ignored, 0 remaining",
      metrics: expect.objectContaining({ projected: 1, ignored: 1 }),
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("alerts only with bounded counts when projection quarantines evidence", async () => {
    mocks.processSmsProviderEventBatch.mockResolvedValueOnce({
      claimed: 1,
      projected: 0,
      ignored: 0,
      blockedRecovery: 0,
      retried: 0,
      quarantined: 1,
      remaining: 1,
      budgetExhausted: false,
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-provider-events"),
    );

    expect(response.status).toBe(200);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS provider event projection quarantined",
      expect.not.stringMatching(/\+?\d{7,}|sensitive/i),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ status: "degraded" }),
    );
  });

  it("awaits but contains an alert transport failure after durable worker state is recorded", async () => {
    mocks.processSmsProviderEventBatch.mockResolvedValueOnce({
      claimed: 1,
      projected: 0,
      ignored: 0,
      blockedRecovery: 0,
      retried: 0,
      quarantined: 1,
      remaining: 1,
      budgetExhausted: false,
    });
    mocks.alertOps.mockRejectedValueOnce(new Error("alert unavailable"));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-provider-events"),
    );

    expect(response.status).toBe(200);
    expect(mocks.alertOps).toHaveBeenCalledTimes(1);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "sms-provider-events",
        status: "degraded",
      }),
    );
  });

  it("keeps durable events queued and reports a failed heartbeat on crash", async () => {
    mocks.processSmsProviderEventBatch.mockRejectedValueOnce(
      new Error("sensitive provider payload"),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-provider-events"),
    );

    expect(response.status).toBe(500);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "sms-provider-events",
      status: "failed",
      detail: "SMS provider event projection worker crashed",
    });
    expect(JSON.stringify(await response.json())).not.toContain("sensitive");
  });
});
