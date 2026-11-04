// NEXTAUTH_SECRET signs and encrypts staff session cookies and is the fallback
// key for invoice payment links, demo access links, and portal metadata. A
// value anyone can read from this public repository (or one short enough to
// brute-force) lets an attacker mint a staff session for any clinic using it,
// so production refuses to authenticate with such a secret instead of
// silently accepting it.

export const MIN_AUTH_SECRET_LENGTH = 32;

export const AUTH_SECRET_SETUP_COMMAND = "openssl rand -base64 32";

// Placeholder or fixture values published in this repository's compose file,
// env examples, docs, and tests that are long enough to pass the length rule.
// Any deployment that copied one of these is using a key the whole internet
// knows. Compared case-insensitively.
const KNOWN_PUBLIC_AUTH_SECRETS = new Set(
  [
    "docker-dev-secret-change-in-production",
    "generate-a-secret-with-openssl-rand-base64-32",
    "test-secret-at-least-32-characters-long",
    "openvpm-local-portal-metadata-secret",
    "ci-only-synthetic-nextauth-secret-not-for-deployment",
  ].map((value) => value.toLowerCase()),
);

export type AuthSecretProblem = "missing" | "known_public" | "too_short";

export function authSecretProblem(
  value: string | undefined,
): AuthSecretProblem | null {
  const trimmed = value?.trim();
  if (!trimmed) return "missing";
  if (KNOWN_PUBLIC_AUTH_SECRETS.has(trimmed.toLowerCase())) {
    return "known_public";
  }
  if (trimmed.length < MIN_AUTH_SECRET_LENGTH) return "too_short";
  return null;
}

/** Weak secrets are tolerated in `next dev` and tests, never in production. */
export function authSecretStrengthEnforced(): boolean {
  return process.env.NODE_ENV === "production";
}

export function nextAuthSecretProblem(): AuthSecretProblem | null {
  return authSecretProblem(process.env.NEXTAUTH_SECRET);
}

/**
 * Temporary escape hatch for a deployment that already runs on a secret that
 * is merely short (not missing, not published): rotating it signs everyone
 * out, so an operator can keep serving while they schedule the rotation. It
 * never excuses a missing or published secret.
 */
export const SHORT_AUTH_SECRET_OVERRIDE_ENV = "OPENVPM_ALLOW_SHORT_AUTH_SECRET";

function shortAuthSecretOverrideEnabled(): boolean {
  const value = process.env[SHORT_AUTH_SECRET_OVERRIDE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** True when production is serving on a short secret only because of the override. */
export function nextAuthSecretShortOverrideActive(): boolean {
  return (
    authSecretStrengthEnforced() &&
    !hasBlankConfiguredNextAuthSecret() &&
    nextAuthSecretProblem() === "too_short" &&
    shortAuthSecretOverrideEnabled()
  );
}

export function shortAuthSecretOverrideMessage(): string {
  return `NEXTAUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters and is allowed only because ${SHORT_AUTH_SECRET_OVERRIDE_ENV} is set. Rotate it to a ${MIN_AUTH_SECRET_LENGTH}+ character secret (${AUTH_SECRET_SETUP_COMMAND}) and remove ${SHORT_AUTH_SECRET_OVERRIDE_ENV}.`;
}

/**
 * True when the app must not accept or issue staff sessions: the secret is
 * explicitly blank, or production is running with a missing, published, or
 * short secret.
 */
export function nextAuthSecretRejected(): boolean {
  if (hasBlankConfiguredNextAuthSecret()) return true;
  if (nextAuthSecretShortOverrideActive()) return false;
  return authSecretStrengthEnforced() && nextAuthSecretProblem() !== null;
}

/**
 * The configured NextAuth secret, or undefined when it is unset or rejected.
 * Callers that derive their own signing keys from it therefore fail closed in
 * production instead of signing with a publicly known key.
 */
export function nextAuthSecret(): string | undefined {
  const trimmed = process.env.NEXTAUTH_SECRET?.trim();
  if (!trimmed || nextAuthSecretRejected()) return undefined;
  return trimmed;
}

export function hasBlankConfiguredNextAuthSecret(): boolean {
  const value = process.env.NEXTAUTH_SECRET;
  return value !== undefined && value.trim().length === 0;
}

export function authSecretProblemMessage(problem: AuthSecretProblem): string {
  switch (problem) {
    case "missing":
      return `NEXTAUTH_SECRET is not set.`;
    case "known_public":
      return `NEXTAUTH_SECRET is a published placeholder value from the OpenVPM repository, so anyone could forge sign-ins.`;
    case "too_short":
      return `NEXTAUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters.`;
  }
}

/**
 * Startup log so operators see the problem in container logs: an error in
 * production (where sign-in is refused), a warning in development.
 */
export function logNextAuthSecretProblemAtStartup(): void {
  if (process.env.NODE_ENV === "test") return;
  const problem = nextAuthSecretProblem();
  if (!problem) return;
  if (nextAuthSecretShortOverrideActive()) {
    console.warn(`[openvpm] ${shortAuthSecretOverrideMessage()}`);
    return;
  }
  const message = `[openvpm] ${authSecretProblemMessage(problem)} Generate one with: ${AUTH_SECRET_SETUP_COMMAND}.`;
  if (authSecretStrengthEnforced()) {
    console.error(
      `${message} Sign-in is disabled until NEXTAUTH_SECRET is replaced.`,
    );
  } else if (problem !== "missing") {
    console.warn(
      `${message} Allowed in development only; production refuses to sign anyone in with this secret.`,
    );
  }
}
