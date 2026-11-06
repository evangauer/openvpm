/**
 * Deterministic A/B bucketing for anonymous funnel visitors. Client-safe, so
 * a page and the server agree on the arm from the same funnel id.
 */

/** 32-bit FNV-1a: a stable, dependency-free bucket for a visitor id. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Share (0-100) from an env value; anything invalid or negative is 0. */
export function percentFromEnv(raw: string | undefined): number {
  const value = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 100);
}

/**
 * True when this visitor falls inside `percent` for the experiment named by
 * `salt`. Visitors without a funnel id are never in the treatment, which keeps
 * every treatment signup attributable.
 */
export function inTreatment(
  funnelId: string | null | undefined,
  percent: number,
  salt: string,
): boolean {
  const id = funnelId?.trim().toLowerCase();
  if (!id || percent <= 0) return false;
  if (percent >= 100) return true;
  return fnv1a(`${salt}:${id}`) % 100 < percent;
}
