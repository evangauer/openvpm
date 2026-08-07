export const ACQUISITION_VALUE_MAX_LENGTH = 80;

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
