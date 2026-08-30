import { platformAdminEmails } from "@/lib/platform-admin";

export const AUTH_RECOVERY_POLICY_VERSION = "dual-control-v1";
export const AUTH_RECOVERY_DRILL_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AuthRecoveryReadinessCheck = {
  ok: boolean;
  detail: string;
};

export type AuthRecoveryReadinessInput = {
  authorityEmails: string[];
  drillCompletedAt?: string;
  drillEvidenceSha256?: string;
  platformOperatorEmails: string[];
  policySha256?: string;
  policyVersion?: string;
};

function normalizedEmails(values: string[]): string[] {
  return values.map((value) => value.trim().toLowerCase());
}

/**
 * Account recovery is deliberately not inferred from a working password-reset
 * path. A hosted clinic release needs an approved, content-addressed policy,
 * at least two distinct operator authorities, and recent drill evidence.
 * Details are safe for the public health response and never reveal identities.
 */
export function evaluateAuthRecoveryReadiness(
  input: AuthRecoveryReadinessInput,
  nowMs = Date.now(),
): AuthRecoveryReadinessCheck {
  if (
    input.policyVersion !== AUTH_RECOVERY_POLICY_VERSION ||
    !input.policySha256 ||
    !SHA256_PATTERN.test(input.policySha256)
  ) {
    return {
      ok: false,
      detail: "Hosted account recovery policy is not approved and pinned",
    };
  }

  const authorities = normalizedEmails(input.authorityEmails);
  const distinctAuthorities = new Set(authorities);
  if (
    authorities.length < 2 ||
    authorities.length > 5 ||
    distinctAuthorities.size !== authorities.length
  ) {
    return {
      ok: false,
      detail:
        "Hosted account recovery requires two distinct configured authorities",
    };
  }

  const operators = new Set(normalizedEmails(input.platformOperatorEmails));
  if (
    authorities.some(
      (authority) =>
        !EMAIL_PATTERN.test(authority) || !operators.has(authority),
    )
  ) {
    return {
      ok: false,
      detail:
        "Hosted account recovery authorities are invalid or not platform operators",
    };
  }

  if (
    !input.drillEvidenceSha256 ||
    !SHA256_PATTERN.test(input.drillEvidenceSha256) ||
    !input.drillCompletedAt
  ) {
    return {
      ok: false,
      detail: "Hosted account recovery drill evidence is missing or invalid",
    };
  }
  const drillMs = Date.parse(input.drillCompletedAt);
  if (
    !Number.isFinite(drillMs) ||
    new Date(drillMs).toISOString() !== input.drillCompletedAt ||
    drillMs > nowMs + 60_000
  ) {
    return {
      ok: false,
      detail: "Hosted account recovery drill evidence is missing or invalid",
    };
  }
  if (nowMs - drillMs > AUTH_RECOVERY_DRILL_MAX_AGE_MS) {
    return {
      ok: false,
      detail: "Hosted account recovery drill evidence is stale",
    };
  }

  return {
    ok: true,
    detail:
      "Hosted account recovery policy, dual control, and drill evidence are current",
  };
}

export function checkHostedAuthRecoveryReadiness(
  nowMs = Date.now(),
): AuthRecoveryReadinessCheck {
  return evaluateAuthRecoveryReadiness(
    {
      authorityEmails: (process.env.AUTH_RECOVERY_AUTHORITY_EMAILS ?? "").split(
        ",",
      ),
      drillCompletedAt: process.env.AUTH_RECOVERY_DRILL_COMPLETED_AT?.trim(),
      drillEvidenceSha256:
        process.env.AUTH_RECOVERY_DRILL_EVIDENCE_SHA256?.trim(),
      platformOperatorEmails: platformAdminEmails(),
      policySha256: process.env.AUTH_RECOVERY_POLICY_SHA256?.trim(),
      policyVersion: process.env.AUTH_RECOVERY_POLICY_VERSION?.trim(),
    },
    nowMs,
  );
}
