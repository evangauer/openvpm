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

const { GET } = await import("./route");

function funnel(days: number, totals: Partial<ActivationFunnel["totals"]> = {}): ActivationFunnel {
  return {
    days,
    weeks: [],
    totals: {
      signups: 5,
      setupStarted: 3,
      setupCompleted: 2,
      activated: 2,
      billingStarted: 2,
      subscribed: 1,
      setupStartRate: 0.6,
      setupCompletionRate: 0.4,
      activationRate: 0.4,
      billingStartRate: 0.4,
      conversionRate: 0.2,
      ...totals,
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
      registrations: 5,
      activated: 2,
      cardAdded: 1,
      paid: 1,
      leftBeforeTrying: 12,
      demoAbandoned: 3,
      registrationAbandoned: 3,
      activationAbandoned: 1,
      cardAbandoned: 0,
      unattributedRegistrations: 0,
      clientErrors: 2,
      demoRate: 0.4,
      registrationRate: 0.25,
      activationRate: 0.4,
      cardRate: 0.5,
      paidRate: 1,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("activation digest cron", () => {
  it("requires cron authorization before computing anything", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }) as never
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest")
    );

    expect(response.status).toBe(401);
    expect(mocks.computeActivationFunnel).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("skips sending when no platform admin emails are configured", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest")
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
    vi.stubEnv(
      "PLATFORM_ADMIN_EMAILS",
      "founder@openvpm.com, ops@openvpm.com"
    );
    mocks.computeActivationFunnel.mockImplementation(
      async (_db: unknown, days: number) => funnel(days)
    );
    mocks.computeJourneyFunnel.mockImplementation(
      async (_db: unknown, days: number) => journey(days)
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest")
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
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "founder@openvpm.com",
        subject: "OpenVPM trial funnel: 5 signups, 2 activated this week",
        html: expect.stringContaining("Past 30 days"),
      })
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Billing started"),
      })
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining("Production journey · past 30 days"),
      })
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ops@openvpm.com" })
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
      async (_db: unknown, days: number) => funnel(days)
    );
    mocks.computeJourneyFunnel.mockImplementation(
      async (_db: unknown, days: number) => journey(days)
    );
    mocks.sendEmail.mockResolvedValueOnce({
      success: false,
      error: "Provider down",
    } as never);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest")
    );

    await expect(response.json()).resolves.toEqual({
      recipients: 1,
      sent: 0,
      failed: 1,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Activation digest had send failures",
      "1 of 1 digest emails failed to send."
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
      new Error("relation practices does not exist")
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/activation-digest")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Activation digest failed",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Activation digest cron failed",
      "relation practices does not exist"
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "activation-digest",
      status: "failed",
      detail: "relation practices does not exist",
    });
  });
});
