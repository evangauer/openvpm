import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyProviderReadinessResult,
  classifySmsMessagingStates,
  type SmsMessagingState,
} from "@/lib/messaging/sms-operations-health";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function state(overrides: Partial<SmsMessagingState> = {}): SmsMessagingState {
  return {
    practiceId: "practice-1",
    practiceName: "Clinic One",
    registrationId: "registration-1",
    registrationStatus: "active",
    providerBrandId: "brand-1",
    providerCampaignId: "campaign-1",
    submissionLockAt: null,
    lastSubmittedAt: "2026-08-09T11:50:00.000Z",
    lastSyncedAt: "2026-08-09T11:55:00.000Z",
    registrationUpdatedAt: "2026-08-09T11:55:00.000Z",
    locationId: "location-1",
    locationName: "Main",
    locationActive: true,
    provider: "telnyx",
    messagingProfileId: "profile-1",
    senderE164: "+15555550100",
    senderBrandId: "brand-1",
    senderCampaignId: "campaign-1",
    senderRegistrationStatus: "active",
    providerProfileReady: true,
    providerProfileSyncedAt: "2026-08-09T11:55:00.000Z",
    enabled: false,
    senderUpdatedAt: "2026-08-09T11:55:00.000Z",
    ...overrides,
  };
}

describe("SMS operations state classifier", () => {
  it("classifies every enabled-but-unsafe local gate as P0", () => {
    const issues = classifySmsMessagingStates(
      [
        state({
          enabled: true,
          registrationStatus: "pending",
          senderRegistrationStatus: "pending",
          messagingProfileId: null,
          senderE164: null,
          providerProfileReady: false,
          senderBrandId: "wrong-brand",
        }),
      ],
      NOW,
    );

    const criticalReasons = issues
      .filter((issue) => issue.severity === "p0")
      .map((issue) => issue.reasonCode);
    expect(criticalReasons).toEqual(
      expect.arrayContaining([
        "enabled_registration_inactive",
        "enabled_sender_inactive",
        "enabled_sender_identity_missing",
        "enabled_profile_not_ready",
        "enabled_registration_identity_drift",
      ]),
    );
  });

  it("does not call an enabled sender unsafe solely because attestation is old", () => {
    const issues = classifySmsMessagingStates(
      [
        state({
          enabled: true,
          providerProfileSyncedAt: "2026-08-08T12:00:00.000Z",
        }),
      ],
      NOW,
    );

    expect(issues).toEqual([]);
  });

  it("flags an expired disabled readiness attestation as P1", () => {
    const issues = classifySmsMessagingStates(
      [
        state({
          enabled: false,
          providerProfileReady: true,
          providerProfileSyncedAt: "2026-08-09T11:44:00.000Z",
        }),
      ],
      NOW,
    );

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "p1",
        category: "profile",
        reasonCode: "provider_attestation_expired",
        ageMinutes: 16,
      }),
    ]);
  });

  it("flags failed carrier state, stale locks, and stale pending work", () => {
    const issues = classifySmsMessagingStates(
      [
        state({
          registrationStatus: "action_required",
          senderRegistrationStatus: "failed",
          submissionLockAt: "2026-08-09T11:44:00.000Z",
          providerProfileReady: false,
        }),
        state({
          practiceId: "practice-2",
          practiceName: "Clinic Two",
          registrationStatus: "pending",
          senderRegistrationStatus: "not_started",
          providerProfileReady: false,
          lastSubmittedAt: "2026-08-08T10:00:00.000Z",
          lastSyncedAt: null,
          registrationUpdatedAt: "2026-08-08T10:00:00.000Z",
          providerProfileSyncedAt: null,
          senderUpdatedAt: "2026-08-08T10:00:00.000Z",
        }),
      ],
      NOW,
    );
    const reasons = issues.map((issue) => issue.reasonCode);

    expect(reasons).toEqual(
      expect.arrayContaining([
        "registration_action_required",
        "sender_failed",
        "stale_submission_lock",
        "registration_pending_stale",
        "sender_pending_stale",
      ]),
    );
  });

  it("flags more than one enabled hosted location once at practice level", () => {
    const issues = classifySmsMessagingStates(
      [
        state({ enabled: true }),
        state({
          locationId: "location-2",
          locationName: "North",
          messagingProfileId: "profile-2",
          senderE164: "+15555550101",
          enabled: true,
        }),
      ],
      NOW,
    );

    expect(
      issues.filter(
        (issue) => issue.reasonCode === "multiple_enabled_locations",
      ),
    ).toEqual([
      expect.objectContaining({ severity: "p0", locationName: null }),
    ]);
  });

  it("treats an enabled non-Telnyx hosted sender as P0", () => {
    const issues = classifySmsMessagingStates(
      [state({ enabled: true, provider: "twilio" })],
      NOW,
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "p0",
          reasonCode: "enabled_provider_unsupported",
        }),
      ]),
    );
  });

  it("separates orphaned deleted-location config from active profile drift", () => {
    const issues = classifySmsMessagingStates(
      [
        state({
          locationName: null,
          locationActive: false,
          providerProfileSyncedAt: "2026-08-09T10:00:00.000Z",
        }),
      ],
      NOW,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        severity: "p1",
        reasonCode: "inactive_location_configuration",
      }),
    );
  });
});

describe("SMS provider inspection classifier", () => {
  it("makes provider drift P0 for enabled senders and P1 while disabled", () => {
    const blocker = "messaging profile is disabled";
    expect(
      classifyProviderReadinessResult(state({ enabled: true }), NOW, {
        blockers: [blocker],
      }),
    ).toEqual([
      expect.objectContaining({
        severity: "p0",
        category: "profile",
        reasonCode: "provider_drift_messaging_profile_is_disabled",
      }),
    ]);
    expect(
      classifyProviderReadinessResult(state({ enabled: false }), NOW, {
        blockers: [blocker],
      }),
    ).toEqual([expect.objectContaining({ severity: "p1" })]);
  });

  it("treats a partial provider read failure as P1 without leaking details", () => {
    expect(
      classifyProviderReadinessResult(state({ enabled: true }), NOW, {
        failed: true,
      }),
    ).toEqual([
      expect.objectContaining({
        severity: "p1",
        reasonCode: "provider_audit_failed",
        reason: "Read-only provider readiness inspection did not complete.",
      }),
    ]);
  });
});

describe("SMS operations implementation safety", () => {
  it("depends on read-only provider inspection and contains no mutation or send", () => {
    const source = readFileSync(
      new URL("../sms-operations-health.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("inspectTelnyxProviderReadiness");
    expect(source).toContain("loadSmsSendAttemptQueue");
    expect(source).toContain("loadSmsDeliveryEventQueue");
    expect(source).toContain("providerAuditConcurrency = 4");
    expect(source).not.toContain("from sms_send_attempt_events");
    expect(source).not.toContain("from sms_delivery_event_history");
    expect(source).not.toMatch(
      /updateMessagingProfileEnabled|sendSms|retrySms|reconcileSms|MESSAGING_PROVISIONING_ENABLED/,
    );
  });
});
