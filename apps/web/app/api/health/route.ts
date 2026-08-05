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
import { requiredMessagingEnvNames } from "@/lib/messaging";
import {
  hostedRlsRoleViolations,
  inspectHostedRlsRole,
  shouldAssertHostedRlsRole,
} from "@/lib/rls-assertion";
import { cronHeartbeatConfigured } from "@/lib/cron-heartbeat";
import { envFlagEnabled } from "@/lib/env-bool";
import { checkObjectStorageHealth } from "@/lib/s3";
import { normalizeAppBaseUrl } from "@/lib/app-url";
import { platformAdminEmails } from "@/lib/platform-admin";

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
  "EMAIL_SUPPORT_ADDRESS",
  "EMAIL_COMPANY_ADDRESS",
];
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
    "Hosted AI envs present"
  );
}

// Required ops config: cron auth + at least one platform-admin operator.
const HOSTED_OPS_ENV_NAMES = ["CRON_SECRET"];

const HOSTED_OPS_ALERTING_ENV_NAMES = ["OPS_ALERT_WEBHOOK_URL"];

function hostedEnvCheck(
  names: string[],
  presentDetail: string
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
      "Hosted core envs present"
    );
    checks.hostedAppUrls = hostedAppUrlCheck();
    checks.hostedBilling = hostedEnvCheck(
      HOSTED_BILLING_ENV_NAMES,
      "Hosted billing envs present"
    );
    checks.hostedSubscriptionTax = hostedSubscriptionTaxCheck();
    const hostedStorageEnv = hostedEnvCheck(
      HOSTED_STORAGE_ENV_NAMES,
      "Hosted storage envs present"
    );
    checks.hostedStorage = hostedStorageEnv.ok
      ? await checkObjectStorageHealth()
      : hostedStorageEnv;
    checks.hostedEmail = hostedEnvCheck(
      HOSTED_EMAIL_ENV_NAMES,
      "Hosted email envs present"
    );
    checks.hostedAi = hostedAiCheck();
    checks.hostedOps = hostedOpsCheck();

    // SMS is deferred until the active provider is provisioned; everything else
    // in hosted ops must be wired before the deployment reports ready.
    checks.hostedSms = {
      ...hostedEnvCheck(requiredMessagingEnvNames(), "Hosted SMS envs present"),
      advisory: true,
    };
    checks.hostedOpsAlerting = {
      ...hostedEnvCheck(
        HOSTED_OPS_ALERTING_ENV_NAMES,
        "Ops alerting configured"
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
    { status: ok ? 200 : 503 }
  );
}
