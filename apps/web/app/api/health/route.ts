import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
  STRIPE_PRICE_CLOUD_USER_ENV,
  billingEnforced,
} from "@/lib/billing/plans";

export const dynamic = "force-dynamic";

function configured(name: string): boolean {
  return Boolean(process.env[name]);
}

// Overage price envs (STRIPE_PRICE_SMS_OVERAGE / STRIPE_PRICE_AI_OVERAGE) drive
// metered overage via Stripe Billing Meters. They are NOT required here so the
// app still boots before the meters are configured (and so usage is recorded
// even when overage billing is intentionally off). See lib/billing/usage.ts.
const HOSTED_BILLING_ENV_NAMES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET",
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
  STRIPE_PRICE_CLOUD_USER_ENV,
];

const HOSTED_CORE_ENV_NAMES = [
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXTAUTH_SECRET",
  "DATABASE_URL",
];

const HOSTED_STORAGE_ENV_NAMES = [
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_BUCKET",
  "S3_REGION",
];

const HOSTED_EMAIL_ENV_NAMES = ["RESEND_API_KEY"];

const HOSTED_SMS_ENV_NAMES = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
];

// AI is provider-agnostic: the model is chosen by AI_MODEL and the provider is
// inferred from the id, so require the matching API key (Gemini vs Claude).
function requiredAiEnvNames(): string[] {
  const model = process.env.AI_MODEL || process.env.AGENT_MODEL || "claude-sonnet-4-6";
  const isGemini = /^(google\/|models\/)?gemini/i.test(model);
  return [isGemini ? "GOOGLE_API_KEY" : "ANTHROPIC_API_KEY"];
}

const HOSTED_OPS_ENV_NAMES = [
  "OPS_ALERT_WEBHOOK_URL",
  "CRON_SECRET",
  "PLATFORM_ADMIN_EMAILS",
];

function hostedEnvCheck(
  names: string[],
  presentDetail: string
): { ok: boolean; detail: string } {
  const missing = names.filter((name) => !configured(name));
  return {
    ok: missing.length === 0,
    detail:
      missing.length > 0
        ? `Missing hosted envs: ${missing.join(", ")}`
        : presentDetail,
  };
}

export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true };
  } catch (err) {
    checks.database = {
      ok: false,
      detail: err instanceof Error ? err.message : "Database check failed",
    };
  }

  if (billingEnforced()) {
    checks.hostedCore = hostedEnvCheck(
      HOSTED_CORE_ENV_NAMES,
      "Hosted core envs present"
    );
    checks.hostedBilling = hostedEnvCheck(
      HOSTED_BILLING_ENV_NAMES,
      "Hosted billing envs present"
    );
    checks.hostedStorage = hostedEnvCheck(
      HOSTED_STORAGE_ENV_NAMES,
      "Hosted storage envs present"
    );
    checks.hostedEmail = hostedEnvCheck(
      HOSTED_EMAIL_ENV_NAMES,
      "Hosted email envs present"
    );
    checks.hostedSms = hostedEnvCheck(
      HOSTED_SMS_ENV_NAMES,
      "Hosted SMS envs present"
    );
    checks.hostedAi = hostedEnvCheck(
      requiredAiEnvNames(),
      "Hosted AI envs present"
    );
    checks.hostedOps = hostedEnvCheck(
      HOSTED_OPS_ENV_NAMES,
      "Hosted ops envs present"
    );
  } else {
    checks.hostedConfig = {
      ok: true,
      detail: "Hosted checks disabled; self-host mode",
    };
  }

  const ok = Object.values(checks).every((check) => check.ok);
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
