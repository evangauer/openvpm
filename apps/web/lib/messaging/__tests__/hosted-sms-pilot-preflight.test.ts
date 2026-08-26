import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn();
  const database = { execute };
  return {
    execute,
    database,
    withSystem: vi.fn(
      async (
        db: typeof database,
        action: (tx: typeof database) => Promise<unknown>,
      ) => action(db),
    ),
    heartbeatConfigured: vi.fn(() => ({
      ok: true,
      detail: "Job-specific cron heartbeat URLs configured",
    })),
    loadGate: vi.fn(async () => ({ total: 0 })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.database }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/cron-heartbeat", () => ({
  cronHeartbeatConfigured: mocks.heartbeatConfigured,
}));
vi.mock("../sms-provider-event-operations", () => ({
  loadSmsProviderEventGateSummaryInTransaction: mocks.loadGate,
}));

const { hostedSmsRolloutIntended, loadHostedSmsPilotActivationPreflight } =
  await import("../hosted-sms-pilot-preflight");

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOCATION_ID = "00000000-0000-4000-8000-000000000002";
const SECRET = "KEY_sensitive-not-for-output";
const SOURCE = readFileSync(
  "lib/messaging/hosted-sms-pilot-preflight.ts",
  "utf8",
);

function stubValidCredentials() {
  vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
  vi.stubEnv("TELNYX_API_KEY", `${SECRET}abcdefghijk`);
  vi.stubEnv("TELNYX_PUBLIC_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv(
    "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
    Buffer.alloc(32, 2).toString("base64"),
  );
}

function stubExactPilotScope() {
  vi.stubEnv("MESSAGING_PROVISIONING_PRACTICE_IDS", PRACTICE_ID);
  vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", PRACTICE_ID);
  vi.stubEnv("MESSAGING_SENDING_LOCATION_IDS", LOCATION_ID);
}

function scopeRow(
  overrides: Partial<{
    practiceActive: boolean;
    recoveryClear: boolean;
    carrierIdentityReady: boolean;
    providerProfileReady: boolean;
    providerProfileSyncedAt: Date | string | number | null;
    clinicSenderEnabled: boolean;
  }> = {},
) {
  return {
    practiceActive: true,
    recoveryClear: true,
    carrierIdentityReady: true,
    providerProfileReady: false,
    providerProfileSyncedAt: new Date(),
    clinicSenderEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue([scopeRow()]);
  mocks.heartbeatConfigured.mockReturnValue({
    ok: true,
    detail: "Job-specific cron heartbeat URLs configured",
  });
  mocks.loadGate.mockResolvedValue({ total: 0 });
});

afterEach(() => vi.unstubAllEnvs());

describe("hosted SMS pilot activation preflight", () => {
  it("keeps an unstaged rollout advisory and performs no database or provider work", async () => {
    stubValidCredentials();

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
      new Date("2026-08-25T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      stage: "deferred",
      ok: true,
      readyForInboundEnable: false,
      providerEventBlocking: null,
    });
    expect(hostedSmsRolloutIntended()).toBe(false);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(SOURCE).not.toContain("telnyx-provisioning");
    expect(SOURCE).not.toContain("updateMessagingProfileEnabled");
    expect(SOURCE).not.toContain("sendSms");
    expect(SOURCE).not.toContain("fetch(");
  });

  it("fails closed on a malformed launch flag instead of treating rollout as deferred", async () => {
    stubValidCredentials();
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "yes");

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(hostedSmsRolloutIntended()).toBe(true);
    expect(result).toMatchObject({ stage: "blocked", ok: false });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "launch_flag_invalid",
        "provisioning_scope_invalid",
      ]),
    );
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it.each([
    ["missing location", PRACTICE_ID, ""],
    ["malformed practice", "not-a-uuid", LOCATION_ID],
    ["multiple practices", `${PRACTICE_ID},${OTHER_PRACTICE_ID}`, LOCATION_ID],
  ])(
    "fails closed on %s in a staged sending scope",
    async (_, practice, location) => {
      stubValidCredentials();
      vi.stubEnv("MESSAGING_PROVISIONING_PRACTICE_IDS", PRACTICE_ID);
      vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", practice);
      vi.stubEnv("MESSAGING_SENDING_LOCATION_IDS", location);

      const result = await loadHostedSmsPilotActivationPreflight(
        mocks.database as never,
      );

      expect(result).toMatchObject({ stage: "blocked", ok: false });
      expect(result.blockers).toContain("sending_scope_invalid");
      expect(mocks.withSystem).not.toHaveBeenCalled();
    },
  );

  it("requires the exact same provisioning and sending practice", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", OTHER_PRACTICE_ID);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({ stage: "blocked", ok: false });
    expect(result.blockers).toContain("scope_mismatch");
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("requires both SMS heartbeat destinations for every rollout signal", async () => {
    stubValidCredentials();
    vi.stubEnv("MESSAGING_PROVISIONING_PRACTICE_IDS", PRACTICE_ID);
    mocks.heartbeatConfigured.mockReturnValue({
      ok: false,
      detail: "sensitive monitor configuration detail",
    });

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(mocks.heartbeatConfigured).toHaveBeenCalledWith([
      "sms-provider-events",
      "sms-operations",
    ]);
    expect(result.blockers).toContain("heartbeat_not_configured");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive monitor");
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("accepts an exact carrier-ready scope while inbound and sending remain off", async () => {
    stubValidCredentials();
    stubExactPilotScope();

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "scope_prepared",
      ok: true,
      blockers: [],
      readyForInboundEnable: true,
      readyForProviderActivation: false,
      readyForSendingEnable: false,
      checks: {
        carrierIdentityReady: true,
        providerProfileReady: false,
        providerEventsClear: true,
      },
    });
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.loadGate).toHaveBeenCalledWith(mocks.database, {
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
    });
  });

  it("fails closed when the database readiness query fails or returns no active practice", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    mocks.execute.mockRejectedValueOnce(new Error("postgres://secret-host/db"));

    const failed = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );
    expect(failed.blockers).toEqual(["readiness_check_failed"]);
    expect(JSON.stringify(failed)).not.toContain("secret-host");

    mocks.execute.mockResolvedValueOnce([]);
    const unavailable = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );
    expect(unavailable.blockers).toEqual(["pilot_practice_unavailable"]);
    expect(unavailable.ok).toBe(false);
  });

  it("blocks unresolved or malformed provider-event evidence without returning identifiers", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    mocks.loadGate.mockResolvedValueOnce({ total: 2 });

    const backlog = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );
    expect(backlog).toMatchObject({
      stage: "blocked",
      ok: false,
      providerEventBlocking: 2,
      checks: { providerEventsClear: false },
    });
    expect(backlog.blockers).toContain("provider_event_backlog");

    mocks.loadGate.mockResolvedValueOnce({ total: Number.NaN });
    const malformed = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );
    expect(malformed.blockers).toEqual(["readiness_check_failed"]);

    const serialized = JSON.stringify([backlog, malformed]);
    expect(serialized).not.toContain(PRACTICE_ID);
    expect(serialized).not.toContain(LOCATION_ID);
    expect(serialized).not.toContain(SECRET);
  });

  it("blocks held, carrier-incomplete, and sending-before-profile-ready states", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    mocks.execute.mockResolvedValue([
      scopeRow({
        recoveryClear: false,
        carrierIdentityReady: false,
        providerProfileReady: false,
      }),
    ]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result.blockers).toEqual([
      "practice_recovery_hold",
      "carrier_identity_not_ready",
      "provider_profile_not_ready",
    ]);
    expect(result.ok).toBe(false);
  });

  it.each([
    [false, false, "scope_prepared"],
    [true, false, "inbound_prepared"],
    [true, true, "provider_ready"],
  ])(
    "reports the safe sequence for inbound=%s profile=%s",
    async (inboundEnabled, providerProfileReady, stage) => {
      stubValidCredentials();
      stubExactPilotScope();
      vi.stubEnv("MESSAGING_INBOUND_ENABLED", String(inboundEnabled));
      mocks.execute.mockResolvedValue([scopeRow({ providerProfileReady })]);

      const result = await loadHostedSmsPilotActivationPreflight(
        mocks.database as never,
      );

      expect(result).toMatchObject({ stage, ok: true });
      if (stage === "inbound_prepared") {
        expect(result.readyForProviderActivation).toBe(false);
        expect(result.nextAction).toContain("provider-mutation kill-switch");
      }
    },
  );

  it("advertises provider activation only while the mutation switch is explicitly enabled", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    mocks.execute.mockResolvedValue([scopeRow()]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "inbound_prepared",
      ok: true,
      readyForProviderActivation: true,
    });
  });

  it.each([
    ["stale", "2026-08-25T11:44:59.999Z"],
    ["future", "2026-08-25T12:00:00.001Z"],
    ["malformed", "not-a-timestamp"],
  ])("blocks sending on a %s provider-profile attestation", async (_, observedAt) => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    mocks.execute.mockResolvedValue([
      scopeRow({
        providerProfileReady: true,
        providerProfileSyncedAt: observedAt,
      }),
    ]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
      now,
    );

    expect(result).toMatchObject({
      stage: "blocked",
      ok: false,
      checks: { providerProfileReady: false },
    });
    expect(result.blockers).toContain("provider_profile_not_ready");
  });

  it("accepts a provider-profile attestation at the exact freshness boundary", async () => {
    const now = new Date("2026-08-25T12:00:00.000Z");
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    mocks.execute.mockResolvedValue([
      scopeRow({
        providerProfileReady: true,
        providerProfileSyncedAt: "2026-08-25T11:45:00.000Z",
      }),
    ]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
      now,
    );

    expect(result).toMatchObject({
      stage: "provider_ready",
      ok: true,
      checks: { providerProfileReady: true },
    });
  });

  it("reports active only after inbound and provider profile readiness", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    mocks.execute.mockResolvedValue([
      scopeRow({ providerProfileReady: true, clinicSenderEnabled: true }),
    ]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "active",
      ok: true,
      detail: "Hosted SMS pilot configuration active",
    });
  });

  it("supports provisioning-only preparation without inventing location readiness", async () => {
    stubValidCredentials();
    vi.stubEnv("MESSAGING_PROVISIONING_PRACTICE_IDS", PRACTICE_ID);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "provisioning_prepared",
      ok: true,
      checks: {
        provisioningScopeExact: true,
        sendingScopeExact: null,
        carrierIdentityReady: null,
        providerProfileReady: null,
        providerEventsClear: true,
      },
    });
  });
});
