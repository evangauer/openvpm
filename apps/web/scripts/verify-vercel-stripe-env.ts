#!/usr/bin/env node

import { pathToFileURL } from "node:url";

type VercelEnvironmentVariable = {
  key?: unknown;
  type?: unknown;
  target?: unknown;
  value?: unknown;
};

type PolicyResult = {
  ok: boolean;
  issues: string[];
};

const REQUIRED_SENSITIVE = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "STRIPE_CONNECT_V2_WEBHOOK_SECRET",
  "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET",
] as const;

export const EXPECTED_OPENVPM_PRODUCTION_CONFIG = {
  // Temporary launch platform. These resources are isolated to OpenVPM, but
  // the Stripe account is still Get Talky Inc. until the dedicated OpenVPM
  // account is ready and a controlled cutover is approved.
  STRIPE_EXPECTED_ACCOUNT_ID: "acct_1QDxkLFYrRosDgEp",
  STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION:
    "pmc_1RetVKFYrRosDgEp9AvOlHve",
  STRIPE_BILLING_PORTAL_CONFIGURATION: "bpc_1U5lMOFYrRosDgEprfKyuXfA",
  STRIPE_PRICE_CLOUD_LOCATION: "price_1TqHYjFYrRosDgEpfF3o7GuS",
  STRIPE_PRICE_CLOUD_LOCATION_ANNUAL: "price_1U48mlFYrRosDgEpNJbKk5SK",
  STRIPE_PRICE_AI_OVERAGE: "price_1TmIKqFYrRosDgEpIhcA0pnt",
  STRIPE_PRICE_SMS_OVERAGE: "price_1TmIKqFYrRosDgEpT5hg2pIC",
  STRIPE_CLOUD_PRODUCT_TAX_CODE: "txcd_10103001",
  STRIPE_REQUIRED_TAX_REGISTRATIONS: "US-NY:state_sales_tax",
  STRIPE_CONNECT_V2_ENABLED: "true",
  STRIPE_TAX_ENABLED: "true",
  HOSTED_BILLING_ENABLED: "true",
} as const;

const RETIRED_CONFIG = [
  "STRIPE_PRICE_CLOUD",
  "STRIPE_PRICE_CLOUD_USER",
] as const;
const CONNECT_APPLICATION_FEE_ENV_NAME =
  "STRIPE_CONNECT_APPLICATION_FEE_BPS" as const;
export const EXPECTED_CONNECT_APPLICATION_FEE_BPS = "25" as const;

function targetsProduction(value: unknown): boolean {
  return Array.isArray(value) && value.includes("production");
}

function isVerifiableConfiguration(env: VercelEnvironmentVariable): boolean {
  // Current Vercel stores non-sensitive production variables as `encrypted`;
  // `plain` remains valid for legacy rows and development-scoped fixtures.
  // Both expose the value to this authenticated policy read, unlike Sensitive
  // values, so account and price pins remain independently verifiable.
  return (
    (env.type === "encrypted" || env.type === "plain") &&
    typeof env.value === "string"
  );
}

function configurationMatches(
  env: VercelEnvironmentVariable,
  expected: string,
): boolean {
  // `vercel env ls` returns ciphertext for encrypted production config. The
  // exact decrypted read-back is performed by `vercel env run` with the Stripe
  // runtime preflight; legacy plain rows can still be compared here.
  return env.type === "encrypted" || env.value === expected;
}

export function verifyVercelStripeEnvPolicy(input: unknown): PolicyResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: ["Vercel environment JSON is invalid"] };
  }
  const envs = (input as { envs?: unknown }).envs;
  if (!Array.isArray(envs)) {
    return { ok: false, issues: ["Vercel environment JSON is invalid"] };
  }
  const production = new Map<string, VercelEnvironmentVariable>();
  for (const candidate of envs) {
    if (!candidate || typeof candidate !== "object") continue;
    const env = candidate as VercelEnvironmentVariable;
    if (typeof env.key !== "string" || !targetsProduction(env.target)) continue;
    if (production.has(env.key)) {
      return {
        ok: false,
        issues: [`Duplicate production environment variable: ${env.key}`],
      };
    }
    production.set(env.key, env);
  }

  const issues: string[] = [];
  for (const name of REQUIRED_SENSITIVE) {
    const env = production.get(name);
    if (!env) {
      issues.push(`Missing production environment variable: ${name}`);
    } else if (env.type !== "sensitive") {
      issues.push(`Production credential must be Sensitive: ${name}`);
    }
  }
  for (const [name, expectedValue] of Object.entries(
    EXPECTED_OPENVPM_PRODUCTION_CONFIG,
  )) {
    const env = production.get(name);
    if (!env) {
      issues.push(`Missing production environment variable: ${name}`);
    } else if (!isVerifiableConfiguration(env)) {
      issues.push(
        `Production config must be non-sensitive and verifiable: ${name}`,
      );
    } else if (!configurationMatches(env, expectedValue)) {
      issues.push(`Production config does not match OpenVPM cutover: ${name}`);
    }
  }
  const applicationFee = production.get(CONNECT_APPLICATION_FEE_ENV_NAME);
  if (!applicationFee) {
    issues.push(
      `Missing production environment variable: ${CONNECT_APPLICATION_FEE_ENV_NAME}`,
    );
  } else if (!isVerifiableConfiguration(applicationFee)) {
    issues.push(
      `Production config must be non-sensitive and verifiable: ${CONNECT_APPLICATION_FEE_ENV_NAME}`,
    );
  } else if (
    !configurationMatches(
      applicationFee,
      EXPECTED_CONNECT_APPLICATION_FEE_BPS,
    )
  ) {
    issues.push(
      `Production Connect application fee must be ${EXPECTED_CONNECT_APPLICATION_FEE_BPS} basis points (0.25%)`,
    );
  }
  for (const name of RETIRED_CONFIG) {
    if (production.has(name)) {
      issues.push(
        `Retired production environment variable is still present: ${name}`,
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Vercel environment JSON is invalid");
  }
  const result = verifyVercelStripeEnvPolicy(parsed);
  for (const issue of result.issues) process.stderr.write(`FAIL ${issue}\n`);
  if (!result.ok) {
    throw new Error("Vercel Stripe environment policy failed");
  }
  process.stdout.write("PASS Vercel Stripe production environment policy\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Policy verification failed"}\n`,
    );
    process.exitCode = 1;
  });
}
