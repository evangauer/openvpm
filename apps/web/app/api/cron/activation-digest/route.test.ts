import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivationFunnel } from "@/lib/admin/activation-funnel";
import type { JourneyFunnel } from "@/lib/admin/journey-funnel";

const mocks = vi.hoisted(() => ({
  db: {},
  alertOps: vi.fn(async () => undefined),
  cronAuthError: vi.fn(() => null),
  reportCronHeartbeat: vi.fn(async () => undefined),
  sendEmail: vi.fn(async () => ({ success: true, id: "email_123" })),
  computeActivationFunnel: vi.fn(),
  computeJourneyFunnel: vi.fn(),
  loadClinicPilotQueue: vi.fn(async () => []),
}));

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/admin/activation-funnel", () => ({
  computeActivationFunnel: mocks.computeActivationFunnel,
}));

vi.mock("@/lib/admin/journey-funnel", () => ({
  computeJourneyFunnel: mocks.computeJourneyFunnel,
}));

vi.mock("@/lib/admin/clinic-pilots", () => ({
  loadClinicPilotQueue: mocks.loadClinicPilotQueue,
}));

const { GET } = await import("./route");

function jurisdictionTotals(
  signups: number,
  activated: number,
): ActivationFunnel["totals"] {
  return {
    signups,
    setupStarted: 0,
    setupCompleted: 0,
    activated,
    firstVisitCompleted: 0,
    paymentMethodCollected: 0,
    firstPositivePayment: 0,
    currentlyActive: 0,
    setupStartRate: 0,
    setupCompletionRate: 0,
    activationRate: signups > 0 ? activated / signups : 0,
    firstVisitCompletionRate: 0,
    paymentMethodRate: 0,
    positivePaymentRate: 0,
    currentlyActiveRate: 0,
  };
}

function funnel(
  days: number,
  totals: Partial<ActivationFunnel["totals"]> = {},
): ActivationFunnel {
  return {
    days,
    weeks: [],
    totals: {
      signups: 5,
      setupStarted: 3,
      setupCompleted: 2,
      activated: 2,
      firstVisitCompleted: 1,
      paymentMethodCollected: 2,
      firstPositivePayment: 1,
      currentlyActive: 1,
      setupStartRate: 0.6,
      setupCompletionRate: 0.4,
      activationRate: 0.4,
      firstVisitCompletionRate: 0.5,
      paymentMethodRate: 1,
      positivePaymentRate: 0.5,
      currentlyActiveRate: 0.2,
      ...totals,
    },
    jurisdictionCohorts: {
      confirmedUs: jurisdictionTotals(3, 2),
      confirmedNonUs: jurisdictionTotals(1, 0),
      unknown: jurisdictionTotals(1, 0),
    },
    firstVisitBillingConversion: {
      maturedFirstVisits: 1,
      alreadyConnectedAtVisit: 0,
      opportunities: 1,
      convertedWithin24Hours: 0,
      convertedWithin72Hours: 1,
      conversionWithin24HoursRate: 0,
      conversionWithin72HoursRate: 1,
    },
    dataQuality: {
      confirmedUsSignups: 3,
      confirmedNonUsSignups: 1,
      unknownJurisdictionSignups: 1,
      legacyBusinessStageRows: 4,
      unknownPaymentMethodPractices: 1,
      unknownPositivePaymentPractices: 1,
      missingRegistrationMilestones: 0,
      missingActivationMilestones: 0,
      unprojectedStripeEvidence: 0,
      unmappedStripeEvidence: 0,
    },
  };
}

function journey(days: number): JourneyFunnel {
  return {
    days,
    weeks: [],
    totals: {
      visitors: 20,
      demos: 8,
      signupProfileViewed: 6,
      signupProfileCompleted: 5,
      signupAccountViewed: 5,
      signupSubmitted: 5,
      registrations: 5,
      activated: 2,
      paymentMethodCollected: 1,
      firstPositivePayment: 1,
      leftBeforeTrying: 12,
      demoAbandoned: 3,
      registrationAbandoned: 3,
      activationAbandoned: 1,
      paymentAbandoned: 0,
      unattributedRegistrations: 0,
      historicalUnattributedRegistrations: 0,
      repairableAttributionGaps: 0,
      clientErrors: 2,
      demoRate: 0.4,
      profileViewRate: 0.3,
      profileCompletionRate: 5 / 6,
      accountViewRate: 1,
      signupSubmitRate: 1,
      signupSuccessRate: 1,
      registrationRate: 0.25,
      activationRate: 0.4,
      paymentMethodRate: 0.5,
      positivePaymentRate: 1,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.loadClinicPilotQueue.mockResolvedValue([]);
});

describe("activation digest cron", () => {
  it("requires cron authorization before computing anything", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never,
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest"),
    );

    expect(response.status).toBe(401);
    expect(mocks.computeActivationFunnel).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("skips sending when no platform admin emails are configured", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest"),
    );

    await expect(response.json()).resolves.toEqual({
      recipients: 0,
      sent: 0,
      failed: 0,
    });
    expect(mocks.computeActivationFunnel).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "activation-digest",
      status: "ok",
      detail: "No platform admin emails configured; digest skipped",
      metrics: { recipients: 0, sent: 0, failed: 0 },
    });
  });

  it("emails the 7-day and 30-day funnel to every platform admin", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "founder@openvpm.com, ops@openvpm.com");
    mocks.computeActivationFunnel.mockImplementation(
      async (_db: unknown, days: number) => funnel(days),
    );
    mocks.computeJourneyFunnel.mockImplementation(
      async (_db: unknown, days: number) => journey(days),
    );
    mocks.loadClinicPilotQueue.mockResolvedValueOnce([
      {
        practiceName: "North <Clinic>",
        stage: "visit_validation",
        decision: "approved",
        nextAction: "complete_first_visit",
        nextReviewAt: new Date("2026-08-11T12:00:00.000Z"),
        blockerCodes: [],
        evidence: {
          firstVisitCompletedAt: new Date("2026-08-10T12:00:00.000Z"),
          distinctClinicDays: 1,
          paymentMethodCollectedAt: null,
          firstPositivePaymentAt: null,
        },
      },
    ] as never);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest"),
    );

    await expect(response.json()).resolves.toEqual({
      recipients: 2,
      sent: 2,
      failed: 0,
    });
    expect(mocks.computeActivationFunnel).toHaveBeenCalledWith(mocks.db, 7);
    expect(mocks.computeActivationFunnel).toHaveBeenCalledWith(mocks.db, 30);
    expect(mocks.computeJourneyFunnel).toHaveBeenCalledWith(mocks.db, 7);
    expect(mocks.computeJourneyFunnel).toHaveBeenCalledWith(mocks.db, 30);
    expect(mocks.loadClinicPilotQueue).toHaveBeenCalledWith(mocks.db);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "founder@openvpm.com",
        subject: "OpenVPM trial funnel: 5 signups, 2 activated this week",
        html: expect.stringContaining("Past 30 days"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Payment method"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining(
          "Jurisdiction cohorts:</strong> US 3 signup(s) → 2 activated",
        ),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("First visit done"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("its rate is measured from signups"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Production journey · past 30 days"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Supported clinic cohort"),
      }),
    );
    const html =
      (
        mocks.sendEmail.mock.calls as unknown as Array<[{ html: string }]>
      )[0]?.[0].html ?? "";
    expect(html).not.toContain("North &lt;Clinic&gt;");
    expect(html).not.toContain("North <Clinic>");
    expect(html).toContain("aggregate-only");
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@openvpm.com" }),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "activation-digest",
      status: "ok",
      detail: "2 sent, 0 failed",
      metrics: { recipients: 2, sent: 2, failed: 0 },
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("counts send failures, alerts ops, and reports a degraded heartbeat", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "founder@openvpm.com");
    mocks.computeActivationFunnel.mockImplementation(
      async (_db: unknown, days: number) => funnel(days),
    );
    mocks.computeJourneyFunnel.mockImplementation(
      async (_db: unknown, days: number) => journey(days),
    );
    mocks.sendEmail.mockResolvedValueOnce({
      success: false,
      error: "Provider down",
    } as never);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest"),
    );

    await expect(response.json()).resolves.toEqual({
      recipients: 1,
      sent: 0,
      failed: 1,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Activation digest had send failures",
      "1 of 1 digest emails failed to send.",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "activation-digest",
      status: "degraded",
      detail: "0 sent, 1 failed",
      metrics: { recipients: 1, sent: 0, failed: 1 },
    });
  });

  it("never throws when the funnel query fails; it alerts ops instead", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "founder@openvpm.com");
    mocks.computeActivationFunnel.mockRejectedValue(
      new Error("relation practices does not exist"),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Activation digest failed",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Activation digest cron failed",
      "relation practices does not exist",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "activation-digest",
      status: "failed",
      detail: "relation practices does not exist",
    });
  });
});
