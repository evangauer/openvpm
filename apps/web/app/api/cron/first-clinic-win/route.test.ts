import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cronAuthError: vi.fn(() => null),
  configuration: vi.fn(() => ({
    enabled: true as const,
    launchAt: new Date("2026-08-11T00:00:00.000Z"),
  })),
  runCampaign: vi.fn(async () => ({
    candidates: 1,
    sent: 1,
    deduped: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
    disabled: false,
  })),
  reportCronHeartbeat: vi.fn(async () => undefined),
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/billing/first-clinic-win", () => ({
  firstClinicWinCampaignConfiguration: mocks.configuration,
  runFirstClinicWinCampaign: mocks.runCampaign,
}));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configuration.mockReturnValue({
    enabled: true,
    launchAt: new Date("2026-08-11T00:00:00.000Z"),
  });
});

describe("first clinic win cron", () => {
  it("reports a bounded campaign sweep", async () => {
    const response = await GET(
      new Request("https://app.test/api/cron/first-clinic-win"),
    );
    await expect(response.json()).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "first-clinic-win",
        status: "ok",
      }),
    );
  });

  it("is a healthy no-op until the rollout boundary is configured", async () => {
    mocks.configuration.mockReturnValueOnce({
      enabled: false,
      reason: "FIRST_CLINIC_WIN_EMAIL_ENABLED is false",
    } as never);

    const response = await GET(
      new Request("https://app.test/api/cron/first-clinic-win"),
    );
    await expect(response.json()).resolves.toMatchObject({ disabled: true });
    expect(mocks.runCampaign).not.toHaveBeenCalled();
  });
});
