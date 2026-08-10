import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    return builder;
  });
  const db = { select };

  return {
    db,
    selectResults,
    alertOps: vi.fn(async () => undefined),
    billingEnforced: vi.fn(() => true),
    cronAuthError: vi.fn(() => null),
    reportCronHeartbeat: vi.fn(async () => undefined),
    sendTrialEndingEmail: vi.fn(async () => ({
      success: true,
      id: "email_123",
    })),
    sendOptionalPlatformEmail: vi.fn(
      async (opts: {
        send: () => Promise<unknown>;
      }): Promise<{
        sent: boolean;
        deduped: boolean;
        suppressed?: boolean;
      }> => {
        await opts.send();
        return { sent: true, deduped: false };
      },
    ),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD: 79,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));

vi.mock("@/lib/email", () => ({
  sendTrialEndingEmail: mocks.sendTrialEndingEmail,
}));

vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { GET } = await import("./route");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function practice(overrides: Record<string, unknown> = {}) {
  return {
    id: PRACTICE_ID,
    name: "Neighborhood Veterinary",
    email: "owner@example.com",
    timezone: "America/New_York",
    trialEndsAt: new Date("2026-07-04T15:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
});

describe("billing lifecycle cron", () => {
  it("requires cron authorization before touching billing state", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    expect(response.status).toBe(401);
    expect(mocks.billingEnforced).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("no-ops when hosted billing enforcement is disabled", async () => {
    mocks.billingEnforced.mockReturnValueOnce(false);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      disabled: true,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "billing-lifecycle",
      status: "ok",
      detail: "Hosted billing disabled; no lifecycle emails sent",
      metrics: {
        sent: 0,
        deduped: 0,
        suppressed: 0,
        failed: 0,
        skipped: 0,
        disabled: true,
      },
    });
  });

  it("sends an exact-once T-3 trial-ending email", async () => {
    mocks.selectResults.push([practice()]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "trial-ending",
        dedupeKey: `lc:trial-ending:${PRACTICE_ID}:2026-07-04:t-3`,
        retryOnFail: true,
        send: expect.any(Function),
      }),
    );
    expect(mocks.sendTrialEndingEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      practiceName: "Neighborhood Veterinary",
      daysLeft: 3,
      trialEndDate: "July 4, 2026",
      monthlyPrice: "$79",
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "billing-lifecycle",
      status: "ok",
      detail: "1 sent, 0 deduped, 0 suppressed, 0 failed, 0 skipped",
      metrics: {
        candidates: 1,
        sent: 1,
        deduped: 0,
        suppressed: 0,
        failed: 0,
        skipped: 0,
      },
    });
  });

  it("dedupes trial-ending emails by the practice-local trial end date", async () => {
    vi.setSystemTime(new Date("2026-07-01T06:00:00Z"));
    mocks.selectResults.push([
      practice({
        timezone: "America/Los_Angeles",
        trialEndsAt: new Date("2026-07-04T02:00:00Z"),
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        emailType: "trial-ending",
        dedupeKey: `lc:trial-ending:${PRACTICE_ID}:2026-07-03:t-3`,
      }),
    );
    expect(mocks.sendTrialEndingEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        daysLeft: 3,
        trialEndDate: "July 3, 2026",
      }),
    );
  });

  it("normalizes the billing contact email before claiming and sending", async () => {
    mocks.selectResults.push([practice({ email: " Owner@Example.COM " })]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toMatchObject({
      sent: 1,
      skipped: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
      }),
    );
    expect(mocks.sendTrialEndingEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
      }),
    );
  });

  it("skips non-milestone trials and practices without billing email", async () => {
    mocks.selectResults.push([
      practice({ trialEndsAt: new Date("2026-07-06T12:00:00Z") }),
      practice({ email: null }),
      practice({ email: "   " }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 3,
    });
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
    expect(mocks.sendTrialEndingEmail).not.toHaveBeenCalled();
  });

  it("does not treat same-calendar-day trial endings as T-1", async () => {
    mocks.selectResults.push([
      practice({ trialEndsAt: new Date("2026-07-01T22:00:00Z") }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 1,
    });
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
    expect(mocks.sendTrialEndingEmail).not.toHaveBeenCalled();
  });

  it("reports deduped lifecycle sends separately from new sends", async () => {
    mocks.selectResults.push([practice()]);
    mocks.sendOptionalPlatformEmail.mockResolvedValueOnce({
      sent: false,
      deduped: true,
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      deduped: 1,
      suppressed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.sendTrialEndingEmail).not.toHaveBeenCalled();
  });

  it("reports recipient suppression without claiming or failing the send", async () => {
    mocks.selectResults.push([practice()]);
    mocks.sendOptionalPlatformEmail.mockResolvedValueOnce({
      sent: false,
      deduped: false,
      suppressed: true,
    });

    const response = await GET(
      new Request("https://openvpm.test/api/cron/billing-lifecycle"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      deduped: 0,
      suppressed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.sendTrialEndingEmail).not.toHaveBeenCalled();
  });

  it("sweeps only active trialing practices", () => {
    const trialSweep = ROUTE_SOURCE.match(
      /const trialingPractices = await withSystem[\s\S]+?\),\s*\);/,
    )?.[0];

    expect(trialSweep).toContain('eq(practices.billingStatus, "trialing")');
    expect(trialSweep).toContain("isNull(practices.deletedAt)");
  });
});
