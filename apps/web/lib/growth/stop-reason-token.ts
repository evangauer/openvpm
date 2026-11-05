import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidEmailPreferenceSecret } from "@/lib/email-preferences";

export const STOP_REASON_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;

// Signed with the email-preference signing secret, like unsubscribe links, so
// recovery email and this page never depend on the sign-in secret. The purpose
// prefix keeps these signatures distinct from preference tokens.
const PURPOSE = "openvpm.stop-reason.v1";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StopReasonTokenPayload = {
  v: 1;
  practiceId: string;
  iat: number;
  exp: number;
};

type TokenOptions = { now?: Date; secret?: string; previousSecrets?: string };

function validSecret(value: string | undefined): string | null {
  return isValidEmailPreferenceSecret(value) ? value!.trim() : null;
}

function signingSecret(options: TokenOptions): string | null {
  return validSecret(
    options.secret ?? process.env.EMAIL_PREFERENCE_SIGNING_SECRET,
  );
}

/** Current secret plus rotated-out ones, so a rotation never breaks a link. */
function verificationSecrets(options: TokenOptions): string[] {
  const previous = (
    options.previousSecrets ??
    process.env.EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS ??
    ""
  )
    .split(",")
    .map((value) => validSecret(value))
    .filter((value): value is string => value != null);
  const current = signingSecret(options);
  return [...(current ? [current] : []), ...previous];
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${PURPOSE}.${encodedPayload}`)
    .digest("base64url");
}

/**
 * A link capability that lets the recipient of a recovery email tell us why
 * they stopped, without signing in. It can only record feedback for the one
 * practice it names.
 */
export function createStopReasonToken(
  practiceId: string,
  options: TokenOptions = {},
): string | null {
  const secret = signingSecret(options);
  if (!secret || !UUID_RE.test(practiceId)) return null;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: StopReasonTokenPayload = {
    v: 1,
    practiceId: practiceId.toLowerCase(),
    iat: nowSeconds,
    exp: nowSeconds + STOP_REASON_TOKEN_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyStopReasonToken(
  token: string | null | undefined,
  options: TokenOptions = {},
): { practiceId: string } | null {
  const secrets = verificationSecrets(options);
  if (secrets.length === 0 || !token || token.length > 512) return null;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  const actual = Buffer.from(signature);
  const signed = secrets.some((secret) => {
    const expected = Buffer.from(sign(encoded, secret));
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
  if (!signed) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<StopReasonTokenPayload>;
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (
      payload.v !== 1 ||
      typeof payload.practiceId !== "string" ||
      !UUID_RE.test(payload.practiceId) ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + 300 ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return { practiceId: payload.practiceId };
  } catch {
    return null;
  }
}
