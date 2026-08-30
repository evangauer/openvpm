import {
  assertDatabaseTarget,
  databaseTargetFingerprint,
  supabaseProjectRef,
} from "./deployment-target";

export type ResetEnvironment = Readonly<Record<string, string | undefined>>;

export type StagingResetEvidence = {
  projectRefFingerprint: string;
};

const STAGING_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const PROTECTED_DATA_BEARING_FINGERPRINTS = new Set([
  "475ea002bcfafd75c0becd388af7b396fe918bd3e57d960458b4c912d006212d",
  "6580350addb8614fe9179d5539b91c298b28e4ebcb613020ac2abff7dbe43289",
]);

function required(env: ResetEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function postgresUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error(`${label} must use PostgreSQL.`);
  }
  if (!parsed.username || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error(`${label} is missing its database identity.`);
  }
  return parsed;
}

/**
 * The developer reset command is deliberately local-only. A checked-in helper
 * must never turn an accidentally inherited hosted DATABASE_URL into a remote
 * destructive operation.
 */
export function assertLocalResetPolicy(env: ResetEnvironment): void {
  if (required(env, "RESET_DATABASE_CONFIRMATION") !== "RESET_LOCAL_OPENVPM") {
    throw new Error(
      "RESET_DATABASE_CONFIRMATION must equal RESET_LOCAL_OPENVPM.",
    );
  }
  if (env.VERCEL?.trim() || env.CI?.trim() === "true") {
    throw new Error("The local reset command cannot run in CI or Vercel.");
  }
  const declared = env.OPENVPM_ENVIRONMENT?.trim();
  if (declared && declared !== "development") {
    throw new Error("The local reset command only permits development.");
  }
  const url = postgresUrl(required(env, "DATABASE_URL"), "DATABASE_URL");
  const hostname = url.hostname.toLowerCase();
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(hostname)) {
    throw new Error("The local reset command refuses non-loopback databases.");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^openpims(?:_[a-z0-9_]+)?$/.test(databaseName)) {
    throw new Error(
      "The local reset command requires an openpims development database name.",
    );
  }
}

/**
 * Staging resets are a separate, environment-protected operation. Identity is
 * checked three ways: the URL's Supabase ref, its expected fingerprint, and a
 * mandatory forbidden-target set. No secret or raw project ref is returned.
 */
export function assertStagingResetPolicy(
  env: ResetEnvironment,
): StagingResetEvidence {
  if (required(env, "OPENVPM_ENVIRONMENT") !== "staging") {
    throw new Error("OPENVPM_ENVIRONMENT must equal staging.");
  }
  if (required(env, "STAGING_RESET_CONFIRMATION") !== "RESET_STAGING_DATA") {
    throw new Error(
      "STAGING_RESET_CONFIRMATION must equal RESET_STAGING_DATA.",
    );
  }
  const databaseUrl = required(env, "DATABASE_URL");
  const stagingDatabaseUrl = required(env, "STAGING_DATABASE_URL");
  if (databaseUrl !== stagingDatabaseUrl) {
    throw new Error(
      "DATABASE_URL must be the environment-scoped STAGING_DATABASE_URL.",
    );
  }
  postgresUrl(databaseUrl, "STAGING_DATABASE_URL");
  const projectRef = supabaseProjectRef(databaseUrl);
  const expectedProjectRef = required(env, "STAGING_PROJECT_REF").toLowerCase();
  if (
    !STAGING_PROJECT_REF_PATTERN.test(expectedProjectRef) ||
    !projectRef ||
    projectRef !== expectedProjectRef
  ) {
    throw new Error(
      "STAGING_DATABASE_URL does not identify STAGING_PROJECT_REF.",
    );
  }
  assertDatabaseTarget({
    databaseUrl,
    expectedFingerprint: env.DATABASE_TARGET_FINGERPRINT,
    forbiddenFingerprints: env.FORBIDDEN_DATABASE_TARGET_FINGERPRINTS,
  });
  const projectRefFingerprint = databaseTargetFingerprint(projectRef);
  if (PROTECTED_DATA_BEARING_FINGERPRINTS.has(projectRefFingerprint)) {
    throw new Error(
      "The configured database is a protected data-bearing target, not disposable staging.",
    );
  }
  return { projectRefFingerprint };
}
