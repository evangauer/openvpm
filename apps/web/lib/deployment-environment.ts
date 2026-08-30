import { nonproductionEmailPolicyIssues } from "@/lib/email-env";

export const OPENVPM_ENVIRONMENTS = [
  "development",
  "staging",
  "demo",
  "production",
] as const;

export type OpenVpmEnvironment = (typeof OPENVPM_ENVIRONMENTS)[number];

export type DeploymentEnvironmentCheck = {
  ok: boolean;
  environment: OpenVpmEnvironment | "local/self-hosted" | "invalid";
  businessTier: "cloud" | "self-hosted";
  issues: string[];
};

export type DeploymentEnvironmentVariables = Readonly<
  Record<string, string | undefined>
>;

const NONPRODUCTION_DISABLED_FLAGS = [
  "FILE_REPLICA_ALL_PRACTICES",
  "FILE_REPLICA_ENABLED",
  "FILE_REPLICA_REQUIRED",
  "FIRST_CLINIC_WIN_ENABLED",
  "MESSAGING_INBOUND_ENABLED",
  "MESSAGING_PROVISIONING_ENABLED",
  "MESSAGING_SENDING_ENABLED",
  "STRIPE_TAX_ENABLED",
] as const;

const NONPRODUCTION_EMPTY_SCOPES = [
  "FILE_REPLICA_PRACTICE_IDS",
  "MESSAGING_PROVISIONING_PRACTICE_IDS",
  "MESSAGING_SENDING_LOCATION_IDS",
  "MESSAGING_SENDING_PRACTICE_IDS",
] as const;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function flagEnabled(
  env: DeploymentEnvironmentVariables,
  name: string,
): boolean {
  return env[name]?.trim() === "true";
}

function providerFeatureEnabled(
  env: DeploymentEnvironmentVariables,
  name: string,
): boolean {
  // Replica flags accept these common truthy spellings. Treat the entire
  // provider/fee safety boundary consistently so a spelling difference cannot
  // bypass the build guard.
  return /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? "");
}

function isManagedRuntime(env: DeploymentEnvironmentVariables): boolean {
  return (
    env.VERCEL?.trim() === "1" ||
    ["production", "preview"].includes(env.VERCEL_ENV?.trim() ?? "")
  );
}

function parseEnvironment(
  env: DeploymentEnvironmentVariables,
): OpenVpmEnvironment | undefined {
  const value = nonBlank(env.OPENVPM_ENVIRONMENT);
  return OPENVPM_ENVIRONMENTS.includes(value as OpenVpmEnvironment)
    ? (value as OpenVpmEnvironment)
    : undefined;
}

function usesTestStripeCredential(
  env: DeploymentEnvironmentVariables,
): boolean {
  const key = nonBlank(env.STRIPE_SECRET_KEY);
  return !key || key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/**
 * Validate the deployment identity and its business/provider safety contract.
 * The check returns only configuration names and never returns their values.
 *
 * An omitted environment remains compatible with local and self-hosted OSS
 * installs. Vercel and hosted-billing runtimes must declare their environment
 * explicitly so a missing branch mapping cannot silently inherit Production
 * behavior.
 */
export function inspectDeploymentEnvironment(
  env: DeploymentEnvironmentVariables = process.env,
): DeploymentEnvironmentCheck {
  const configuredEnvironment = nonBlank(env.OPENVPM_ENVIRONMENT);
  const environment = parseEnvironment(env);
  const hostedBilling = flagEnabled(env, "HOSTED_BILLING_ENABLED");
  const issues: string[] = [];

  if (!configuredEnvironment) {
    if (isManagedRuntime(env) || hostedBilling) {
      issues.push(
        "OPENVPM_ENVIRONMENT is required for managed or hosted-billing runtimes",
      );
    }
    return {
      ok: issues.length === 0,
      environment: "local/self-hosted",
      businessTier: hostedBilling ? "cloud" : "self-hosted",
      issues,
    };
  }

  if (!environment) {
    return {
      ok: false,
      environment: "invalid",
      businessTier: hostedBilling ? "cloud" : "self-hosted",
      issues: ["OPENVPM_ENVIRONMENT is invalid"],
    };
  }

  const demoMode = flagEnabled(env, "NEXT_PUBLIC_DEMO_MODE");
  if (environment === "production") {
    if (!hostedBilling) {
      issues.push("Production requires the cloud business tier");
    }
    if (demoMode) issues.push("Production cannot enable demo mode");
    if (flagEnabled(env, "OPENVPM_EXPOSE_AUTH_LINKS")) {
      issues.push("Production cannot expose authentication links");
    }
  } else if (environment === "demo") {
    if (hostedBilling) issues.push("Demo cannot enable hosted billing");
    if (!demoMode) issues.push("Demo requires demo mode");
  } else {
    if (!hostedBilling) {
      issues.push(`${environment} requires the cloud business tier`);
    }
    if (demoMode) issues.push(`${environment} cannot enable demo mode`);
  }

  if (environment !== "production") {
    for (const name of NONPRODUCTION_DISABLED_FLAGS) {
      if (providerFeatureEnabled(env, name)) {
        issues.push(`${name} must remain disabled outside Production`);
      }
    }
    for (const name of NONPRODUCTION_EMPTY_SCOPES) {
      if (nonBlank(env[name])) {
        issues.push(`${name} must remain empty outside Production`);
      }
    }

    const applicationFee = nonBlank(env.STRIPE_CONNECT_APPLICATION_FEE_BPS);
    if (applicationFee && Number(applicationFee) !== 0) {
      issues.push(
        "STRIPE_CONNECT_APPLICATION_FEE_BPS must be zero outside Production",
      );
    }
    if (!usesTestStripeCredential(env)) {
      issues.push("Nonproduction Stripe credentials must use test mode");
    }
    issues.push(...nonproductionEmailPolicyIssues(env));
  }

  return {
    ok: issues.length === 0,
    environment,
    businessTier: hostedBilling ? "cloud" : "self-hosted",
    issues,
  };
}

export function assertDeploymentEnvironment(
  env: DeploymentEnvironmentVariables = process.env,
): DeploymentEnvironmentCheck {
  const check = inspectDeploymentEnvironment(env);
  if (!check.ok) {
    throw new Error(check.issues.join("; "));
  }
  return check;
}
