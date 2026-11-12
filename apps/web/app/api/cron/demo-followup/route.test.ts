import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const db = { execute };
  return {
    db,
    execute,
    executeResults,
    billingEnforced: vi.fn(() => true),
    cronAuthError: vi.fn(() => null),
    reportCronHeartbeat: vi.fn(async () => undefined),
    alertOps: vi.fn(async () => undefined),
    sendDemoFollowupEmail: vi.fn(async () => ({ success: true, id: "e-1" })),
    sendLeadEmail: vi.fn(
      async (opts: {
        stillEligible?: (tx: unknown) => Promise<boolean>;
        send: () => Promise<{ success: boolean }>;
      }) => {
        if (opts.stillEligible && !(await opts.stillEligible(db))) {
          return { sent: false, deduped: false, suppressed: true };
        }
        const result = await opts.send();
        return { sent: result.success, deduped: false };
      },
    ),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
}));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/email", () => ({
  sendDemoFollowupEmail: mocks.sendDemoFollowupEmail,
}));
vi.mock("@/lib/growth/lead-email", () => ({
  sendLeadEmail: mocks.sendLeadEmail,
}));

const { GET } = await import("./route");

const LEAD_ID = "00000000-0000-4000-8000-0000000000cc";
const ANONYMOUS_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-07T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    leadId: LEAD_ID,
    email: "vet@clinic.com",
    anonymousId: ANONYMOUS_ID,
    disclosureVersion: "demo-followup-v2",
    firstSeenAt: new Date(NOW.getTime() - 4 * HOUR),
    toolCount: 3,
    topTool: "day_board",
    existingEmailCount: 0,
    lastEmailAt: null,
    ...overrides,
  };
}

const request = () =>
  new Request("https://app.openvpm.com/api/cron/demo-followup");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("DEMO_FOLLOWUP_ENABLED", "true");
  vi.stubEnv("DEMO_FOLLOWUP_ROLLOUT_AT", "2026-11-01T00:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
  mocks.billingEnforced.mockReturnValue(true);
});

describe("demo follow-up cron", () => {
  it("is off until enabled with a rollout time", async () => {
    vi.stubEnv("DEMO_FOLLOWUP_ENABLED", "");
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      disabled: true,
      reason: "disabled",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("never runs on the demo or self-hosted deployments", async () => {
    mocks.billingEnforced.mockReturnValue(false);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      disabled: true,
      reason: "billing_disabled",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("sends the feedback email with the lead's first tool and funnel id", async () => {
    mocks.executeResults.push([candidate()], [{ eligible: 1 }]);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ sent: 1, failed: 0 });
    expect(mocks.sendLeadEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        leadId: LEAD_ID,
        to: "vet@clinic.com",
        sequence: "demo-followup",
        step: 1,
        dedupeKey: `lead:demo-followup:v1:${LEAD_ID}:1`,
      }),
    );
    expect(mocks.sendDemoFollowupEmail).toHaveBeenCalledWith({
      to: "vet@clinic.com",
      step: 1,
      topTool: "day_board",
      anonymousId: ANONYMOUS_ID,
      idempotencyKey: `lead:demo-followup:v1:${LEAD_ID}:1`,
    });
  });

  it("stops after one email for leads who saw the one-email disclosure", async () => {
    mocks.executeResults.push([
      candidate({
        disclosureVersion: "demo-feedback-v1",
        firstSeenAt: new Date(NOW.getTime() - 50 * HOUR),
        existingEmailCount: 1,
        lastEmailAt: new Date(NOW.getTime() - 47 * HOUR),
      }),
    ]);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ skipped: 1, sent: 0 });
    expect(mocks.sendLeadEmail).not.toHaveBeenCalled();
  });

  it("suppresses when the lead signed up or was paused meanwhile", async () => {
    mocks.executeResults.push([candidate()], []);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ suppressed: 1, sent: 0 });
    expect(mocks.sendDemoFollowupEmail).not.toHaveBeenCalled();
  });

  it("reports failures without throwing", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("db down"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Demo follow-up cron failed",
      "db down",
    );
  });
});
