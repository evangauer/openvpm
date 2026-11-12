import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const db = { execute };
  const sendOk = () => vi.fn(async () => ({ success: true, id: "email-1" }));
  return {
    db,
    execute,
    executeResults,
    billingEnforced: vi.fn(() => true),
    reportCronHeartbeat: vi.fn(async () => undefined),
    alertOps: vi.fn(async () => undefined),
    practiceUsageByIds: vi.fn(async () => new Map()),
    sendTeamInviteNudgeEmail: sendOk(),
    sendTrialWinbackEmail: sendOk(),
    sendAdoptionEmail: sendOk(),
    sendNpsSurveyEmail: sendOk(),
    sendOptionalPlatformEmail: vi.fn(
      async (opts: {
        stillEligible?: (tx: unknown) => Promise<boolean>;
        send: () => Promise<{ success: boolean }>;
      }) => {
        if (opts.stillEligible && !(await opts.stillEligible(db))) {
          return { sent: false, deduped: false, suppressed: true };
        }
        const result = await opts.send();
        return result.success
          ? { sent: true, deduped: false }
          : { sent: false, deduped: false };
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
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: () => null }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/growth/practice-usage", () => ({
  practiceUsageByIds: mocks.practiceUsageByIds,
}));
vi.mock("@/lib/email", () => ({
  sendTeamInviteNudgeEmail: mocks.sendTeamInviteNudgeEmail,
  sendTrialWinbackEmail: mocks.sendTrialWinbackEmail,
  sendAdoptionEmail: mocks.sendAdoptionEmail,
  sendNpsSurveyEmail: mocks.sendNpsSurveyEmail,
}));
vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

const { GET } = await import("./route");

const NOW = new Date("2026-11-05T16:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";

const ADMIN = {
  practiceId: PRACTICE_ID,
  practiceName: "Neighborhood Veterinary",
  adminEmail: "owner@example.com",
  adminName: "Sam Rivera",
};

function usage(overrides: Record<string, unknown> = {}) {
  return new Map([
    [
      PRACTICE_ID,
      {
        clients: 14,
        patients: 20,
        appointments: 22,
        invoices: 0,
        staffCount: 1,
        portalSessions: 0,
        remindersEnabled: false,
        ...overrides,
      },
    ],
  ]);
}

/** Queue results in campaign order: team, win-back, adoption, NPS. */
function queue(...results: unknown[][]) {
  mocks.executeResults.push(...results);
}

function request() {
  return new Request("https://app.openvpm.com/api/cron/customer-lifecycle");
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("CUSTOMER_LIFECYCLE_ENABLED", "true");
  vi.stubEnv("CUSTOMER_LIFECYCLE_ROLLOUT_AT", "2026-09-01T00:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
  mocks.billingEnforced.mockReturnValue(true);
  mocks.practiceUsageByIds.mockResolvedValue(new Map());
});

describe("customer lifecycle cron", () => {
  it("does nothing until enabled with a rollout time", async () => {
    vi.stubEnv("CUSTOMER_LIFECYCLE_ROLLOUT_AT", "");
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      disabled: true,
      reason: "rollout_at_invalid",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does nothing on self-hosted deployments", async () => {
    mocks.billingEnforced.mockReturnValue(false);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ disabled: true });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("nudges a clinic working alone to invite its team, once", async () => {
    mocks.practiceUsageByIds.mockResolvedValueOnce(usage());
    queue([ADMIN], [{ eligible: 1 }]);

    const body = await (await GET(request())).json();

    expect(body.teamInvite).toMatchObject({ candidates: 1, sent: 1 });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        emailType: "team-invite",
        dedupeKey: `lc:team-invite:v1:${PRACTICE_ID}`,
      }),
    );
    expect(mocks.sendTeamInviteNudgeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ appointments: 22 }),
    );
  });

  it("sends the due win-back step with a usage recap", async () => {
    mocks.practiceUsageByIds.mockResolvedValueOnce(usage({ invoices: 3 }));
    queue(
      [],
      [
        {
          ...ADMIN,
          trialEndsAt: new Date(NOW.getTime() - 8 * DAY),
          existingEmailCount: 1,
          lastEmailAt: new Date(NOW.getTime() - 7 * DAY),
        },
      ],
      [{ eligible: 1 }],
    );

    const body = await (await GET(request())).json();

    expect(body.trialWinback).toMatchObject({ sent: 1 });
    expect(mocks.sendTrialWinbackEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 2,
        practiceId: PRACTICE_ID,
        usageSummary: "14 clients, 22 appointments and 3 invoices",
        idempotencyKey: `lc:trial-winback:v1:${PRACTICE_ID}:2`,
      }),
    );
  });

  it("stops win-back mail once the clinic reactivates", async () => {
    queue(
      [],
      [
        {
          ...ADMIN,
          trialEndsAt: new Date(NOW.getTime() - 2 * DAY),
          existingEmailCount: 0,
          lastEmailAt: null,
        },
      ],
      [],
    );

    const body = await (await GET(request())).json();

    expect(body.trialWinback).toMatchObject({ sent: 0, suppressed: 1 });
    expect(mocks.sendTrialWinbackEmail).not.toHaveBeenCalled();
  });

  it("suggests only what a paying clinic has not turned on", async () => {
    mocks.practiceUsageByIds.mockResolvedValueOnce(
      usage({ remindersEnabled: true, staffCount: 4, portalSessions: 0 }),
    );
    queue([], [], [ADMIN], [{ eligible: 1 }]);

    await GET(request());

    expect(mocks.sendAdoptionEmail).toHaveBeenCalledWith(
      expect.objectContaining({ gaps: ["portal"] }),
    );
  });

  it("sends no adoption email to a clinic already using everything", async () => {
    mocks.practiceUsageByIds.mockResolvedValueOnce(
      usage({ remindersEnabled: true, staffCount: 4, portalSessions: 9 }),
    );
    queue([], [], [ADMIN]);

    const body = await (await GET(request())).json();

    expect(body.adoption).toMatchObject({ candidates: 1, skipped: 1, sent: 0 });
    expect(mocks.sendAdoptionEmail).not.toHaveBeenCalled();
  });

  it("asks NPS in the cycle window and names the survey", async () => {
    queue(
      [],
      [],
      [],
      [{ ...ADMIN, payingSince: new Date(NOW.getTime() - 32 * DAY) }],
      [{ eligible: 1 }],
    );

    const body = await (await GET(request())).json();

    expect(body.nps).toMatchObject({ sent: 1 });
    expect(mocks.sendNpsSurveyEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        survey: "nps:1",
        idempotencyKey: `lc:nps:v1:${PRACTICE_ID}:1`,
      }),
    );
  });

  it("never backfills NPS for cycles that opened before rollout", async () => {
    vi.stubEnv("CUSTOMER_LIFECYCLE_ROLLOUT_AT", "2026-11-01T00:00:00Z");
    queue([], [], [], [
      { ...ADMIN, payingSince: new Date(NOW.getTime() - 35 * DAY) },
    ]);

    const body = await (await GET(request())).json();

    expect(body.nps).toMatchObject({ candidates: 0, sent: 0 });
    expect(mocks.sendNpsSurveyEmail).not.toHaveBeenCalled();
  });

  it("keeps running other campaigns when one query fails", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("team query failed"));
    queue([], [], [{ ...ADMIN, payingSince: new Date(NOW.getTime() - 31 * DAY) }], [
      { eligible: 1 },
    ]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.errors).toBe(1);
    expect(body.nps).toMatchObject({ sent: 1 });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Customer lifecycle cron failed",
      expect.stringContaining("teamInvite"),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ status: "degraded" }),
    );
  });
});
