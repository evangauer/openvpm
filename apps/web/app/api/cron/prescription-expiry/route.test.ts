import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
  cronAuthError: vi.fn(() => null),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  expireDuePrescriptions: vi.fn(async () => ({
    expired: 1,
    prescriptions: [
      { id: "rx-1", practiceId: "practice-1", patientId: "patient-1" },
    ],
  })),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));
vi.mock("@/lib/records/prescription-expiry", () => ({
  expireDuePrescriptions: mocks.expireDuePrescriptions,
}));

const { GET } = await import("./route");

afterEach(() => {
  vi.clearAllMocks();
  mocks.expireDuePrescriptions.mockResolvedValue({
    expired: 1,
    prescriptions: [
      { id: "rx-1", practiceId: "practice-1", patientId: "patient-1" },
    ],
  });
});

describe("prescription expiry cron", () => {
  it("requires cron authorization before reading prescriptions", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) as never,
    );
    const response = await GET(
      new Request("https://openvpm.test/api/cron/prescription-expiry"),
    );
    expect(response.status).toBe(401);
    expect(mocks.expireDuePrescriptions).not.toHaveBeenCalled();
  });

  it("expires due prescriptions and dispatches lifecycle webhooks", async () => {
    const response = await GET(
      new Request("https://openvpm.test/api/cron/prescription-expiry"),
    );
    await expect(response.json()).resolves.toEqual({ expired: 1 });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      "practice-1",
      "prescription.expired",
      { id: "rx-1", patientId: "patient-1", source: "system" },
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "prescription-expiry",
      status: "ok",
      detail: "1 prescriptions expired",
      metrics: { expired: 1 },
    });
  });

  it("alerts and reports a failed heartbeat", async () => {
    mocks.expireDuePrescriptions.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const response = await GET(
      new Request("https://openvpm.test/api/cron/prescription-expiry"),
    );
    expect(response.status).toBe(500);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Prescription expiry failed",
      "database unavailable",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "prescription-expiry",
      status: "failed",
      detail: "database unavailable",
    });
  });
});
