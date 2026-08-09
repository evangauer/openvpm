import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  cronAuthError: vi.fn((): Response | null => null),
  reconcileConversionMilestones: vi.fn(),
  reconcileRegistrationFirstTouches: vi.fn(),
  reportCronHeartbeat: vi.fn(async () => undefined),
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/conversion-milestones", () => ({
  reconcileConversionMilestones: mocks.reconcileConversionMilestones,
}));
vi.mock("@/lib/funnel-events-server", () => ({
  reconcileRegistrationFirstTouches: mocks.reconcileRegistrationFirstTouches,
}));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));

const { GET } = await import("./route");

afterEach(() => {
  vi.clearAllMocks();
});

describe("conversion reconciliation cron", () => {
  it("requires cron authorization", async () => {
    mocks.cronAuthError.mockReturnValueOnce(new Response(null, { status: 401 }));

    const response = await GET(new Request("https://openvpm.test/api/cron/conversion-reconcile"));

    expect(response.status).toBe(401);
    expect(mocks.reconcileConversionMilestones).not.toHaveBeenCalled();
    expect(mocks.reconcileRegistrationFirstTouches).not.toHaveBeenCalled();
  });

  it("reports exact local repairs and heartbeat counts", async () => {
    mocks.reconcileConversionMilestones.mockResolvedValueOnce({
      registrationsRepaired: 2,
      activationsRepaired: 1,
      paymentMethodsRepaired: 1,
      positivePaymentsRepaired: 1,
    });
    mocks.reconcileRegistrationFirstTouches.mockResolvedValueOnce({
      validFunnelIdMissingTouchRepaired: 2,
      missingFunnelIdHistoricalUnknown: 15,
    });

    const response = await GET(new Request("https://openvpm.test/api/cron/conversion-reconcile"));

    await expect(response.json()).resolves.toEqual({
      ok: true,
      registrationsRepaired: 2,
      activationsRepaired: 1,
      paymentMethodsRepaired: 1,
      positivePaymentsRepaired: 1,
      validFunnelIdMissingTouchRepaired: 2,
      missingFunnelIdHistoricalUnknown: 15,
      repaired: 7,
    });
    expect(mocks.reconcileConversionMilestones).toHaveBeenCalledWith(mocks.db);
    expect(mocks.reconcileRegistrationFirstTouches).toHaveBeenCalledWith(mocks.db);
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "conversion-reconcile",
        status: "ok",
        metrics: expect.objectContaining({
          repaired: 7,
          missingFunnelIdHistoricalUnknown: 15,
        }),
      }),
    );
  });

  it("fails closed and alerts when local reconciliation fails", async () => {
    mocks.reconcileConversionMilestones.mockRejectedValueOnce(
      new Error("query failed"),
    );

    const response = await GET(new Request("https://openvpm.test/api/cron/conversion-reconcile"));

    expect(response.status).toBe(500);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Conversion reconciliation failed",
      "query failed",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "conversion-reconcile",
      status: "failed",
      detail: "query failed",
    });
  });
});
