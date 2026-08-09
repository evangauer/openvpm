/**
 * Normalise a phone number to E.164 for consistent storage and comparison
 * (suppression matching, inbound STOP sync). US/Canada-centric: a bare 10-digit
 * number is assumed +1. Returns null for input we can't confidently normalise,
 * so callers fail safe rather than guess.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) {
    return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`; // US/CA national
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Other lengths without a country code are ambiguous — reject.
  return null;
}
