import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(async () => [{ ok: 1, scopeValid: true }]),
  withSystem: vi.fn(
    async (
      database: { execute: typeof mocks.dbExecute },
      fn: (tx: { execute: typeof mocks.dbExecute }) => Promise<unknown>,
    ) => fn(database),
  ),
  billingEnforced: vi.fn(() => false),
  requiredMessagingEnvNames: vi.fn(() => [
    "TELNYX_API_KEY",
    "TELNYX_PUBLIC_KEY",
    "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
  ]),
  shouldAssertHostedRlsRole: vi.fn(() => false),
  inspectHostedRlsRole: vi.fn(async () => ({
    currentUser: "unsafe_owner",
    rolBypassRls: false,
    rolSuper: false,
    ownsTenantTables: false,
  })),
  hostedRlsRoleViolations: vi.fn(() => [] as string[]),
  cronHeartbeatConfigured: vi.fn(() => ({
    ok: false,
    detail: "Heartbeat URL missing",
  })),
  checkObjectStorageHealth: vi.fn(async () => ({
    ok: true,
    detail: "Object storage bucket reachable",
  })),
  checkReplicaStorageHealth: vi.fn(async () => ({
    ok: true,
    detail: "Replica object storage reachable",
  })),
  replicaStorageReadiness: vi.fn(() => ({
    intended: false,
    ready: false,
    detail: "Independent object replica is not configured",
  })),
  replicaStorageRequired: vi.fn(() => false),
  replicaStorageRolloutEnabled: vi.fn(() => false),
  getFileReplicaCoverage: vi.fn(async () => ({
    backlog: 0,
    available: 1,
    activeFiles: 1,
    coveragePct: 100,
  })),
  findSchemaDrift: vi.fn(async () => ({
    missingTables: [] as string[],
    missingColumns: [] as { table: string; column: string }[],
    invalidObjects: [] as Array<{
      kind:
        | "constraint"
        | "index"
        | "rls_policy"
        | "table_privilege"
        | "forbidden_table_privilege";
      table: string;
      name: string;
    }>,
  })),
  platformEmailIdentityConfigurationReady: vi.fn(async () => ({
    ready: true,
    initialized: true,
  })),
}));

vi.mock("@openpims/db/client", () => ({
  db: {
    execute: mocks.dbExecute,
  },
}));

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

vi.mock("@openpims/db/schema-drift", async () => {
  const actual = await vi.importActual<
    typeof import("@openpims/db/schema-drift")
  >("@openpims/db/schema-drift");
  return { ...actual, findSchemaDrift: mocks.findSchemaDrift };
});

vi.mock("@/lib/billing/plans", () => ({
  STRIPE_PRICE_CLOUD_LOCATION_ENV: "STRIPE_PRICE_CLOUD_LOCATION",
  billingEnforced: mocks.billingEnforced,
}));

vi.mock("@/lib/messaging", () => ({
  requiredMessagingEnvNames: mocks.requiredMessagingEnvNames,
}));

vi.mock("@/lib/rls-assertion", () => ({
  hostedRlsRoleViolations: mocks.hostedRlsRoleViolations,
  inspectHostedRlsRole: mocks.inspectHostedRlsRole,
  shouldAssertHostedRlsRole: mocks.shouldAssertHostedRlsRole,
}));

vi.mock("@/lib/cron-heartbeat", () => ({
  cronHeartbeatConfigured: mocks.cronHeartbeatConfigured,
}));

vi.mock("@/lib/s3", () => ({
  checkObjectStorageHealth: mocks.checkObjectStorageHealth,
  checkReplicaStorageHealth: mocks.checkReplicaStorageHealth,
  replicaStorageReadiness: mocks.replicaStorageReadiness,
  replicaStorageRequired: mocks.replicaStorageRequired,
  replicaStorageRolloutEnabled: mocks.replicaStorageRolloutEnabled,
}));

vi.mock("@/lib/file-replication", () => ({
  getFileReplicaCoverage: mocks.getFileReplicaCoverage,
}));

vi.mock("@/lib/platform-email-preferences", () => ({
  platformEmailIdentityConfigurationReady:
    mocks.platformEmailIdentityConfigurationReady,
}));

const { GET } = await import("./route");

function stubHostedRequiredEnvs() {
  vi.stubEnv("NEXTAUTH_URL", "https://app.example");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example");
  vi.stubEnv("NEXTAUTH_SECRET", "secret");
  vi.stubEnv("DATABASE_URL", "postgres://app@db.example/openvpm");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_invoice");
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect");
  vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "whsec_123");
  vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
  vi.stubEnv("STRIPE_TAX_ENABLED", "true");
  vi.stubEnv("S3_ENDPOINT", "https://storage.example");
  vi.stubEnv("S3_ACCESS_KEY", "access");
  vi.stubEnv("S3_SECRET_KEY", "secret");
  vi.stubEnv("S3_BUCKET", "clinic-private-bucket");
  vi.stubEnv("S3_REGION", "us-east-1");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_resend");
  vi.stubEnv(
    "EMAIL_PREFERENCE_IDENTITY_SECRET",
    "stable-identity-secret-at-least-32-bytes",
  );
  vi.stubEnv(
    "EMAIL_PREFERENCE_SIGNING_SECRET",
    "current-signing-secret-at-least-32-bytes",
  );
  vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS", "");
  vi.stubEnv("EMAIL_PREFERENCE_BASE_URL", "https://app.openvpm.com");
  vi.stubEnv("EMAIL_SUPPORT_ADDRESS", "support@openvpm.com");
  vi.stubEnv("EMAIL_COMPANY_ADDRESS", "123 Cloud Lane, Boston, MA");
  vi.stubEnv("AI_MODEL", "gemini-2.5-flash");
  vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "https://ops.example/hook");
  vi.stubEnv("CRON_HEARTBEAT_URL", "https://heartbeat.example/{job}");
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
  mocks.cronHeartbeatConfigured.mockReturnValue({
    ok: true,
    detail: "Cron heartbeat URL configured",
  });
}

function stubValidTelnyxEnvs() {
  vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
  vi.stubEnv("TELNYX_API_KEY", "KEY_abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("TELNYX_PUBLIC_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv(
    "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
    Buffer.alloc(32, 2).toString("base64"),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.dbExecute.mockResolvedValue([{ ok: 1, scopeValid: true }]);
  mocks.withSystem.mockImplementation(async (database, fn) => fn(database));
  mocks.billingEnforced.mockReturnValue(false);
  mocks.replicaStorageReadiness.mockReturnValue({
    intended: false,
    ready: false,
    detail: "Independent object replica is not configured",
  });
  mocks.replicaStorageRequired.mockReturnValue(false);
  mocks.replicaStorageRolloutEnabled.mockReturnValue(false);
  mocks.getFileReplicaCoverage.mockResolvedValue({
    backlog: 0,
    available: 1,
    activeFiles: 1,
    coveragePct: 100,
  });
  mocks.checkReplicaStorageHealth.mockResolvedValue({
    ok: true,
    detail: "Replica object storage reachable",
  });
  mocks.requiredMessagingEnvNames.mockReturnValue([
    "TELNYX_API_KEY",
    "TELNYX_PUBLIC_KEY",
    "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
  ]);
  mocks.shouldAssertHostedRlsRole.mockReturnValue(false);
  mocks.hostedRlsRoleViolations.mockReturnValue([]);
  mocks.inspectHostedRlsRole.mockResolvedValue({
    currentUser: "unsafe_owner",
    rolBypassRls: false,
    rolSuper: false,
    ownsTenantTables: false,
  });
  mocks.cronHeartbeatConfigured.mockReturnValue({
    ok: false,
    detail: "Heartbeat URL missing",
  });
  mocks.checkObjectStorageHealth.mockResolvedValue({
    ok: true,
    detail: "Object storage bucket reachable",
  });
  mocks.findSchemaDrift.mockResolvedValue({
    missingTables: [],
    missingColumns: [],
    invalidObjects: [],
  });
  mocks.platformEmailIdentityConfigurationReady.mockResolvedValue({
    ready: true,
    initialized: true,
  });
});

describe("health route schema drift", () => {
  it("reports healthy when the database matches the deployed code", async () => {
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.schema).toEqual({
      ok: true,
      detail: "Database schema matches the deployed code",
    });
  });

  it("fails the readiness gate when a migration was never applied", async () => {
    mocks.findSchemaDrift.mockResolvedValue({
      missingTables: [],
      missingColumns: [{ table: "soap_notes", column: "imported" }],
      invalidObjects: [],
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(json.checks.schema.ok).toBe(false);
    expect(json.checks.schema.detail).toContain("soap_notes.imported");
  });

  it("names a missing table so the operator knows what to apply", async () => {
    mocks.findSchemaDrift.mockResolvedValue({
      missingTables: ["invoice_adjustments"],
      missingColumns: [],
      invalidObjects: [],
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.schema.detail).toContain("invoice_adjustments");
  });

  it("skips the drift check when the database is unreachable", async () => {
    mocks.dbExecute.mockRejectedValueOnce(new Error("connection refused"));

    const response = await GET();
    const json = await response.json();

    expect(json.checks.database.ok).toBe(false);
    expect(json.checks.schema).toBeUndefined();
    expect(mocks.findSchemaDrift).not.toHaveBeenCalled();
  });

  it("does not leak connection details when the drift check itself fails", async () => {
    mocks.findSchemaDrift.mockRejectedValueOnce(
      new Error("password=secret host=prod-db"),
    );

    const response = await GET();
    const json = await response.json();

    expect(json.checks.schema).toEqual({
      ok: false,
      detail: "Schema drift check failed",
    });
    expect(JSON.stringify(json)).not.toContain("password=secret");
  });
});

describe("health route", () => {
  it("does not expose raw database errors in unauthenticated health checks", async () => {
    mocks.dbExecute.mockRejectedValueOnce(
      new Error("password=secret host=prod-db connection refused"),
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.database).toEqual({
      ok: false,
      detail: "Database check failed",
    });
    expect(JSON.stringify(json)).not.toContain("password=secret");
    expect(JSON.stringify(json)).not.toContain("prod-db");
  });

  it("reports hosted config readiness without listing env variable names", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    vi.stubEnv("AI_MODEL", "gemini-2.5-flash");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedCore.detail).toBe(
      "4 required hosted configuration values are missing",
    );
    expect(json.checks.hostedAppUrls.detail).toBe(
      "2 required hosted app URL values are missing",
    );
    expect(json.checks.hostedBilling.detail).toBe(
      "5 required hosted configuration values are missing",
    );
    expect(json.checks.hostedSubscriptionTax).toEqual({
      ok: false,
      detail: "Hosted subscription tax is not enabled",
    });
    expect(json.checks.hostedAi.detail).toBe(
      "1 required hosted configuration value is missing",
    );
    expect(json.checks.hostedEmail.detail).toBe(
      "7 required hosted configuration values are missing",
    );
    const body = JSON.stringify(json);
    expect(body).not.toContain("NEXTAUTH_SECRET");
    expect(body).not.toContain("NEXTAUTH_URL");
    expect(body).not.toContain("NEXT_PUBLIC_APP_URL");
    expect(body).not.toContain("DATABASE_URL");
    expect(body).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(body).not.toContain("STRIPE_CONNECT_WEBHOOK_SECRET");
    expect(body).not.toContain("STRIPE_TAX_ENABLED");
    expect(body).not.toContain("RESEND_WEBHOOK_SECRET");
    expect(body).not.toContain("EMAIL_PREFERENCE_IDENTITY_SECRET");
    expect(body).not.toContain("EMAIL_PREFERENCE_SIGNING_SECRET");
    expect(body).not.toContain("EMAIL_PREFERENCE_BASE_URL");
    expect(body).not.toContain("EMAIL_SUPPORT_ADDRESS");
    expect(body).not.toContain("EMAIL_COMPANY_ADDRESS");
    expect(body).not.toContain("STRIPE_PRICE_CLOUD_USER");
    expect(body).not.toContain("GOOGLE_API_KEY");
    expect(body).not.toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(body).not.toContain("TELNYX_API_KEY");
    expect(body).not.toContain("TELNYX_PUBLIC_KEY");
    expect(body).not.toContain("MESSAGING_REGISTRATION_ENCRYPTION_KEY");
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "3 required hosted SMS configuration issues detected",
      advisory: true,
    });
    expect(json.checks.hostedOpsAlerting).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(json.checks.hostedCronHeartbeat).toEqual({
      ok: false,
      detail: "Heartbeat URL missing",
    });
    expect(mocks.checkObjectStorageHealth).not.toHaveBeenCalled();
  });

  it("makes hosted SMS release-blocking as soon as provisioning is enabled", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv(
      "MESSAGING_PROVISIONING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "3 required hosted SMS configuration issues detected",
    });
    expect(JSON.stringify(json)).not.toContain("TELNYX_API_KEY");
    expect(JSON.stringify(json)).not.toContain(
      "MESSAGING_PROVISIONING_PRACTICE_IDS",
    );
  });

  it("reports credential shape while a valid hosted SMS rollout stays deferred", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedSms).toEqual({
      ok: true,
      detail: "Hosted Telnyx credentials are structurally valid",
      advisory: true,
    });
  });

  it("rejects an incomplete live hosted SMS pilot scope", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "1 required hosted SMS configuration issue detected",
    });
  });

  it("accepts one exact live Telnyx pilot scope", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedSms).toEqual({
      ok: true,
      detail: "Hosted SMS pilot configuration active",
    });
    expect(mocks.withSystem).toHaveBeenCalledOnce();
  });

  it("rejects different provisioning and sending clinic scopes", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv(
      "MESSAGING_PROVISIONING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000bb",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "1 required hosted SMS configuration issue detected",
    });
  });

  it("rejects a sending scope that is not carrier-ready in the database", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );
    mocks.dbExecute
      .mockResolvedValueOnce([{ ok: 1, scopeValid: true }])
      .mockResolvedValueOnce([{ ok: 1, scopeValid: false }]);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail:
        "Hosted SMS pilot scope does not match an active, carrier-ready clinic location",
    });
  });

  it("requires Telnyx explicitly when a pilot allowlist is staged", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv("MESSAGING_PROVIDER", "twilio");
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "1 required hosted SMS configuration issue detected",
    });
  });

  it("rejects malformed staged hosted SMS scope", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", "not-a-practice-id");
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "1 required hosted SMS configuration issue detected",
    });
  });

  it("rejects placeholder UUIDs in staged hosted SMS scope", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    stubValidTelnyxEnvs();
    vi.stubEnv(
      "MESSAGING_SENDING_PRACTICE_IDS",
      "00000000-0000-0000-0000-0000000000aa",
    );
    vi.stubEnv(
      "MESSAGING_SENDING_LOCATION_IDS",
      "00000000-0000-4000-8000-000000000002",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "1 required hosted SMS configuration issue detected",
    });
  });

  it("rejects placeholder-shaped Telnyx credentials during rollout", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
    vi.stubEnv("TELNYX_API_KEY", "test-api-key");
    vi.stubEnv("TELNYX_PUBLIC_KEY", "test-public-key");
    vi.stubEnv("MESSAGING_REGISTRATION_ENCRYPTION_KEY", "test-encryption-key");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv(
      "MESSAGING_PROVISIONING_PRACTICE_IDS",
      "00000000-0000-4000-8000-0000000000aa",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedSms).toEqual({
      ok: false,
      detail: "3 required hosted SMS configuration issues detected",
    });
    expect(JSON.stringify(json)).not.toContain("test-api-key");
    expect(JSON.stringify(json)).not.toContain("test-public-key");
  });

  it("does not require the legacy Cloud seat price for hosted readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedBilling).toEqual({
      ok: true,
      detail: "Hosted billing envs present",
    });
    expect(json.checks.hostedSubscriptionTax).toEqual({
      ok: true,
      detail: "Hosted subscription tax is enabled",
    });
    expect(json.checks.hostedAppUrls).toEqual({
      ok: true,
      detail: "Hosted app URLs are valid HTTPS origins",
    });
    expect(JSON.stringify(json)).not.toContain("STRIPE_PRICE_CLOUD_USER");
  });

  it("requires the client invoice webhook secret for hosted billing readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "   ");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedBilling).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(JSON.stringify(json)).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("requires the Stripe Connect webhook secret for hosted billing readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "   ");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedBilling).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(JSON.stringify(json)).not.toContain("STRIPE_CONNECT_WEBHOOK_SECRET");
  });

  it("requires Stripe Tax to be explicitly enabled for hosted readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("STRIPE_TAX_ENABLED", "false");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedBilling).toEqual({
      ok: true,
      detail: "Hosted billing envs present",
    });
    expect(json.checks.hostedSubscriptionTax).toEqual({
      ok: false,
      detail: "Hosted subscription tax is not enabled",
    });
    expect(JSON.stringify(json)).not.toContain("STRIPE_TAX_ENABLED");
  });

  it("requires the Resend webhook secret for hosted email readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "\t");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(JSON.stringify(json)).not.toContain("RESEND_WEBHOOK_SECRET");
  });

  it("requires a stable email preference identity secret", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", " ");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(JSON.stringify(json)).not.toContain(
      "EMAIL_PREFERENCE_IDENTITY_SECRET",
    );
  });

  it("rejects an email preference signing secret shorter than 32 bytes", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", "too-short");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is invalid",
    });
    expect(JSON.stringify(json)).not.toContain("too-short");
  });

  it("rejects an invalid previous email preference signing key ring", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv(
      "EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS",
      "valid-previous-signing-secret-at-least-32-bytes,short",
    );

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is invalid",
    });
    expect(JSON.stringify(json)).not.toContain("valid-previous-signing-secret");
    expect(JSON.stringify(json)).not.toContain("short");
  });

  it("requires the canonical platform preference origin", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("EMAIL_PREFERENCE_BASE_URL", "https://demo.openvpm.com");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is invalid",
    });
    expect(JSON.stringify(json)).not.toContain("demo.openvpm.com");
  });

  it("fails readiness when the persisted email identity key does not match", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.platformEmailIdentityConfigurationReady.mockResolvedValueOnce({
      ready: false,
      initialized: true,
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "Hosted email identity configuration does not match",
    });
    expect(JSON.stringify(json)).not.toContain("identityKeyFingerprint");
  });

  it("requires hosted email support contact identity", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("EMAIL_SUPPORT_ADDRESS", "   ");
    vi.stubEnv("EMAIL_COMPANY_ADDRESS", "\n");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "2 required hosted configuration values are missing",
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("EMAIL_SUPPORT_ADDRESS");
    expect(body).not.toContain("EMAIL_COMPANY_ADDRESS");
    expect(body).not.toContain("123 Cloud Lane");
  });

  it("ignores blank AI_MODEL values before selecting the hosted AI provider key", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("AI_MODEL", "   ");
    vi.stubEnv("AGENT_MODEL", " google/gemini-2.5-flash ");
    vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedAi).toEqual({
      ok: true,
      detail: "Hosted AI envs present",
    });
    expect(JSON.stringify(json)).not.toContain("ANTHROPIC_API_KEY");
  });

  it("accepts the legacy Google Generative AI key for hosted Gemini readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("AI_MODEL", "google/gemini-2.5-flash");
    vi.stubEnv("GOOGLE_API_KEY", "   ");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-fallback");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedAi).toEqual({
      ok: true,
      detail: "Hosted AI envs present",
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("GOOGLE_API_KEY");
    expect(body).not.toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(body).not.toContain("AIza-fallback");
  });

  it("fails hosted readiness when configured app URLs are not HTTPS origins", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("NEXTAUTH_URL", "https://user:pass@app.example");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://app.example/path");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedCore).toEqual({
      ok: true,
      detail: "Hosted core envs present",
    });
    expect(json.checks.hostedAppUrls).toEqual({
      ok: false,
      detail: "2 hosted app URL values are invalid",
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("http://app.example");
    expect(body).not.toContain("user:pass");
    expect(body).not.toContain("NEXTAUTH_URL");
    expect(body).not.toContain("NEXT_PUBLIC_APP_URL");
  });

  it("treats whitespace-only hosted env values as missing", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("STRIPE_SECRET_KEY", "   ");
    vi.stubEnv("S3_BUCKET", "\t");
    vi.stubEnv("RESEND_API_KEY", " ");
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "\n");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedBilling).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(json.checks.hostedStorage).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(json.checks.hostedEmail).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(json.checks.hostedOps).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(mocks.checkObjectStorageHealth).not.toHaveBeenCalled();
    const body = JSON.stringify(json);
    expect(body).not.toContain("STRIPE_SECRET_KEY");
    expect(body).not.toContain("S3_BUCKET");
    expect(body).not.toContain("RESEND_API_KEY");
    expect(body).not.toContain("PLATFORM_ADMIN_EMAILS");
  });

  it("requires at least one parsed platform-admin operator for hosted ops readiness", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", " , , ");

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedOps).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(JSON.stringify(json)).not.toContain("PLATFORM_ADMIN_EMAILS");
  });

  it("gates hosted readiness on ops alerting and cron heartbeat monitors", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    vi.stubEnv("OPS_ALERT_WEBHOOK_URL", "   ");
    mocks.cronHeartbeatConfigured.mockReturnValueOnce({
      ok: false,
      detail: "Missing cron heartbeat URL(s): reminders",
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedOpsAlerting).toEqual({
      ok: false,
      detail: "1 required hosted configuration value is missing",
    });
    expect(json.checks.hostedCronHeartbeat).toEqual({
      ok: false,
      detail: "Missing cron heartbeat URL(s): reminders",
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("OPS_ALERT_WEBHOOK_URL");
    expect(body).not.toContain("CRON_HEARTBEAT_URL");
  });

  it("checks object storage reachability when hosted storage envs are present", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.checkObjectStorageHealth.mockResolvedValueOnce({
      ok: false,
      detail: "Object storage check failed",
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(mocks.checkObjectStorageHealth).toHaveBeenCalledTimes(1);
    expect(json.checks.hostedStorage).toEqual({
      ok: false,
      detail: "Object storage check failed",
    });
    const body = JSON.stringify(json);
    expect(body).not.toContain("storage.example");
    expect(body).not.toContain("clinic-private-bucket");
  });

  it("keeps an intentionally absent file replica advisory", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail: "Independent object replica is not configured",
      advisory: true,
    });
    expect(mocks.checkReplicaStorageHealth).not.toHaveBeenCalled();
  });

  it("fails hosted readiness once the replica rollout is intended but incomplete", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: false,
      detail: "2 required replica storage values are missing",
    });
    mocks.replicaStorageRequired.mockReturnValueOnce(true);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail: "2 required replica storage values are missing",
      advisory: false,
    });
    expect(mocks.checkReplicaStorageHealth).not.toHaveBeenCalled();
    const body = JSON.stringify(json);
    expect(body).not.toContain("FILE_REPLICA_S3_ACCESS_KEY");
    expect(body).not.toContain("FILE_REPLICA_S3_SECRET_KEY");
  });

  it("gates partial replica rollout even before it is marked required", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: false,
      detail: "Replica rollout needs an exact practice cohort",
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail: "Replica rollout needs an exact practice cohort",
      advisory: false,
    });
    expect(mocks.checkReplicaStorageHealth).not.toHaveBeenCalled();
  });

  it("checks replica reachability when its complete rollout is enabled", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.replicaStorageRequired.mockReturnValueOnce(true);
    mocks.replicaStorageRolloutEnabled.mockReturnValueOnce(true);
    mocks.checkReplicaStorageHealth.mockResolvedValueOnce({
      ok: false,
      detail: "Replica object storage check failed",
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(mocks.checkReplicaStorageHealth).toHaveBeenCalledTimes(1);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail: "Replica object storage check failed",
      advisory: false,
    });
  });

  it("fails hosted readiness when required replica execution is disabled", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.replicaStorageRequired.mockReturnValueOnce(true);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail: "Independent file replica is required but execution is disabled",
      advisory: false,
    });
    expect(mocks.checkReplicaStorageHealth).not.toHaveBeenCalled();
  });

  it("fails hosted readiness when required replica coverage is incomplete", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.replicaStorageRequired.mockReturnValueOnce(true);
    mocks.replicaStorageRolloutEnabled.mockReturnValueOnce(true);
    mocks.getFileReplicaCoverage.mockResolvedValueOnce({
      backlog: 1,
      available: 2,
      activeFiles: 3,
      coveragePct: 66.67,
    });

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: false,
      detail:
        "2/3 active files independently available (66.67%); backlog 1",
      advisory: false,
    });
  });

  it("passes hosted readiness only after required replica coverage is complete", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    stubHostedRequiredEnvs();
    mocks.replicaStorageReadiness.mockReturnValueOnce({
      intended: true,
      ready: true,
      detail: "Replica storage envs present",
    });
    mocks.replicaStorageRequired.mockReturnValueOnce(true);
    mocks.replicaStorageRolloutEnabled.mockReturnValueOnce(true);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.checks.hostedFileReplica).toEqual({
      ok: true,
      detail:
        "1/1 active files independently available (100%); backlog 0",
      advisory: false,
    });
    expect(mocks.checkReplicaStorageHealth).toHaveBeenCalledTimes(1);
    expect(mocks.getFileReplicaCoverage).toHaveBeenCalledTimes(1);
  });

  it("does not expose the current database role when the hosted RLS check fails", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.shouldAssertHostedRlsRole.mockReturnValue(true);
    mocks.hostedRlsRoleViolations.mockReturnValue(["role owns tenant tables"]);

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.checks.hostedRlsRole).toEqual({
      ok: false,
      detail: "Hosted database role is not RLS-safe",
    });
    expect(JSON.stringify(json)).not.toContain("unsafe_owner");
    expect(JSON.stringify(json)).not.toContain("role owns tenant tables");
  });
});
