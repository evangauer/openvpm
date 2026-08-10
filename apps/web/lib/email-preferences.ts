import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appBaseUrl } from "@/lib/app-url";

export const CANONICAL_EMAIL_PREFERENCE_BASE_URL =
  "https://app.openvpm.com" as const;

export type EmailPreferenceTarget = { kind: "recipient"; id: string };

type EmailPreferencePayload = {
  v: 1;
  purpose: "unsubscribe_marketing";
  kid: string;
  identityKeyFingerprint: string;
  target: EmailPreferenceTarget;
  iat: number;
};

type IdentityOptions = {
  identitySecret?: string;
};

type SigningOptions = {
  signingSecret?: string;
  previousSigningSecrets?: string | string[];
};

type TokenOptions = SigningOptions &
  IdentityOptions & {
    now?: Date;
  };

type LinkOptions = TokenOptions & {
  baseUrl?: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;

export function isValidEmailPreferenceSecret(value: unknown): boolean {
  return (
    typeof value === "string" && Buffer.byteLength(value.trim(), "utf8") >= 32
  );
}

export function normalizeEmailPreferenceBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function validSecret(value: unknown): string | null {
  return isValidEmailPreferenceSecret(value) ? (value as string).trim() : null;
}

function identitySecret(explicit?: string): string | null {
  return validSecret(explicit ?? process.env.EMAIL_PREFERENCE_IDENTITY_SECRET);
}

function signingSecret(explicit?: string): string | null {
  return validSecret(explicit ?? process.env.EMAIL_PREFERENCE_SIGNING_SECRET);
}

function previousSigningSecretValues(
  explicit?: string | string[],
): string[] | null {
  const raw = explicit ?? process.env.EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS;
  if (raw === undefined || raw === "") return [];

  const values = (Array.isArray(raw) ? raw : raw.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => !isValidEmailPreferenceSecret(value))) {
    return null;
  }
  return [...new Set(values)];
}

export function isValidEmailPreferencePreviousSecrets(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" && !Array.isArray(value)) return false;
  if (Array.isArray(value) && value.some((item) => typeof item !== "string")) {
    return false;
  }
  return previousSigningSecretValues(value as string | string[]) !== null;
}

function signingKeyId(secret: string): string {
  return createHash("sha256")
    .update(`openvpm-email-preference-signing-key:${secret}`)
    .digest("hex")
    .slice(0, 16);
}

function verificationSecrets(options: SigningOptions): string[] | null {
  const current = signingSecret(options.signingSecret);
  const previous = previousSigningSecretValues(options.previousSigningSecrets);
  if (!current || !previous) return null;
  return [...new Set([current, ...previous])];
}

function validTarget(target: unknown): target is EmailPreferenceTarget {
  if (!target || typeof target !== "object") return false;
  const candidate = target as Partial<EmailPreferenceTarget>;
  return (
    candidate.kind === "recipient" &&
    typeof candidate.id === "string" &&
    SHA256_PATTERN.test(candidate.id)
  );
}

export function emailPreferenceRecipientHash(
  email: string,
  options: IdentityOptions = {},
): string | null {
  const secret = identitySecret(options.identitySecret);
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`openvpm-platform-email:${email.trim().toLowerCase()}`)
    .digest("hex");
}

export function emailPreferenceIdentityKeyFingerprint(
  options: IdentityOptions = {},
): string | null {
  const secret = identitySecret(options.identitySecret);
  if (!secret) return null;
  return createHash("sha256")
    .update(`openvpm-email-preference-identity-key:${secret}`)
    .digest("hex");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

export function createEmailPreferenceToken(
  target: EmailPreferenceTarget,
  options: TokenOptions = {},
): string | null {
  const secret = signingSecret(options.signingSecret);
  const verificationKeyRing = verificationSecrets(options);
  const identityKeyFingerprint = emailPreferenceIdentityKeyFingerprint({
    identitySecret: options.identitySecret,
  });
  if (
    !secret ||
    !verificationKeyRing ||
    !identityKeyFingerprint ||
    !validTarget(target)
  ) {
    return null;
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: EmailPreferencePayload = {
    v: 1,
    purpose: "unsubscribe_marketing",
    kid: signingKeyId(secret),
    identityKeyFingerprint,
    target,
    iat: nowSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyEmailPreferenceToken(
  token: string | null | undefined,
  options: TokenOptions = {},
): EmailPreferencePayload | null {
  const secrets = verificationSecrets(options);
  const identityKeyFingerprint = emailPreferenceIdentityKeyFingerprint({
    identitySecret: options.identitySecret,
  });
  if (!secrets || !identityKeyFingerprint || !token) return null;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;

  let payload: Partial<EmailPreferencePayload>;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<EmailPreferencePayload>;
  } catch {
    return null;
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    payload.v !== 1 ||
    payload.purpose !== "unsubscribe_marketing" ||
    typeof payload.kid !== "string" ||
    !KEY_ID_PATTERN.test(payload.kid) ||
    payload.identityKeyFingerprint !== identityKeyFingerprint ||
    !validTarget(payload.target) ||
    typeof payload.iat !== "number" ||
    payload.iat > nowSeconds + 300
  ) {
    return null;
  }

  const secret = secrets.find(
    (candidate) => signingKeyId(candidate) === payload.kid,
  );
  if (!secret) return null;

  const expected = sign(encoded, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  return payload as EmailPreferencePayload;
}

export function emailPreferenceBaseUrl(explicit?: string): string | null {
  let normalized: string | null;
  if (process.env.EMAIL_PREFERENCE_BASE_URL !== undefined) {
    normalized = normalizeEmailPreferenceBaseUrl(
      process.env.EMAIL_PREFERENCE_BASE_URL,
    );
  } else if (explicit !== undefined) {
    normalized = normalizeEmailPreferenceBaseUrl(explicit);
  } else {
    // Local/self-host development can follow the app URL. Hosted readiness
    // requires the explicit canonical HTTPS origin.
    normalized = appBaseUrl();
  }

  const hosted =
    process.env.VERCEL === "1" ||
    ["1", "true", "yes", "on"].includes(
      process.env.HOSTED_BILLING_ENABLED?.trim().toLowerCase() ?? "",
    );
  if (hosted && normalized !== CANONICAL_EMAIL_PREFERENCE_BASE_URL) {
    return null;
  }
  return normalized;
}

export function createEmailPreferenceLinks(
  target: EmailPreferenceTarget,
  options: LinkOptions = {},
): { preferencesUrl: string; oneClickUrl: string } | null {
  const token = createEmailPreferenceToken(target, options);
  const base = emailPreferenceBaseUrl(options.baseUrl);
  if (!token || !base) return null;

  const preferencesUrl = new URL("/email-preferences", base);
  preferencesUrl.searchParams.set("token", token);
  const oneClickUrl = new URL("/api/email-preferences/unsubscribe", base);
  oneClickUrl.searchParams.set("token", token);
  return {
    preferencesUrl: preferencesUrl.toString(),
    oneClickUrl: oneClickUrl.toString(),
  };
}
