import { createHash } from "node:crypto";

const DEFAULT_EMAIL_FROM = "OpenVPM <noreply@mail.openvpm.com>";
const NONPRODUCTION_EMAIL_ENVIRONMENTS = new Set(["development", "staging"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_NONPRODUCTION_EMAIL_RECIPIENTS = 20;

export function nonBlankEmailValue(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function emailEnv(name: string): string | undefined {
  return nonBlankEmailValue(process.env[name]);
}

export function defaultEmailFrom(override?: string | null): string {
  return (
    nonBlankEmailValue(override) ?? emailEnv("EMAIL_FROM") ?? DEFAULT_EMAIL_FROM
  );
}

export function emailDemoMode(): boolean {
  return emailEnv("NEXT_PUBLIC_DEMO_MODE") === "true";
}

function configuredRecipientHashes(
  env: Readonly<Record<string, string | undefined>>,
): string[] | null {
  const raw = nonBlankEmailValue(env.NONPRODUCTION_EMAIL_RECIPIENT_HASHES);
  if (!raw) return null;
  const hashes = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    hashes.length === 0 ||
    hashes.length > MAX_NONPRODUCTION_EMAIL_RECIPIENTS ||
    hashes.some((hash) => !SHA256_PATTERN.test(hash)) ||
    new Set(hashes).size !== hashes.length
  ) {
    return null;
  }
  return hashes;
}

export function nonproductionEmailPolicyIssues(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const environment = nonBlankEmailValue(env.OPENVPM_ENVIRONMENT);
  if (
    !NONPRODUCTION_EMAIL_ENVIRONMENTS.has(environment ?? "") ||
    !nonBlankEmailValue(env.RESEND_API_KEY)
  ) {
    return [];
  }
  if (!nonBlankEmailValue(env.NONPRODUCTION_EMAIL_RECIPIENT_HASHES)) {
    return [
      "Nonproduction Resend requires NONPRODUCTION_EMAIL_RECIPIENT_HASHES",
    ];
  }
  if (!configuredRecipientHashes(env)) {
    return [
      "NONPRODUCTION_EMAIL_RECIPIENT_HASHES must contain 1-20 unique SHA-256 values",
    ];
  }
  return [];
}

/**
 * Fail closed before crossing the provider boundary. The configured hashes are
 * exact, normalized recipient identities so staging cannot broaden delivery to
 * a domain or disclose sandbox addresses through ordinary environment output.
 */
export function nonproductionEmailRecipientAllowed(
  recipient: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const environment = nonBlankEmailValue(env.OPENVPM_ENVIRONMENT);
  if (!NONPRODUCTION_EMAIL_ENVIRONMENTS.has(environment ?? "")) return true;
  if (!nonBlankEmailValue(env.RESEND_API_KEY)) return true;
  const hashes = configuredRecipientHashes(env);
  if (!hashes) return false;
  const normalizedRecipient = recipient.trim().toLowerCase();
  const recipientHash = createHash("sha256")
    .update(normalizedRecipient)
    .digest("hex");
  return hashes.includes(recipientHash);
}
