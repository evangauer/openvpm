import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidEmailPreferenceSecret } from "@/lib/email-preferences";

/**
 * Sign-in-free feedback links from growth email (stop reasons, NPS). Signed
 * with the email-preference signing secret, like unsubscribe links, so these
 * emails and their pages never depend on the sign-in secret. Each purpose
 * prefix keeps its signatures distinct from every other token type.
 */
export type FeedbackTokenOptions = {
  now?: Date;
  secret?: string;
  previousSecrets?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SURVEY_RE = /^[a-z0-9:-]{1,64}$/;

type FeedbackTokenPayload = {
  v: 1;
  practiceId: string;
  /** Optional survey key, e.g. "nps:3", so one link answers one survey. */
  survey?: string;
  iat: number;
  exp: number;
};

function validSecret(value: string | undefined): string | null {
  return isValidEmailPreferenceSecret(value) ? value!.trim() : null;
}

function signingSecret(options: FeedbackTokenOptions): string | null {
  return validSecret(
    options.secret ?? process.env.EMAIL_PREFERENCE_SIGNING_SECRET,
  );
}

/** Current secret plus rotated-out ones, so a rotation never breaks a link. */
function verificationSecrets(options: FeedbackTokenOptions): string[] {
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

function sign(purpose: string, encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${purpose}.${encodedPayload}`)
    .digest("base64url");
}

export function createFeedbackToken(
  purpose: string,
  input: { practiceId: string; survey?: string; ttlSeconds: number },
  options: FeedbackTokenOptions = {},
): string | null {
  const secret = signingSecret(options);
  if (!secret || !UUID_RE.test(input.practiceId)) return null;
  if (input.survey !== undefined && !SURVEY_RE.test(input.survey)) return null;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: FeedbackTokenPayload = {
    v: 1,
    practiceId: input.practiceId.toLowerCase(),
    ...(input.survey !== undefined ? { survey: input.survey } : {}),
    iat: nowSeconds,
    exp: nowSeconds + input.ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(purpose, encoded, secret)}`;
}

export function verifyFeedbackToken(
  purpose: string,
  token: string | null | undefined,
  options: FeedbackTokenOptions = {},
): { practiceId: string; survey: string | null } | null {
  const secrets = verificationSecrets(options);
  if (secrets.length === 0 || !token || token.length > 512) return null;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  const actual = Buffer.from(signature);
  const signed = secrets.some((secret) => {
    const expected = Buffer.from(sign(purpose, encoded, secret));
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
  if (!signed) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<FeedbackTokenPayload>;
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (
      payload.v !== 1 ||
      typeof payload.practiceId !== "string" ||
      !UUID_RE.test(payload.practiceId) ||
      (payload.survey !== undefined &&
        (typeof payload.survey !== "string" ||
          !SURVEY_RE.test(payload.survey))) ||
      typeof payload.iat !== "number" ||
      payload.iat > nowSeconds + 300 ||
      typeof payload.exp !== "number" ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return { practiceId: payload.practiceId, survey: payload.survey ?? null };
  } catch {
    return null;
  }
}
