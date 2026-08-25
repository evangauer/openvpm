export const ACQUISITION_VALUE_MAX_LENGTH = 80;

/**
 * Privacy-bounded values exposed by aggregate acquisition reporting. Raw
 * acquisition tokens are accepted only as input evidence and never returned
 * to operators unless they resolve to one of these product-owned buckets.
 */
export const ACQUISITION_REPORTING_BUCKETS = {
  source: [
    "homepage",
    "navigation",
    "cloud",
    "feature",
    "solution",
    "role",
    "comparison",
    "content",
    "install",
    "second_pims",
    "why",
    "demo",
    "clinic_fit",
    "marketing",
    "direct",
    "Other",
    "Unknown",
  ],
  medium: [
    "product",
    "organic",
    "cpc",
    "paid_social",
    "email",
    "referral",
    "direct",
    "Other",
    "Unknown",
  ],
  campaign: [
    "demo_login",
    "demo_dashboard",
    "demo_ask_ai",
    "demo_day_board",
    "demo_whiteboard",
    "demo_client_portal",
    "demo_patients",
    "demo_clients",
    "demo_records",
    "demo_billing",
    "demo_inbox",
    "demo_inventory",
    "demo_reports",
    "demo_settings",
    "demo_other",
    "demo_cta",
    "launch",
    "direct",
    "Other",
    "Unknown",
  ],
} as const;

export type AcquisitionReportingDimension =
  keyof typeof ACQUISITION_REPORTING_BUCKETS;

export function safeAcquisitionReportingBucket(
  dimension: AcquisitionReportingDimension,
  value: unknown
): string {
  if (typeof value !== "string" || value.length === 0) return "Unknown";
  const buckets = ACQUISITION_REPORTING_BUCKETS[dimension] as readonly string[];
  return buckets.includes(value) ? value : "Other";
}

const FUNNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SignupAcquisition {
  source?: string;
  medium?: string;
  campaign?: string;
  funnelId?: string;
}

type SearchParamsReader = {
  get(name: string): string | null;
};

function clean(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > ACQUISITION_VALUE_MAX_LENGTH) return undefined;
  return /^[a-zA-Z0-9._:/-]+$/.test(trimmed) ? trimmed : undefined;
}

/** Read only the small, non-sensitive attribution values the signup API accepts. */
export function acquisitionFromSearchParams(
  params: SearchParamsReader
): SignupAcquisition | undefined {
  const source = clean(params.get("source")) ?? clean(params.get("utm_source"));
  const medium = clean(params.get("utm_medium"));
  const campaign = clean(params.get("utm_campaign"));
  const funnelId = clean(params.get("funnel_id"));
  const validFunnelId =
    funnelId && FUNNEL_ID_RE.test(funnelId)
      ? funnelId.toLowerCase()
      : undefined;
  if (!source && !medium && !campaign && !validFunnelId) return undefined;
  return {
    source,
    medium,
    campaign,
    ...(validFunnelId ? { funnelId: validFunnelId } : {}),
  };
}

/**
 * Attach the first-party visitor UUID when signup did not arrive with one in
 * the URL. Explicit cross-domain attribution always wins. Invalid values are
 * ignored, and no identity or contact data is introduced.
 */
export function acquisitionWithFunnelVisitorId(
  acquisition: SignupAcquisition | undefined,
  visitorId: string | null | undefined
): SignupAcquisition | undefined {
  if (acquisition?.funnelId) return acquisition;

  const normalizedVisitorId = visitorId?.trim().toLowerCase();
  if (!normalizedVisitorId || !FUNNEL_ID_RE.test(normalizedVisitorId)) {
    return acquisition;
  }

  return {
    ...acquisition,
    funnelId: normalizedVisitorId,
  };
}
