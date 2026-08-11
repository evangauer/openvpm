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

/**
 * Conservative structural gate for the physical postal address required in
 * promotional email footers. This intentionally does not claim that an
 * address exists or is deliverable; operators must verify that separately.
 */
export function isPlausiblePhysicalCompanyAddress(
  value: string | null | undefined,
): boolean {
  const address = value?.trim();
  if (!address || address.length < 10 || address.length > 300) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(address)) return false;
  if (
    address.includes("@") ||
    /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/iu.test(address)
  ) {
    return false;
  }
  return /[a-z]/iu.test(address) && /\d/u.test(address) && /\s/u.test(address);
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
