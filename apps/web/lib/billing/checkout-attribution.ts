import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isValidEmailPreferenceSecret } from "@/lib/email-preferences";

export const SUBSCRIPTION_CHECKOUT_SOURCES = [
  "registration",
  "in_app_pre_first_visit",
  "in_app_post_first_visit",
  "first_visit_email",
  "trial_ending_email",
] as const;

export type SubscriptionCheckoutSource =
  (typeof SUBSCRIPTION_CHECKOUT_SOURCES)[number];

export const SUBSCRIPTION_CHECKOUT_ATTRIBUTION_SOURCES = [
  "first_visit_email",
  "trial_ending_email",
] as const satisfies readonly SubscriptionCheckoutSource[];

export type SubscriptionCheckoutAttributionSource =
  (typeof SUBSCRIPTION_CHECKOUT_ATTRIBUTION_SOURCES)[number];

export type SubscriptionCheckoutAttribution = {
  practiceId: string;
  source: SubscriptionCheckoutAttributionSource;
  evidenceId: string;
};

type CheckoutAttributionPayload = SubscriptionCheckoutAttribution & {
  v: 1;
  purpose: "subscription_checkout_attribution";
  kid: string;
  iat: number;
  exp: number;
};

type CheckoutAttributionOptions = {
  now?: Date;
  signingSecret?: string;
  previousSigningSecrets?: string | string[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;
const MAX_TOKEN_AGE_SECONDS = 31 * 24 * 60 * 60;
const DEFAULT_TOKEN_AGE_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

function currentSecret(explicit?: string): string | null {
  const value = explicit ?? process.env.EMAIL_PREFERENCE_SIGNING_SECRET;
  return typeof value === "string" && isValidEmailPreferenceSecret(value)
    ? value.trim()
    : null;
}

function previousSecrets(explicit?: string | string[]): string[] | null {
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

function keyId(secret: string): string {
  return createHash("sha256")
    .update(`openvpm-checkout-attribution-signing-key:${secret}`)
    .digest("hex")
    .slice(0, 16);
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`openvpm:subscription-checkout-attribution:v1:${encodedPayload}`)
    .digest("base64url");
}

function validAttribution<T extends Partial<SubscriptionCheckoutAttribution>>(
  value: T,
): value is T & SubscriptionCheckoutAttribution {
  return (
    typeof value.practiceId === "string" &&
    UUID_PATTERN.test(value.practiceId) &&
    typeof value.source === "string" &&
    SUBSCRIPTION_CHECKOUT_ATTRIBUTION_SOURCES.includes(
      value.source as SubscriptionCheckoutAttributionSource,
    ) &&
    typeof value.evidenceId === "string" &&
    EVIDENCE_ID_PATTERN.test(value.evidenceId)
  );
}

/**
 * Create a short-lived, purpose-bound marketing attribution token. The token
 * carries no contact or clinical data; it binds one campaign fact to the exact
 * practice that may later start Checkout.
 */
export function createSubscriptionCheckoutAttributionToken(
  input: SubscriptionCheckoutAttribution,
  options: CheckoutAttributionOptions = {},
): string | null {
  const secret = currentSecret(options.signingSecret);
  const prior = previousSecrets(options.previousSigningSecrets);
  if (!secret || !prior || !validAttribution(input)) return null;

  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: CheckoutAttributionPayload = {
    v: 1,
    purpose: "subscription_checkout_attribution",
    kid: keyId(secret),
    practiceId: input.practiceId.toLowerCase(),
    source: input.source,
    evidenceId: input.evidenceId,
    iat,
    exp: iat + DEFAULT_TOKEN_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySubscriptionCheckoutAttributionToken(
  token: string | null | undefined,
  expectedPracticeId: string,
  options: CheckoutAttributionOptions = {},
): SubscriptionCheckoutAttribution | null {
  if (!token || !UUID_PATTERN.test(expectedPracticeId)) return null;
  const current = currentSecret(options.signingSecret);
  const prior = previousSecrets(options.previousSigningSecrets);
  if (!current || !prior) return null;
  const secrets = [...new Set([current, ...prior])];

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;

  let payload: Partial<CheckoutAttributionPayload>;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CheckoutAttributionPayload>;
  } catch {
    return null;
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    payload.v !== 1 ||
    payload.purpose !== "subscription_checkout_attribution" ||
    typeof payload.kid !== "string" ||
    !KEY_ID_PATTERN.test(payload.kid) ||
    !validAttribution(payload) ||
    payload.practiceId.toLowerCase() !== expectedPracticeId.toLowerCase() ||
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isInteger(payload.exp) ||
    payload.iat > now + CLOCK_SKEW_SECONDS ||
    payload.exp < now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_AGE_SECONDS
  ) {
    return null;
  }

  const secret = secrets.find((candidate) => keyId(candidate) === payload.kid);
  if (!secret) return null;
  const expected = Buffer.from(sign(encoded, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  return {
    practiceId: payload.practiceId.toLowerCase(),
    source: payload.source,
    evidenceId: payload.evidenceId,
  };
}
