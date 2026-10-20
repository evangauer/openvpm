/**
 * Region/locale helpers. Pure — gates currency + date formatting and supplies
 * sensible regional defaults so the app isn't hardcoded to US/USD/8% tax.
 * `country` is ISO 3166-1 alpha-2 (e.g. "US", "GB"); `currency` ISO 4217.
 */

const COUNTRY_LOCALE: Record<string, string> = {
  US: "en-US",
  GB: "en-GB",
  IE: "en-IE",
  CA: "en-CA",
  AU: "en-AU",
  JP: "ja-JP",
};

export function localeForCountry(country?: string | null): string {
  return COUNTRY_LOCALE[(country ?? "US").toUpperCase()] ?? "en-US";
}

export function formatCurrency(
  amount: number | string | null | undefined,
  currency: string = "usd",
  country?: string | null
): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount ?? 0;
  return new Intl.NumberFormat(localeForCountry(country), {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(Number.isFinite(n) ? (n as number) : 0);
}

export function formatDate(date: Date | string, country?: string | null): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(localeForCountry(country), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    // Date-only values must not shift by the runtime's timezone.
    timeZone: "UTC",
  }).format(d);
}

/** Which controlled-drug / prescribing framework applies (used later, P1). */
export function regulatoryFramework(country?: string | null): "uk_vmd" | "us_dea" {
  return (country ?? "US").toUpperCase() === "GB" ? "uk_vmd" : "us_dea";
}

export interface RegionDefaults {
  currency: string;
  /** Standard sales-tax / VAT rate as a percent string (e.g. "20.00"). */
  taxRatePercent: string;
  timezone: string;
}

/** Defaults applied when a practice picks a country (onboarding / settings). */
export function regionDefaults(country?: string | null): RegionDefaults {
  switch ((country ?? "US").toUpperCase()) {
    case "GB":
      return { currency: "gbp", taxRatePercent: "20.00", timezone: "Europe/London" };
    case "IE":
      return { currency: "eur", taxRatePercent: "23.00", timezone: "Europe/Dublin" };
    case "CA":
      return { currency: "cad", taxRatePercent: "5.00", timezone: "America/Toronto" };
    case "AU":
      return { currency: "aud", taxRatePercent: "10.00", timezone: "Australia/Sydney" };
    case "JP":
      // Consumption tax standard rate. Veterinary care is not a tax-exempt medical service in Japan.
      return { currency: "jpy", taxRatePercent: "10.00", timezone: "Asia/Tokyo" };
    default:
      return { currency: "usd", taxRatePercent: "8.00", timezone: "America/New_York" };
  }
}
