export type AutomatedReminderSuppressionReason =
  | "seeded_demo_data"
  | "reserved_email_domain";

const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
]);

const RESERVED_EMAIL_SUFFIXES = [".example", ".invalid", ".localhost", ".test"];

/**
 * RFC-reserved domains are useful in examples and fixtures but must never be
 * handed to a real delivery provider. Exact example.com/net/org names and
 * their subdomains are reserved, as are the four special-use test TLDs.
 */
export function hasReservedEmailDomain(
  value: string | null | undefined
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;

  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at !== normalized.indexOf("@")) return false;

  const domain = normalized.slice(at + 1).replace(/\.$/, "");
  if (!domain) return false;

  if (RESERVED_EMAIL_DOMAINS.has(domain)) return true;
  if (
    [...RESERVED_EMAIL_DOMAINS].some((reserved) =>
      domain.endsWith(`.${reserved}`)
    )
  ) {
    return true;
  }

  return RESERVED_EMAIL_SUFFIXES.some(
    (suffix) => domain === suffix.slice(1) || domain.endsWith(suffix)
  );
}

/**
 * Fail closed before an automated reminder creates a delivery claim. Sample
 * records stay visible in the product, but neither they nor reserved fixture
 * addresses can reach an email/SMS provider.
 */
export function automatedAppointmentReminderSuppressionReason(input: {
  isSeededDemoClient?: boolean | null;
  isSeededDemoAppointment?: boolean | null;
  clientEmail?: string | null;
}): AutomatedReminderSuppressionReason | null {
  if (input.isSeededDemoClient || input.isSeededDemoAppointment) {
    return "seeded_demo_data";
  }

  if (hasReservedEmailDomain(input.clientEmail)) {
    return "reserved_email_domain";
  }

  return null;
}
