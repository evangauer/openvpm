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
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(async () => result);
    return builder;
  });
  const db = { select };
  return {
    db,
    selectResults,
    billingEnforced: vi.fn(() => true),
    cronAuthError: vi.fn(() => null),
    reportCronHeartbeat: vi.fn(async () => undefined),
    alertOps: vi.fn(async () => undefined),
    sendFirstClinicWinEmail: vi.fn(async () => ({
      success: true,
      id: "email-first-win",
    })),
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
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/email", () => ({
  sendFirstClinicWinEmail: mocks.sendFirstClinicWinEmail,
}));
vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

const { GET } = await import("./route");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: PRACTICE_ID,
    name: "Neighborhood Veterinary",
    email: "owner@example.com",
    timezone: "America/New_York",
    trialEndsAt: new Date("2026-08-28T04:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-15T15:00:00Z"));
  vi.stubEnv("FIRST_CLINIC_WIN_ENABLED", "true");
  vi.stubEnv("FIRST_CLINIC_WIN_ROLLOUT_AT", "2026-08-15T12:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.selectResults.length = 0;
});

describe("first clinic win cron", () => {
  it("requires cron authorization before reading clinic state", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response("Unauthorized", { status: 401 }) as never,
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/first-clinic-win"),
    );

    expect(response.status).toBe(401);
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("is default-off without an explicit prospective rollout boundary", async () => {
    vi.stubEnv("FIRST_CLINIC_WIN_ENABLED", "false");

    const response = await GET(
      new Request("https://openvpm.test/api/cron/first-clinic-win"),
    );

    await expect(response.json()).resolves.toMatchObject({
      disabled: true,
      reason: "disabled",
      sent: 0,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("sends one PHI-free, exact-once message after final eligibility", async () => {
    mocks.selectResults.push(
      [candidate()],
      [{ id: PRACTICE_ID, email: "owner@example.com" }],
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/first-clinic-win"),
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      deduped: 0,
      suppressed: 0,
      failed: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "first-clinic-win",
        dedupeKey: `lc:first-clinic-win:v1:${PRACTICE_ID}`,
        retryOnFail: true,
        stillEligible: expect.any(Function),
      }),
    );
    expect(mocks.sendFirstClinicWinEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      practiceName: "Neighborhood Veterinary",
      trialEndDate: "August 28, 2026",
      idempotencyKey: `lc:first-clinic-win:v1:${PRACTICE_ID}`,
    });
  });

  it("suppresses a stale candidate before the provider call", async () => {
    mocks.selectResults.push([candidate()], []);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/first-clinic-win"),
    );

    await expect(response.json()).resolves.toMatchObject({
      sent: 0,
      suppressed: 1,
    });
    expect(mocks.sendFirstClinicWinEmail).not.toHaveBeenCalled();
  });

  it("requires verified admin contact, a post-rollout real closeout, and no card", () => {
    expect(ROUTE_SOURCE).toContain("u.email_verified_at is not null");
    expect(ROUTE_SOURCE).toContain("lower(btrim(u.email))");
    expect(ROUTE_SOURCE).toContain("vc.completed_at >= ${rolloutAt}");
    expect(ROUTE_SOURCE).toContain("a.status = 'checked_out'");
    expect(ROUTE_SOURCE).toContain("demoData");
    expect(ROUTE_SOURCE).toContain("payment_method_collected");
    expect(ROUTE_SOURCE).toContain("isNull(practices.stripeSubscriptionId)");
    expect(ROUTE_SOURCE).toContain("c.dedupe_key = 'lc:first-clinic-win:v1:'");
    expect(ROUTE_SOURCE).toContain("c.status <> 'pending'::comm_status");
    expect(ROUTE_SOURCE).not.toContain("clientName");
    expect(ROUTE_SOURCE).not.toContain("patientName");
  });
});
