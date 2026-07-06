export type EmailSuppressionReason =
  | "manual"
  | "bounce"
  | "complaint"
  | "suppressed";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmailSuppressionAddress(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > 255) return null;
  return EMAIL_RE.test(normalized) ? normalized : null;
}

export function emailSuppressionSendBlockMessage(
  reason: EmailSuppressionReason | string | null | undefined
): string {
  const detail =
    reason === "complaint"
      ? "a spam complaint"
      : reason === "suppressed"
        ? "provider suppression"
        : reason === "manual"
          ? "manual suppression"
          : "a delivery bounce";
  return `Client email is suppressed after ${detail}. Update the client email before sending.`;
}
