import {
  createFeedbackToken,
  verifyFeedbackToken,
  type FeedbackTokenOptions,
} from "@/lib/growth/feedback-token";

export const STOP_REASON_TOKEN_TTL_SECONDS = 60 * 24 * 60 * 60;

const PURPOSE = "openvpm.stop-reason.v1";

/**
 * A link capability that lets the recipient of a recovery email tell us why
 * they stopped, without signing in. It can only record feedback for the one
 * practice it names.
 */
export function createStopReasonToken(
  practiceId: string,
  options: FeedbackTokenOptions = {},
): string | null {
  return createFeedbackToken(
    PURPOSE,
    { practiceId, ttlSeconds: STOP_REASON_TOKEN_TTL_SECONDS },
    options,
  );
}

export function verifyStopReasonToken(
  token: string | null | undefined,
  options: FeedbackTokenOptions = {},
): { practiceId: string } | null {
  const verified = verifyFeedbackToken(PURPOSE, token, options);
  return verified ? { practiceId: verified.practiceId } : null;
}
