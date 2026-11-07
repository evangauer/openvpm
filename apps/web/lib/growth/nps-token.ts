import {
  createFeedbackToken,
  verifyFeedbackToken,
  type FeedbackTokenOptions,
} from "@/lib/growth/feedback-token";

/** Long enough to answer a survey email that sat in the inbox for a while. */
export const NPS_TOKEN_TTL_SECONDS = 45 * 24 * 60 * 60;

const PURPOSE = "openvpm.nps.v1";

/**
 * A link capability that records one practice's answer to one NPS survey,
 * without signing in.
 */
export function createNpsToken(
  practiceId: string,
  survey: string,
  options: FeedbackTokenOptions = {},
): string | null {
  return createFeedbackToken(
    PURPOSE,
    { practiceId, survey, ttlSeconds: NPS_TOKEN_TTL_SECONDS },
    options,
  );
}

export function verifyNpsToken(
  token: string | null | undefined,
  options: FeedbackTokenOptions = {},
): { practiceId: string; survey: string } | null {
  const verified = verifyFeedbackToken(PURPOSE, token, options);
  return verified?.survey
    ? { practiceId: verified.practiceId, survey: verified.survey }
    : null;
}
