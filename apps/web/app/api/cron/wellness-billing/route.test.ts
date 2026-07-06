import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    return builder;
  });
  const systemDb = { select };

  return {
    db: {},
    systemDb,
    selectResults,
    alertOps: vi.fn(async () => undefined),
    cronAuthError: vi.fn(() => null),
    reportCronHeartbeat: vi.fn(async () => undefined),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(systemDb)
    ),
    withTenant: vi.fn(
      async (
        _db: unknown,
        practiceId: string,
        fn: (tx: unknown) => Promise<unknown>
      ) => fn({ tenantPracticeId: practiceId })
    ),
    generateDueWellnessInvoices: vi.fn(async (opts: { practiceId: string }) => ({
      generated: opts.practiceId.endsWith("aa") ? 2 : 0,
      invoices: [],
    })),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
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

vi.mock("@/lib/wellness/invoicing", () => ({
  generateDueWellnessInvoices: mocks.generateDueWellnessInvoices,
}));

const { GET } = await import("./route");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T09:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
});

describe("wellness billing cron", () => {
  it("requires cron authorization before sweeping practices", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/wellness-billing")
    );

    expect(response.status).toBe(401);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.generateDueWellnessInvoices).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("generates due invoices for every active practice", async () => {
    mocks.selectResults.push([
      { id: PRACTICE_ID, timezone: "America/New_York" },
      { id: OTHER_PRACTICE_ID, timezone: "America/New_York" },
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/wellness-billing")
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-07-15",
      runDateUtc: "2026-07-15",
      billingDates: {
        "2026-07-15": 2,
      },
      practices: 2,
      generated: 2,
      failed: 0,
    });
    expect(mocks.withTenant).toHaveBeenNthCalledWith(
      1,
      mocks.db,
      PRACTICE_ID,
      expect.any(Function)
    );
    expect(mocks.withTenant).toHaveBeenNthCalledWith(
      2,
      mocks.db,
      OTHER_PRACTICE_ID,
      expect.any(Function)
    );
    expect(mocks.generateDueWellnessInvoices).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        db: { tenantPracticeId: PRACTICE_ID },
        practiceId: PRACTICE_ID,
        asOf: "2026-07-15",
      })
    );
    expect(mocks.generateDueWellnessInvoices).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        db: { tenantPracticeId: OTHER_PRACTICE_ID },
        practiceId: OTHER_PRACTICE_ID,
        asOf: "2026-07-15",
      })
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "wellness-billing",
      status: "ok",
      detail: "2 invoices generated, 0 practices failed",
      metrics: {
        practices: 2,
        generated: 2,
        failed: 0,
        runDateUtc: "2026-07-15",
        billingDateRange: "2026-07-15",
      },
    });
  });

  it("uses each practice timezone for the billing as-of date", async () => {
    vi.setSystemTime(new Date("2026-07-15T02:30:00Z"));
    mocks.selectResults.push([
      { id: PRACTICE_ID, timezone: "America/Los_Angeles" },
      { id: OTHER_PRACTICE_ID, timezone: "Asia/Tokyo" },
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/wellness-billing")
    );

    await expect(response.json()).resolves.toMatchObject({
      date: "2026-07-15",
      runDateUtc: "2026-07-15",
      billingDates: {
        "2026-07-14": 1,
        "2026-07-15": 1,
      },
      practices: 2,
      failed: 0,
    });
    expect(mocks.generateDueWellnessInvoices).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        asOf: "2026-07-14",
      })
    );
    expect(mocks.generateDueWellnessInvoices).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        practiceId: OTHER_PRACTICE_ID,
        asOf: "2026-07-15",
      })
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.objectContaining({
          runDateUtc: "2026-07-15",
          billingDateRange: "2026-07-14..2026-07-15",
        }),
      })
    );
  });

  it("reports degraded when an individual practice fails", async () => {
    mocks.selectResults.push([
      { id: PRACTICE_ID, timezone: "America/New_York" },
      { id: OTHER_PRACTICE_ID, timezone: "America/New_York" },
    ]);
    mocks.generateDueWellnessInvoices
      .mockResolvedValueOnce({ generated: 1, invoices: [] })
      .mockRejectedValueOnce(new Error("database timeout"));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/wellness-billing")
    );

    await expect(response.json()).resolves.toEqual({
      date: "2026-07-15",
      runDateUtc: "2026-07-15",
      billingDates: {
        "2026-07-15": 2,
      },
      practices: 2,
      generated: 1,
      failed: 1,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Wellness billing failed",
      expect.stringContaining(`practice=${OTHER_PRACTICE_ID}: database timeout`)
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "wellness-billing",
      status: "degraded",
      detail: "1 invoices generated, 1 practices failed",
      metrics: {
        practices: 2,
        generated: 1,
        failed: 1,
        runDateUtc: "2026-07-15",
        billingDateRange: "2026-07-15",
      },
    });
  });

  it("reports failed when the cross-tenant sweep cannot load practices", async () => {
    mocks.withSystem.mockRejectedValueOnce(new Error("connection refused"));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/wellness-billing")
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Wellness billing cron failed",
      "connection refused"
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "wellness-billing",
      status: "failed",
      detail: "connection refused",
    });
  });
});
