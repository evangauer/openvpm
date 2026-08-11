import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })),
  billingEnforced: vi.fn(() => true),
  createToken: vi.fn(() => "signed-attribution-token"),
  sendFirstClinicWinEmail: vi.fn(async () => ({
    success: true,
    id: "email_123",
    outcome: "accepted" as const,
  })),
  sendOptionalPlatformEmail: vi.fn(
    async (opts: { send: () => Promise<unknown> }) => {
      await opts.send();
      return { sent: true, deduped: false };
    },
  ),
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@openpims/db/client", () => ({
  db: { execute: mocks.execute },
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: mocks.execute }),
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD: 79,
}));

vi.mock("@/lib/billing/checkout-attribution", () => ({
  createSubscriptionCheckoutAttributionToken: mocks.createToken,
}));

vi.mock("@/lib/email", () => ({
  sendFirstClinicWinEmail: mocks.sendFirstClinicWinEmail,
}));

vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

vi.mock("@/lib/app-url", () => ({ appBaseUrl: () => "https://app.test" }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));

const {
  FIRST_CLINIC_WIN_DEDUPE_PREFIX,
  firstClinicWinCampaignConfiguration,
  previewFirstClinicWinCampaign,
  runFirstClinicWinCampaign,
} = await import("../first-clinic-win");

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.billingEnforced.mockReturnValue(true);
  mocks.createToken.mockReturnValue("signed-attribution-token");
  mocks.execute.mockResolvedValue({ rows: [] });
});

describe("first clinic win campaign", () => {
  it("is default-off and requires an explicit prospective launch boundary", () => {
    expect(firstClinicWinCampaignConfiguration()).toMatchObject({
      enabled: false,
    });

    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_ENABLED", "true");
    expect(firstClinicWinCampaignConfiguration()).toEqual({
      enabled: false,
      reason: "FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT is missing or invalid",
    });
  });

  it("previews a staged eligible batch without claiming or sending email", async () => {
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_ENABLED", "false");
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT", "2026-08-11T00:00:00.000Z");
    mocks.execute.mockResolvedValueOnce({
      rows: [{ candidateCount: 121 }],
    });

    await expect(
      previewFirstClinicWinCampaign(new Date("2026-08-11T16:00:00.000Z")),
    ).resolves.toEqual({
      enabled: false,
      ready: true,
      launchAt: "2026-08-11T00:00:00.000Z",
      configurationIssue: null,
      eligibleCandidates: 121,
      hasAdditionalCandidates: true,
      batchLimit: 100,
    });
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
    expect(mocks.sendFirstClinicWinEmail).not.toHaveBeenCalled();
  });

  it("reports an invalid preview configuration without querying clinic data", async () => {
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_ENABLED", "true");
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT", "not-a-date");

    await expect(previewFirstClinicWinCampaign()).resolves.toEqual({
      enabled: true,
      ready: false,
      launchAt: null,
      configurationIssue:
        "FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT is missing or invalid.",
      eligibleCandidates: 0,
      hasAdditionalCandidates: false,
      batchLimit: 100,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("sends one PHI-free, practice-wide conversion prompt with one provider key", async () => {
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_ENABLED", "true");
    vi.stubEnv("FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT", "2026-08-11T00:00:00.000Z");
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          id: PRACTICE_ID,
          name: "Neighborhood Veterinary",
          email: "owner@example.com",
          timezone: "America/New_York",
          trialEndsAt: "2026-08-20T04:00:00.000Z",
          firstVisitAt: "2026-08-11T15:00:00.000Z",
        },
      ],
    });

    await expect(
      runFirstClinicWinCampaign(new Date("2026-08-11T16:00:00.000Z")),
    ).resolves.toEqual({
      candidates: 1,
      sent: 1,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      disabled: false,
    });

    const dedupeKey = `${FIRST_CLINIC_WIN_DEDUPE_PREFIX}:${PRACTICE_ID}`;
    expect(mocks.createToken).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      source: "first_visit_email",
      evidenceId: "first-clinic-win:v1",
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "first-clinic-win",
        dedupeKey,
        retryOnFail: true,
        stillEligible: expect.any(Function),
      }),
    );
    expect(mocks.sendFirstClinicWinEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
        practiceName: "Neighborhood Veterinary",
        idempotencyKey: dedupeKey,
        billingUrl:
          "https://app.test/settings?tab=billing&checkout_attribution=signed-attribution-token",
      }),
    );
    expect(
      JSON.stringify(mocks.sendFirstClinicWinEmail.mock.calls),
    ).not.toMatch(/patient|client|appointment|closeout|invoice/i);
  });

  it("pins the prospective, verified-contact, non-demo candidate contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../first-clinic-win.ts", import.meta.url)),
      "utf8",
    );
    for (const invariant of [
      "vc.completed_at >= ${launchAt}",
      "a.status = 'checked_out'",
      "u.email_verified_at is not null",
      "payment_method_collected",
      "analyticsExcluded",
      "onboardingIntent",
      "appointmentIds",
      'order by candidate."firstVisitAt", candidate.id',
      "limit ${limit}",
      'select count(*)::int as "candidateCount"',
    ]) {
      expect(source).toContain(invariant);
    }
  });
});
