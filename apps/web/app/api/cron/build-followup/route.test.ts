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
    reportCronHeartbeat: vi.fn(async () => undefined),
    sendBuildFollowupEmail: vi.fn(async () => ({ success: true, id: "email-1" })),
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
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) => fn(db)),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/plans", () => ({ billingEnforced: mocks.billingEnforced }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: () => null }));
vi.mock("@/lib/cron-heartbeat", () => ({ reportCronHeartbeat: mocks.reportCronHeartbeat }));
vi.mock("@/lib/alerts", () => ({ alertOps: vi.fn(async () => undefined) }));
vi.mock("@/lib/email", () => ({ sendBuildFollowupEmail: mocks.sendBuildFollowupEmail }));
vi.mock("@/lib/growth/lead-email", () => ({ sendLeadEmail: mocks.sendLeadEmail }));

const { GET } = await import("./route");

const NOW = new Date("2026-11-05T18:00:00Z");
const HOUR = 60 * 60 * 1000;
const state = {
  practiceType: "companion",
  currentSystem: "avimark",
  clinicName: "Harbor View",
  brandColor: "#e8590c",
  services: [{ name: "Wellness Exam", price: 65, on: true }],
};

function row(savedAgoMs: number, extra: Record<string, unknown> = {}) {
  return {
    leadId: "00000000-0000-4000-8000-0000000000aa",
    email: "dr.ray@harborview.test",
    anonymousId: null,
    buildProgress: {
      state,
      scene: "visit",
      savedAt: new Date(NOW.getTime() - savedAgoMs).toISOString(),
      disclosureVersion: "build-v2",
    },
    existingEmailCount: 0,
    lastEmailAt: null,
    ...extra,
  };
}

function request() {
  return new Request("https://app.openvpm.com/api/cron/build-followup");
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("BUILD_FOLLOWUP_ENABLED", "true");
  vi.stubEnv("BUILD_FOLLOWUP_ROLLOUT_AT", "2026-11-01T00:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
  mocks.billingEnforced.mockReturnValue(true);
});

describe("build follow-up cron", () => {
  it("stays off until enabled", async () => {
    vi.stubEnv("BUILD_FOLLOWUP_ENABLED", "");
    expect(await (await GET(request())).json()).toMatchObject({ disabled: true });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("sends the resume note with the saved build", async () => {
    mocks.executeResults.push([row(3 * HOUR)], [{ eligible: 1 }]);
    expect(await (await GET(request())).json()).toMatchObject({ sent: 1 });
    expect(mocks.sendBuildFollowupEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 1,
        state,
        idempotencyKey: "lead:build-followup:v1:00000000-0000-4000-8000-0000000000aa:1",
      }),
    );
  });

  it("skips unreadable or not-yet-due builds", async () => {
    mocks.executeResults.push([
      row(3 * HOUR, { buildProgress: { scene: "visit" } }),
      row(30 * HOUR, { existingEmailCount: 1, lastEmailAt: new Date(NOW.getTime() - 27 * HOUR) }),
    ]);
    expect(await (await GET(request())).json()).toMatchObject({ skipped: 2, sent: 0 });
    expect(mocks.sendBuildFollowupEmail).not.toHaveBeenCalled();
  });

  it("stops once the person signs up", async () => {
    mocks.executeResults.push([row(3 * HOUR)], []);
    expect(await (await GET(request())).json()).toMatchObject({ suppressed: 1, sent: 0 });
  });
});
