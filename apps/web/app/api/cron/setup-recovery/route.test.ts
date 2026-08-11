import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => [] as unknown[]),
  alertOps: vi.fn(async () => undefined),
  billingEnforced: vi.fn(() => true),
  cronAuthError: vi.fn(() => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
  sendSetupRecoveryEmail: vi.fn(async () => ({
    success: true,
    id: "email-setup-1",
  })),
  sendOptionalPlatformEmail: vi.fn(
    async (opts: {
      send: () => Promise<unknown>;
      stillEligible?: (tx: unknown) => Promise<boolean>;
    }) => {
      await opts.send();
      return { sent: true, deduped: false };
    },
  ),
}));

vi.mock("@openpims/db/client", () => ({ db: { execute: mocks.execute } }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: mocks.execute }),
  ),
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
}));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/email", () => ({
  sendSetupRecoveryEmail: mocks.sendSetupRecoveryEmail,
}));
vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

const { GET } = await import("./route");
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    practiceId: PRACTICE_ID,
    practiceName: "Neighborhood Veterinary",
    billingStatus: "trialing",
    trialEndsAt: new Date("2026-08-20T16:00:00Z"),
    createdAt: new Date("2026-08-01T12:00:00Z"),
    settings: {
      onboardingState: {
        onboardingIntent: "replace",
        journeyStepId: "data",
        journeyLastProgressAt: "2026-08-08T12:00:00Z",
      },
    },
    adminEmail: "verified-owner@example.com",
    activated: false,
    existingEmailCount: 0,
    lastEmailAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-11T16:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("setup recovery cron", () => {
  it("requires cron authorization before reading clinics", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response("Unauthorized", { status: 401 }) as never,
    );
    const response = await GET(
      new Request("https://openvpm.test/api/cron/setup-recovery"),
    );
    expect(response.status).toBe(401);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
  });

  it("no-ops when hosted billing is disabled", async () => {
    mocks.billingEnforced.mockReturnValueOnce(false);
    const response = await GET(
      new Request("https://openvpm.test/api/cron/setup-recovery"),
    );
    await expect(response.json()).resolves.toEqual({ disabled: true, sent: 0 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "setup-recovery",
      status: "ok",
      detail: "Hosted billing disabled; no setup recovery emails sent",
      metrics: { disabled: true, sent: 0 },
    });
  });

  it("sends one exact stage-specific first recovery email", async () => {
    mocks.execute.mockResolvedValueOnce([candidate()]);
    const response = await GET(
      new Request("https://openvpm.test/api/cron/setup-recovery"),
    );

    await expect(response.json()).resolves.toEqual({
      candidates: 1,
      eligible: 1,
      sent: 1,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      to: "verified-owner@example.com",
      emailType: "setup-recovery",
      dedupeKey: `lc:setup-recovery:v1:${PRACTICE_ID}:1`,
      retryOnFail: true,
      stillEligible: expect.any(Function),
      send: expect.any(Function),
    });
    expect(mocks.sendSetupRecoveryEmail).toHaveBeenCalledWith({
      to: "verified-owner@example.com",
      practiceName: "Neighborhood Veterinary",
      stepTitle: "bringing in your clinic records",
      nextAction: expect.stringContaining("private migration review"),
      attemptNumber: 1,
    });

    const options = mocks.sendOptionalPlatformEmail.mock.calls[0]?.[0] as {
      stillEligible: (tx: {
        execute: () => Promise<unknown[]>;
      }) => Promise<boolean>;
    };
    await expect(
      options.stillEligible({
        execute: vi.fn(async () => [candidate()]),
      }),
    ).resolves.toBe(true);
    await expect(
      options.stillEligible({
        execute: vi.fn(async () => [
          candidate({
            settings: {
              onboardingState: {
                onboardingIntent: "replace",
                journeyStepId: "allSet",
                journeyLastProgressAt: "2026-08-11T15:59:00Z",
              },
            },
          }),
        ]),
      }),
    ).resolves.toBe(false);
  });

  it("sends at most the second message after cooldown and skips help requests", async () => {
    mocks.execute.mockResolvedValueOnce([
      candidate({
        existingEmailCount: 1,
        lastEmailAt: new Date("2026-08-07T12:00:00Z"),
      }),
      candidate({
        practiceId: "00000000-0000-0000-0000-0000000000bb",
        settings: {
          onboardingState: {
            journeyStepId: "basics",
            setupHelpRequestedAt: "2026-08-09T12:00:00Z",
          },
        },
      }),
    ]);
    const response = await GET(
      new Request("https://openvpm.test/api/cron/setup-recovery"),
    );
    await expect(response.json()).resolves.toMatchObject({
      candidates: 2,
      eligible: 1,
      sent: 1,
      skipped: 1,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: `lc:setup-recovery:v1:${PRACTICE_ID}:2`,
      }),
    );
  });

  it("queries only verified admins and excludes unsafe cohorts", () => {
    expect(ROUTE_SOURCE).toContain("u.email_verified_at is not null");
    expect(ROUTE_SOURCE).toContain("p.recovery_hold = false");
    expect(ROUTE_SOURCE).toContain("p.settings ->> 'analyticsExcluded'");
    expect(ROUTE_SOURCE).toContain(
      "p.trial_ends_at > now() + interval '48 hours'",
    );
    expect(ROUTE_SOURCE).toContain(
      "coalesce(email_history.email_count, 0) < 2",
    );
    expect(ROUTE_SOURCE).not.toContain('p.email as "adminEmail"');
    expect(ROUTE_SOURCE).toContain("limit ${SETUP_RECOVERY_RUN_LIMIT}");
  });

  it("reports failures without exposing candidate details", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await GET(
      new Request("https://openvpm.test/api/cron/setup-recovery"),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Setup recovery cron failed",
      "database unavailable",
    );
  });
});
