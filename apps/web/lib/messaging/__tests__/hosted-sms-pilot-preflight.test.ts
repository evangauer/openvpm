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

const { loadHostedSmsPilotActivationPreflight } =
  await import("../hosted-sms-pilot-preflight");

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-4000-8000-0000000000bb";
const LOCATION_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE = readFileSync(
  "lib/messaging/hosted-sms-pilot-preflight.ts",
  "utf8",
);

function stubValidCredentials() {
  vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
  vi.stubEnv("TELNYX_API_KEY", "KEY_abcdefghijklmnopqrstuvwxyz");
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
    clinicSenderEnabled: boolean;
  }> = {},
) {
  return {
    practiceActive: true,
    recoveryClear: true,
    carrierIdentityReady: true,
    providerProfileReady: false,
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
      new Date("2026-08-11T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      stage: "deferred",
      ok: true,
      readyForInboundEnable: false,
      providerEventBlocking: null,
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(SOURCE).not.toContain("telnyx-provisioning");
    expect(SOURCE).not.toContain("updateMessagingProfileEnabled");
    expect(SOURCE).not.toContain("sendSms");
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

  it("keeps health prepared between inbound enablement and provider activation", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "inbound_prepared",
      ok: true,
      readyForInboundEnable: false,
      readyForProviderActivation: true,
      readyForSendingEnable: false,
    });
  });

  it("allows sending enablement only after the provider profile is ready", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    mocks.execute.mockResolvedValue([scopeRow({ providerProfileReady: true })]);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "provider_ready",
      ok: true,
      readyForSendingEnable: true,
    });
  });

  it("fails closed when sending is on before the provider profile is ready", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_INBOUND_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({
      stage: "blocked",
      ok: false,
      readyForSendingEnable: false,
    });
    expect(result.blockers).toContain("provider_profile_not_ready");
  });

  it("reports an active exact pilot after every global gate is ready", async () => {
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
    expect(result.nextAction).toContain("live SMS validation drill");
  });

  it("requires the exact same provisioning and sending practice", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", OTHER_PRACTICE_ID);

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result).toMatchObject({ stage: "blocked", ok: false });
    expect(result.blockers).toEqual(["scope_mismatch"]);
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("blocks unresolved provider evidence without returning scoped identifiers", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    mocks.loadGate.mockResolvedValue({ total: 2 });

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      stage: "blocked",
      ok: false,
      providerEventBlocking: 2,
      checks: { providerEventsClear: false },
    });
    expect(result.blockers).toContain("provider_event_backlog");
    expect(serialized).not.toContain(PRACTICE_ID);
    expect(serialized).not.toContain(LOCATION_ID);
  });

  it("blocks a held practice and missing heartbeat delivery configuration", async () => {
    stubValidCredentials();
    stubExactPilotScope();
    mocks.execute.mockResolvedValue([scopeRow({ recoveryClear: false })]);
    mocks.heartbeatConfigured.mockReturnValue({
      ok: false,
      detail: "Missing cron heartbeat URLs",
    });

    const result = await loadHostedSmsPilotActivationPreflight(
      mocks.database as never,
    );

    expect(result.blockers).toEqual([
      "practice_recovery_hold",
      "heartbeat_not_configured",
    ]);
    expect(result.ok).toBe(false);
  });

  it("supports a provisioning-only preparation stage without inventing location readiness", async () => {
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
      },
    });
  });
});
