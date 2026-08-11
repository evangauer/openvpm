import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostedMessagingInboundProjectionDecision,
  hostedMessagingLaunchDecision,
  MESSAGING_INBOUND_ENABLED_ENV,
  MESSAGING_SENDING_ENABLED_ENV,
  MESSAGING_SENDING_LOCATION_IDS_ENV,
  MESSAGING_SENDING_PRACTICE_IDS_ENV,
} from "../launch-gate";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";

afterEach(() => vi.unstubAllEnvs());

function enablePilot() {
  vi.stubEnv(MESSAGING_SENDING_ENABLED_ENV, "true");
  vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, PRACTICE_ID);
  vi.stubEnv(MESSAGING_SENDING_LOCATION_IDS_ENV, LOCATION_ID);
}

describe("hostedMessagingLaunchDecision", () => {
  it("is default-off", () => {
    expect(
      hostedMessagingLaunchDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "platform_disabled" });
  });

  it("requires explicit practice and location scope", () => {
    enablePilot();
    expect(hostedMessagingLaunchDecision({ practiceId: PRACTICE_ID })).toEqual({
      allowed: false,
      reason: "missing_scope",
    });
    expect(hostedMessagingLaunchDecision({ locationId: LOCATION_ID })).toEqual({
      allowed: false,
      reason: "missing_scope",
    });
  });

  it("requires both allowlists", () => {
    enablePilot();
    vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, "another-practice");
    expect(
      hostedMessagingLaunchDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "practice_not_allowed" });

    vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, PRACTICE_ID);
    vi.stubEnv(MESSAGING_SENDING_LOCATION_IDS_ENV, "another-location");
    expect(
      hostedMessagingLaunchDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "location_not_allowed" });
  });

  it("trims the exact allowlist entries", () => {
    vi.stubEnv(MESSAGING_SENDING_ENABLED_ENV, "true");
    vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, ` ${PRACTICE_ID} `);
    vi.stubEnv(MESSAGING_SENDING_LOCATION_IDS_ENV, ` ${LOCATION_ID} `);
    expect(
      hostedMessagingLaunchDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: true });
  });

  it("fails closed when a hosted rollout contains multiple clinics", () => {
    enablePilot();
    vi.stubEnv(
      MESSAGING_SENDING_PRACTICE_IDS_ENV,
      `${PRACTICE_ID},another-practice`,
    );
    expect(
      hostedMessagingLaunchDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "missing_scope" });
  });
});

describe("hostedMessagingInboundProjectionDecision", () => {
  it("preserves self-host provider behavior", () => {
    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: true });
  });

  it("is independently default-off for hosted deployments", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, PRACTICE_ID);
    vi.stubEnv(MESSAGING_SENDING_LOCATION_IDS_ENV, LOCATION_ID);
    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "platform_disabled" });
  });

  it("requires the exact hosted pilot practice and location", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv(MESSAGING_INBOUND_ENABLED_ENV, "true");
    vi.stubEnv(MESSAGING_SENDING_PRACTICE_IDS_ENV, PRACTICE_ID);
    vi.stubEnv(MESSAGING_SENDING_LOCATION_IDS_ENV, LOCATION_ID);

    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: true });
    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: "another-practice",
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "practice_not_allowed" });
    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: PRACTICE_ID,
        locationId: "another-location",
      }),
    ).toEqual({ allowed: false, reason: "location_not_allowed" });

    vi.stubEnv(
      MESSAGING_SENDING_PRACTICE_IDS_ENV,
      `${PRACTICE_ID},another-practice`,
    );
    expect(
      hostedMessagingInboundProjectionDecision({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual({ allowed: false, reason: "missing_scope" });
  });
});
