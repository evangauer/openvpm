const DOCTOR_PREFIX_PATTERN = /^(dr\.?|doctor)\s/i;

/**
 * Formats a provider name for display with a single "Dr." prefix.
 * Stored names often already include the title ("Dr. Sarah Chen"), so the
 * prefix is only added when it is missing.
 */
export function providerDisplayName(
  name: string | null | undefined,
  fallback = "Unassigned provider",
): string {
  const normalized = name?.trim();
  if (!normalized) return fallback;
  return DOCTOR_PREFIX_PATTERN.test(normalized)
    ? normalized
    : `Dr. ${normalized}`;
}
