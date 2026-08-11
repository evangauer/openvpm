export const CLINIC_REGION_CODES = ["US", "CA", "GB", "IE", "AU"] as const;

export type ClinicRegionCode = (typeof CLINIC_REGION_CODES)[number];
export type JurisdictionSelectionSource =
  | "registration"
  | "onboarding"
  | "settings";

export const CLINIC_REGION_OPTIONS: ReadonlyArray<{
  code: ClinicRegionCode;
  label: string;
}> = [
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
  { code: "AU", label: "Australia" },
];

export function isClinicRegionCode(value: string): value is ClinicRegionCode {
  return CLINIC_REGION_CODES.includes(value as ClinicRegionCode);
}

export interface ExplicitJurisdictionState {
  jurisdictionCountry: ClinicRegionCode;
  jurisdictionSelectedAt: string;
  jurisdictionSource: JurisdictionSelectionSource;
}

export function explicitJurisdictionState(
  country: ClinicRegionCode,
  source: JurisdictionSelectionSource,
  selectedAt: string,
): ExplicitJurisdictionState {
  return {
    jurisdictionCountry: country,
    jurisdictionSelectedAt: selectedAt,
    jurisdictionSource: source,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A database country default is not evidence that a clinic chose its
 * jurisdiction. This requires a durable selection marker that still matches
 * the live practice country.
 */
export function hasExplicitPracticeJurisdiction(
  settings: unknown,
  country: string | null | undefined,
): boolean {
  const onboardingState = asRecord(asRecord(settings)?.onboardingState);
  const selectedCountry = onboardingState?.jurisdictionCountry;
  const selectedAt = onboardingState?.jurisdictionSelectedAt;
  return (
    typeof country === "string" &&
    typeof selectedCountry === "string" &&
    selectedCountry === country.toUpperCase() &&
    typeof selectedAt === "string" &&
    selectedAt.trim().length > 0
  );
}
