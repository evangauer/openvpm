import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  describeDrift,
  driftIsClean,
  findSchemaDrift,
} from "@openpims/db/schema-drift";
import {
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
  billingEnforced,
} from "@/lib/billing/plans";
import {
  hostedRlsRoleViolations,
  inspectHostedRlsRole,
  shouldAssertHostedRlsRole,
} from "@/lib/rls-assertion";
import { cronHeartbeatConfigured } from "@/lib/cron-heartbeat";
import { envFlagEnabled } from "@/lib/env-bool";
import {
  checkObjectStorageHealth,
  checkReplicaStorageHealth,
  replicaStorageReadiness,
  replicaStorageRequired,
  replicaStorageRolloutEnabled,
} from "@/lib/s3";
import { getFileReplicaCoverage } from "@/lib/file-replication";
import { normalizeAppBaseUrl } from "@/lib/app-url";
import { platformAdminEmails } from "@/lib/platform-admin";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import {
  CANONICAL_EMAIL_PREFERENCE_BASE_URL,
  isValidEmailPreferencePreviousSecrets,
  isValidEmailPreferenceSecret,
  normalizeEmailPreferenceBaseUrl,
} from "@/lib/email-preferences";
import { platformEmailIdentityConfigurationReady } from "@/lib/platform-email-preferences";
import { hostedSmsCredentialIssueCount } from "@/lib/messaging/hosted-sms-readiness";

export const dynamic = "force-dynamic";

function configured(name: string): boolean {
  return (process.env[name]?.trim().length ?? 0) > 0;
}

function envValue(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

// Overage price envs (STRIPE_PRICE_SMS_OVERAGE / STRIPE_PRICE_AI_OVERAGE) drive
// metered overage via Stripe Billing Meters. They are NOT required here so the
// app still boots before the meters are configured (and so usage is recorded
// even when overage billing is intentionally off). See lib/billing/usage.ts.
const HOSTED_BILLING_ENV_NAMES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET",
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
];
const HOSTED_SUBSCRIPTION_TAX_ENV_NAME = "STRIPE_TAX_ENABLED";

const HOSTED_CORE_ENV_NAMES = [
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXTAUTH_SECRET",
  "DATABASE_URL",
];

const HOSTED_APP_URL_ENV_NAMES = ["NEXTAUTH_URL", "NEXT_PUBLIC_APP_URL"];

const HOSTED_STORAGE_ENV_NAMES = [
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "S3_REGION",
];

const HOSTED_EMAIL_ENV_NAMES = [
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "EMAIL_PREFERENCE_IDENTITY_SECRET",
  "EMAIL_PREFERENCE_SIGNING_SECRET",
  "EMAIL_PREFERENCE_BASE_URL",
  "EMAIL_SUPPORT_ADDRESS",
  "EMAIL_COMPANY_ADDRESS",
];
const HOSTED_SMS_PROVISIONING_PRACTICE_IDS_ENV =
  "MESSAGING_PROVISIONING_PRACTICE_IDS";
const HOSTED_SMS_SENDING_PRACTICE_IDS_ENV = "MESSAGING_SENDING_PRACTICE_IDS";
const HOSTED_SMS_SENDING_LOCATION_IDS_ENV = "MESSAGING_SENDING_LOCATION_IDS";
const HOSTED_GOOGLE_AI_ENV_NAMES = [
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];
const HOSTED_ANTHROPIC_AI_ENV_NAMES = ["ANTHROPIC_API_KEY"];

// AI is provider-agnostic: the model is chosen by AI_MODEL and the provider is
// inferred from the id, so require the matching provider key (Gemini vs Claude).
function activeAiModel(): string {
  return envValue("AI_MODEL") ?? envValue("AGENT_MODEL") ?? "claude-sonnet-4-6";
}

function isGeminiModel(model: string): boolean {
  return /^(google\/|models\/)?gemini/i.test(model);
}

function hostedAiCheck(): { ok: boolean; detail: string } {
  const model = activeAiModel();
  if (isGeminiModel(model)) {
    const ok = HOSTED_GOOGLE_AI_ENV_NAMES.some((name) => configured(name));
    return {
      ok,
      detail: ok
        ? "Hosted AI envs present"
        : "1 required hosted configuration value is missing",
    };
  }

  return hostedEnvCheck(
    HOSTED_ANTHROPIC_AI_ENV_NAMES,
    "Hosted AI envs present",
  );
}

// Required ops config: cron auth + at least one platform-admin operator.
const HOSTED_OPS_ENV_NAMES = ["CRON_SECRET"];

const HOSTED_OPS_ALERTING_ENV_NAMES = ["OPS_ALERT_WEBHOOK_URL"];

function hostedEnvCheck(
  names: string[],
  presentDetail: string,
): { ok: boolean; detail: string } {
  const missing = names.filter((name) => !configured(name));
  return {
    ok: missing.length === 0,
    detail:
      missing.length > 0
        ? `${missing.length} required hosted configuration value${
            missing.length === 1 ? " is" : "s are"
          } missing`
        : presentDetail,
  };
}

async function hostedEmailCheck(): Promise<{ ok: boolean; detail: string }> {
  const missing = HOSTED_EMAIL_ENV_NAMES.filter((name) => !configured(name));
  const requiredSecrets = [
    "EMAIL_PREFERENCE_IDENTITY_SECRET",
    "EMAIL_PREFERENCE_SIGNING_SECRET",
  ];
  const invalidSecrets = requiredSecrets.filter(
    (name) =>
      configured(name) && !isValidEmailPreferenceSecret(process.env[name]),
  );
  const invalidPreviousSecrets =
    configured("EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS") &&
    !isValidEmailPreferencePreviousSecrets(
      process.env.EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS,
    );
  const preferenceBaseUrl = normalizeEmailPreferenceBaseUrl(
    process.env.EMAIL_PREFERENCE_BASE_URL,
  );
  const invalidBaseUrl =
    configured("EMAIL_PREFERENCE_BASE_URL") &&
    preferenceBaseUrl !== CANONICAL_EMAIL_PREFERENCE_BASE_URL;
  const invalid =
    invalidSecrets.length +
    (invalidPreviousSecrets ? 1 : 0) +
    (invalidBaseUrl ? 1 : 0);
  const issues = missing.length + invalid;
  const envResult = {
    ok: issues === 0,
    detail:
      issues > 0
        ? `${issues} required hosted configuration value${
            issues === 1 ? " is" : "s are"
          } ${
            invalid > 0
              ? missing.length > 0
                ? "missing or invalid"
                : "invalid"
              : "missing"
          }`
        : "Hosted email envs present",
  };
  if (!envResult.ok) return envResult;

  try {
    const identity = await platformEmailIdentityConfigurationReady();
    return identity.ready
      ? envResult
      : {
          ok: false,
          detail: "Hosted email identity configuration does not match",
        };
  } catch {
    return {
      ok: false,
      detail: "Hosted email identity readiness check failed",
    };
  }
}

function hostedOpsCheck(): { ok: boolean; detail: string } {
  let missing = HOSTED_OPS_ENV_NAMES.filter((name) => !configured(name)).length;
  if (platformAdminEmails().length === 0) missing += 1;
  return {
    ok: missing === 0,
    detail:
      missing > 0
        ? `${missing} required hosted configuration value${
            missing === 1 ? " is" : "s are"
          } missing`
        : "Hosted ops envs present",
  };
}

function hostedAppUrlCheck(): { ok: boolean; detail: string } {
  const missing = HOSTED_APP_URL_ENV_NAMES.filter((name) => !configured(name));
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `${missing.length} required hosted app URL value${
        missing.length === 1 ? " is" : "s are"
      } missing`,
    };
  }

  const invalid = HOSTED_APP_URL_ENV_NAMES.filter((name) => {
    const normalized = normalizeAppBaseUrl(process.env[name]);
    return !normalized || new URL(normalized).protocol !== "https:";
  });
  if (invalid.length > 0) {
    return {
      ok: false,
      detail: `${invalid.length} hosted app URL value${
        invalid.length === 1 ? " is" : "s are"
      } invalid`,
    };
  }

  return { ok: true, detail: "Hosted app URLs are valid HTTPS origins" };
}

function hostedSubscriptionTaxCheck(): { ok: boolean; detail: string } {
  const ok = envFlagEnabled(HOSTED_SUBSCRIPTION_TAX_ENV_NAME);
  return {
    ok,
    detail: ok
      ? "Hosted subscription tax is enabled"
      : "Hosted subscription tax is not enabled",
  };
}

function commaSeparatedValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isExactPilotScope(values: string[]): boolean {
  return values.length === 1 && isUuid(values[0]!);
}

function hostedTelnyxCredentialCheck(): { ok: boolean; detail: string } {
  const issueCount = hostedSmsCredentialIssueCount();
  return issueCount > 0
    ? {
        ok: false,
        detail: `${issueCount} required hosted SMS configuration ${
          issueCount === 1 ? "issue" : "issues"
        } detected`,
      }
    : {
        ok: true,
        detail: "Hosted Telnyx credentials are structurally valid",
      };
}

function hostedSmsRolloutIntended(): boolean {
  return (
    envFlagEnabled("MESSAGING_PROVISIONING_ENABLED") ||
    envFlagEnabled("MESSAGING_SENDING_ENABLED") ||
    envFlagEnabled("MESSAGING_INBOUND_ENABLED") ||
    commaSeparatedValues(HOSTED_SMS_PROVISIONING_PRACTICE_IDS_ENV).length > 0 ||
    commaSeparatedValues(HOSTED_SMS_SENDING_PRACTICE_IDS_ENV).length > 0 ||
    commaSeparatedValues(HOSTED_SMS_SENDING_LOCATION_IDS_ENV).length > 0
  );
}

async function hostedSmsRolloutCheck(): Promise<{
  ok: boolean;
  detail: string;
}> {
  const credentialIssues = hostedSmsCredentialIssueCount();
  const provisioningEnabled = envFlagEnabled("MESSAGING_PROVISIONING_ENABLED");
  const sendingEnabled = envFlagEnabled("MESSAGING_SENDING_ENABLED");
  const inboundEnabled = envFlagEnabled("MESSAGING_INBOUND_ENABLED");
  const provisioningPracticeIds = commaSeparatedValues(
    HOSTED_SMS_PROVISIONING_PRACTICE_IDS_ENV,
  );
  const sendingPracticeIds = commaSeparatedValues(
    HOSTED_SMS_SENDING_PRACTICE_IDS_ENV,
  );
  const sendingLocationIds = commaSeparatedValues(
    HOSTED_SMS_SENDING_LOCATION_IDS_ENV,
  );
  const provisioningScopePrepared = provisioningPracticeIds.length > 0;
  const sendingScopePrepared =
    sendingPracticeIds.length > 0 || sendingLocationIds.length > 0;

  let configurationIssues = 0;
  if (envValue("MESSAGING_PROVIDER")?.toLowerCase() !== "telnyx") {
    configurationIssues += 1;
  }
  if (
    (provisioningEnabled || provisioningScopePrepared) &&
    !isExactPilotScope(provisioningPracticeIds)
  ) {
    configurationIssues += 1;
  }
  if (
    (sendingEnabled || sendingScopePrepared) &&
    (!isExactPilotScope(sendingPracticeIds) ||
      !isExactPilotScope(sendingLocationIds))
  ) {
    configurationIssues += 1;
  }
  if (
    (sendingEnabled || sendingScopePrepared || inboundEnabled) &&
    !inboundEnabled
  ) {
    configurationIssues += 1;
  }
  if (inboundEnabled && !sendingScopePrepared) {
    configurationIssues += 1;
  }
  if (
    provisioningScopePrepared &&
    sendingScopePrepared &&
    provisioningPracticeIds[0] !== sendingPracticeIds[0]
  ) {
    configurationIssues += 1;
  }

  const issueCount = credentialIssues + configurationIssues;
  if (issueCount > 0) {
    return {
      ok: false,
      detail: `${issueCount} required hosted SMS configuration ${
        issueCount === 1 ? "issue" : "issues"
      } detected`,
    };
  }

  const pilotPracticeId = sendingPracticeIds[0] ?? provisioningPracticeIds[0]!;
  const sendingLocationId = sendingLocationIds[0] ?? null;
  try {
    // Health has no tenant identity. Verify the explicitly configured rollout
    // scope in system context so hosted RLS does not hide a valid pilot clinic.
    const result = await withSystem(db, (tx) =>
      tx.execute(sql`
        select (
          exists (
            select 1
            from practices as practice
            where practice.id = ${pilotPracticeId}::uuid
              and practice.deleted_at is null
          )
          and ${
            sendingLocationId
              ? sql`exists (
                  select 1
                  from locations as location
                  join location_messaging as sender
                    on sender.practice_id = location.practice_id
                    and sender.location_id = location.id
                    and sender.deleted_at is null
                  join messaging_registrations as registration
                    on registration.practice_id = location.practice_id
                    and registration.deleted_at is null
                  where location.id = ${sendingLocationId}::uuid
                    and location.practice_id = ${pilotPracticeId}::uuid
                    and location.deleted_at is null
                    and sender.provider = 'telnyx'
                    and sender.registration_status = 'active'
                    and nullif(btrim(sender.sender_e164), '') is not null
                    and nullif(btrim(sender.messaging_profile_id), '') is not null
                    and sender.provider_profile_ready = true
                    and sender.provider_profile_synced_at is not null
                    and registration.provider = 'telnyx'
                    and registration.status = 'active'
                    and sender.a2p_brand_id = registration.provider_brand_id
                    and sender.a2p_campaign_id = registration.provider_campaign_id
                )`
              : sql`true`
          }
        ) as "scopeValid"
      `),
    );
    const scopeValid =
      rowsFromExecute<{ scopeValid: boolean }>(result)[0]?.scopeValid === true;
    if (!scopeValid) {
      return {
        ok: false,
        detail:
          "Hosted SMS pilot scope does not match an active, carrier-ready clinic location",
      };
    }
  } catch {
    return {
      ok: false,
      detail: "Hosted SMS pilot scope verification failed",
    };
  }

  return {
    ok: true,
    detail: sendingEnabled
      ? "Hosted SMS pilot configuration active"
      : "Hosted SMS pilot configuration prepared and sending gated off",
  };
}

export async function GET() {
  const startedAt = Date.now();
  const checks: Record<
    string,
    { ok: boolean; detail?: string; advisory?: boolean }
  > = {};

  let databaseReachable = false;
  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true };
    databaseReachable = true;
  } catch (err) {
    void err;
    checks.database = {
      ok: false,
      detail: "Database check failed",
    };
  }

  // A deploy whose migrations were never applied still boots, connects, and
  // serves most pages — it just 500s on whichever feature touches the missing
  // column. Surface that here so a drifted environment reports unhealthy
  // instead of waiting for a customer to notice.
  if (databaseReachable) {
    try {
      const drift = await findSchemaDrift(db);
      checks.schema = {
        ok: driftIsClean(drift),
        detail: describeDrift(drift),
      };
    } catch (err) {
      void err;
      checks.schema = { ok: false, detail: "Schema drift check failed" };
    }
  }

  if (billingEnforced()) {
    if (shouldAssertHostedRlsRole()) {
      try {
        const role = await inspectHostedRlsRole();
        const violations = hostedRlsRoleViolations(role);
        checks.hostedRlsRole = {
          ok: violations.length === 0,
          detail:
            violations.length > 0
              ? "Hosted database role is not RLS-safe"
              : "Hosted database role is RLS-safe",
        };
      } catch (err) {
        void err;
        checks.hostedRlsRole = {
          ok: false,
          detail: "RLS role check failed",
        };
      }
    } else {
      checks.hostedRlsRole = {
        ok: true,
        detail: "RLS role assertion skipped outside hosted production",
        advisory: true,
      };
    }

    checks.hostedCore = hostedEnvCheck(
      HOSTED_CORE_ENV_NAMES,
      "Hosted core envs present",
    );
    checks.hostedAppUrls = hostedAppUrlCheck();
    checks.hostedBilling = hostedEnvCheck(
      HOSTED_BILLING_ENV_NAMES,
      "Hosted billing envs present",
    );
    checks.hostedSubscriptionTax = hostedSubscriptionTaxCheck();
    const hostedStorageEnv = hostedEnvCheck(
      HOSTED_STORAGE_ENV_NAMES,
      "Hosted storage envs present",
    );
    checks.hostedStorage = hostedStorageEnv.ok
      ? await checkObjectStorageHealth()
      : hostedStorageEnv;
    const replicaReadiness = replicaStorageReadiness();
    const replicaRequired = replicaStorageRequired();
    const replicaEnabled = replicaStorageRolloutEnabled();
    let replicaCheck: { ok: boolean; detail: string };
    if (!replicaReadiness.ready) {
      replicaCheck = { ok: false, detail: replicaReadiness.detail };
    } else if (replicaRequired && !replicaEnabled) {
      replicaCheck = {
        ok: false,
        detail:
          "Independent file replica is required but execution is disabled",
      };
    } else {
      const storageCheck = await checkReplicaStorageHealth();
      if (!storageCheck.ok || !replicaEnabled) {
        replicaCheck = storageCheck;
      } else {
        try {
          const coverage = await getFileReplicaCoverage();
          const complete =
            coverage.backlog === 0 && coverage.coveragePct === 100;
          replicaCheck = {
            ok: replicaRequired ? complete : storageCheck.ok,
            detail: `${coverage.available}/${coverage.activeFiles} active files independently available (${coverage.coveragePct}%); backlog ${coverage.backlog}`,
          };
        } catch {
          replicaCheck = {
            ok: false,
            detail: "Independent file replica coverage check failed",
          };
        }
      }
    }
    checks.hostedFileReplica = {
      ...replicaCheck,
      // Any rollout signal makes invalid/incomplete replica configuration a
      // release gate. Only the intentionally absent, disabled default remains
      // advisory; otherwise a mistyped cohort or partial credentials could
      // hide behind FILE_REPLICA_REQUIRED=false and still return HTTP 200.
      advisory: !(replicaReadiness.intended || replicaRequired),
    };
    checks.hostedEmail = await hostedEmailCheck();
    checks.hostedAi = hostedAiCheck();
    checks.hostedOps = hostedOpsCheck();

    // SMS may remain safely deferred, but the first rollout signal makes its
    // configuration release-blocking. This prevents a production health 200
    // while provisioning or sending is nominally enabled without credentials,
    // webhook verification, encrypted registration storage, or exact pilot
    // scope. Missing/partial launch state still fails closed at every send.
    checks.hostedSms = hostedSmsRolloutIntended()
      ? await hostedSmsRolloutCheck()
      : {
          ...hostedTelnyxCredentialCheck(),
          advisory: true,
        };
    checks.hostedOpsAlerting = {
      ...hostedEnvCheck(
        HOSTED_OPS_ALERTING_ENV_NAMES,
        "Ops alerting configured",
      ),
    };
    checks.hostedCronHeartbeat = cronHeartbeatConfigured();
  } else {
    checks.hostedConfig = {
      ok: true,
      detail: "Hosted checks disabled; self-host mode",
    };
  }

  // Advisory checks are excluded from the readiness gate (status code) but are
  // still returned so operators can see what's intentionally deferred.
  const ok = Object.values(checks).every((check) => check.advisory || check.ok);
  return NextResponse.json(
    {
      ok,
      service: "openvpm-web",
      mode: billingEnforced() ? "hosted" : "self-host",
      checks,
      latencyMs: Date.now() - startedAt,
    },
    { status: ok ? 200 : 503 },
  );
}
