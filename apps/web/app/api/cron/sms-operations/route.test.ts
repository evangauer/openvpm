import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmsOperationsHealth } from "@/lib/messaging/sms-operations-health";

const healthy: SmsOperationsHealth = {
  cacheControl: "no-store",
  generatedAt: "2026-08-09T12:00:00.000Z",
  status: "healthy",
  counts: {
    critical: 0,
    attention: 0,
    carrier: 0,
    profile: 0,
    sendAttempts: 0,
    deliveryEvents: 0,
    staleWithoutFinal: 0,
    providerAuditFailures: 0,
  },
  reasons: [],
  items: [],
  truncated: false,
  thresholds: {
    submissionLockMinutes: 15,
    pendingRegistrationMinutes: 1_440,
    providerAttestationMinutes: 15,
    sendAttemptMinutes: 15,
    deliveryReceiptMinutes: 60,
  },
};

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async (_subject: string, _detail: string) => undefined),
  cronAuthError: vi.fn((): Response | null => null),
  db: {},
  getSmsOperationsHealth: vi.fn(),
  reportCronHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/messaging/sms-operations-health", () => ({
  getSmsOperationsHealth: mocks.getSmsOperationsHealth,
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cronAuthError.mockReturnValue(null);
  mocks.getSmsOperationsHealth.mockResolvedValue(healthy);
});

describe("SMS operations cron", () => {
  it("requires cron authorization before reading operational evidence", async () => {
    mocks.cronAuthError.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    expect(response.status).toBe(401);
    expect(mocks.getSmsOperationsHealth).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).not.toHaveBeenCalled();
  });

  it("reports a healthy heartbeat without alerting", async () => {
    mocks.getSmsOperationsHealth.mockResolvedValueOnce(healthy);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "healthy",
      counts: healthy.counts,
      reasonGroups: 0,
      truncated: false,
    });
    expect(mocks.getSmsOperationsHealth).toHaveBeenCalledWith(mocks.db);
    expect(mocks.alertOps).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "sms-operations",
      status: "ok",
      detail: "No SMS operations exceptions",
      metrics: {
        status: "healthy",
        ...healthy.counts,
        reasonGroups: 0,
        truncated: false,
      },
    });
  });

  it("sends one bounded counts-only alert for critical exceptions", async () => {
    const reasons: SmsOperationsHealth["reasons"] = Array.from(
      { length: 15 },
      (_, index) => ({
        severity: index === 0 ? "p0" : "p1",
        category: index === 0 ? "profile" : "delivery_event",
        reason:
          index === 1
            ? "unsafe reason containing SENSITIVE_PRACTICE +15555550123"
            : `safe_reason_${index}`,
        count: index + 1,
      }),
    );
    const critical: SmsOperationsHealth = {
      ...healthy,
      status: "critical",
      counts: {
        critical: 2,
        attention: 8,
        carrier: 2,
        profile: 3,
        sendAttempts: 1,
        deliveryEvents: 4,
        staleWithoutFinal: 2,
        providerAuditFailures: 1,
      },
      reasons,
      items: [
        {
          severity: "p0",
          category: "profile",
          practiceName: "SENSITIVE_PRACTICE_NAME",
          locationName: "SENSITIVE_LOCATION_NAME",
          ageMinutes: 20,
          reason: "provider_profile_disabled",
          nextAction: "Call +15555550123 about SENSITIVE_PATIENT_NAME",
        },
      ],
      truncated: true,
    };
    mocks.getSmsOperationsHealth.mockResolvedValueOnce(critical);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    expect(response.status).toBe(200);
    expect(mocks.alertOps).toHaveBeenCalledTimes(1);
    const [subject, detail] = mocks.alertOps.mock.calls[0] ?? [];
    expect(subject).toBe("SMS operations critical");
    expect(detail).toContain("P0: at least 2; P1: at least 8");
    expect(detail).toContain(
      "The bounded queue is truncated; additional exceptions exist.",
    );
    expect(detail).toContain("Reason counts (bounded lower bounds)");
    expect(detail).toContain("p0/profile/safe_reason_0=1");
    expect(detail).toContain("p1/delivery_event/unclassified_delivery_event=2");
    expect(detail).toContain("p1/delivery_event/safe_reason_9=10");
    expect(detail).not.toContain("safe_reason_10");
    expect(detail).not.toContain("SENSITIVE_PRACTICE");
    expect(detail).not.toContain("SENSITIVE_LOCATION_NAME");
    expect(detail).not.toContain("SENSITIVE_PATIENT_NAME");
    expect(detail).not.toContain("+15555550123");
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "sms-operations",
      status: "degraded",
      detail: "At least 2 P0 and 8 P1 exception(s); bounded queue truncated",
      metrics: {
        status: "critical",
        ...critical.counts,
        reasonGroups: 15,
        truncated: true,
      },
    });
  });

  it("treats a partial provider audit failure as attention, not a mutation", async () => {
    const attention: SmsOperationsHealth = {
      ...healthy,
      status: "attention",
      counts: {
        ...healthy.counts,
        attention: 1,
        profile: 1,
        providerAuditFailures: 1,
      },
      reasons: [
        {
          severity: "p1",
          category: "profile",
          reason: "provider_audit_failed",
          count: 1,
        },
      ],
    };
    mocks.getSmsOperationsHealth.mockResolvedValueOnce(attention);

    await GET(new Request("https://openvpm.test/api/cron/sms-operations"));

    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS operations attention required",
      expect.stringContaining("provider_audit_failed=1"),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "sms-operations",
        status: "degraded",
        metrics: expect.objectContaining({ providerAuditFailures: 1 }),
      }),
    );
  });

  it("returns 200 and still attempts the heartbeat when alert delivery rejects", async () => {
    const attention: SmsOperationsHealth = {
      ...healthy,
      status: "attention",
      counts: { ...healthy.counts, attention: 1, carrier: 1 },
      reasons: [
        {
          severity: "p1",
          category: "carrier",
          reason: "submission_lock_stale",
          count: 1,
        },
      ],
    };
    mocks.getSmsOperationsHealth.mockResolvedValueOnce(attention);
    mocks.alertOps.mockRejectedValueOnce(new Error("alert transport failed"));

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "attention",
      counts: attention.counts,
      reasonGroups: 1,
      truncated: false,
    });
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "sms-operations",
        status: "degraded",
      }),
    );
  });

  it("returns 200 without alerting when a healthy heartbeat rejects", async () => {
    mocks.getSmsOperationsHealth.mockResolvedValueOnce(healthy);
    mocks.reportCronHeartbeat.mockRejectedValueOnce(
      new Error("heartbeat transport failed"),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: "healthy",
      counts: healthy.counts,
      reasonGroups: 0,
      truncated: false,
    });
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("returns 200 and reports a failed heartbeat when the read fails", async () => {
    mocks.getSmsOperationsHealth.mockRejectedValueOnce(
      new Error("provider response included +15555550123"),
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/sms-operations"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "SMS operations health check failed",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS operations health check failed",
      "Read-only SMS operations health computation failed. Review application logs; no automated action was taken.",
    );
    expect(mocks.alertOps).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("+15555550123"),
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith({
      job: "sms-operations",
      status: "failed",
      detail: "Read-only SMS operations health computation failed",
    });
  });

  it("has no mutation, send, retry, or reconciliation dependency", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(
      /sendSms|sendText|retrySms|reconcileSms|enableMessaging|disableMessaging|setMessaging|updateMessaging/,
    );
  });
});
