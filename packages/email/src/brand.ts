/**
 * Brand identity passed into every email shell. Defaults resolve OpenVPM's
 * hosted identity from env (so app + emails stay in sync), with sane fallbacks
 * for local rendering / previews.
 */
export interface Brand {
  /** Display name in the header wordmark. */
  name: string;
  /** Legal/company name shown in the footer. */
  companyName: string;
  /** Reply-To + footer contact address. */
  supportEmail: string;
  /** Physical mailing address (CAN-SPAM for promotional nudges). Optional. */
  companyAddress?: string;
  /** Base URL of the hosted app (CTAs). */
  appUrl: string;
  /** Marketing site URL. */
  marketingUrl: string;
  /**
   * Optional hosted logo image (PNG recommended — most email clients strip
   * SVG). When omitted, the shell renders a CSS wordmark that works everywhere.
   */
  logoUrl?: string;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const URL_LIKE_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)/iu;
const PO_BOX_PATTERN =
  /\b(?:p\.?\s*o\.?\s+box|post office box|pmb)\s*[a-z0-9-]+\b/iu;
const RURAL_ROUTE_PATTERN =
  /\b(?:rr|rural route)\s*\d+[a-z0-9-]*\s+box\s*[a-z0-9-]+\b/iu;
const STREET_ADDRESS_PATTERN =
  /\b\d+[a-z]?(?:-\d+[a-z]?)?\s+[a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,5}\s+(?:avenue|ave|boulevard|blvd|circle|cir|court|ct|drive|dr|highway|hwy|lane|ln|loop|parkway|pkwy|place|pl|plaza|road|rd|route|rte|square|sq|street|st|terrace|ter|trail|trl|way)\b/iu;

/**
 * Conservative structural gate for the physical postal address required in
 * promotional email footers. This does not prove that an address exists or is
 * deliverable; a hosted operator must verify that separately.
 */
export function isPlausiblePhysicalCompanyAddress(
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const address = value.trim();
  if (!address || address.length < 10 || address.length > 300) return false;
  if (address.includes("@") || URL_LIKE_PATTERN.test(address)) return false;

  return (
    PO_BOX_PATTERN.test(address) ||
    RURAL_ROUTE_PATTERN.test(address) ||
    STREET_ADDRESS_PATTERN.test(address)
  );
}

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function openvpmBrand(): Brand {
  return {
    name: "OpenVPM",
    companyName: nonBlankEnv("EMAIL_COMPANY_NAME") ?? "OpenVPM",
    supportEmail: nonBlankEnv("EMAIL_SUPPORT_ADDRESS") ?? "support@openvpm.com",
    companyAddress: nonBlankEnv("EMAIL_COMPANY_ADDRESS"),
    appUrl: nonBlankEnv("NEXT_PUBLIC_APP_URL") ?? "https://app.openvpm.com",
    marketingUrl: "https://openvpm.com",
    logoUrl: nonBlankEnv("EMAIL_LOGO_URL"),
  };
}
