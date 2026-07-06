export interface Pagination {
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 100_000;

/**
 * Parse `limit`/`offset` query params with safe bounds. Invalid values fall
 * back to defaults, while oversized positive values are capped rather than
 * erroring — lenient by design for a public REST surface.
 */
export function parsePagination(searchParams: URLSearchParams): Pagination {
  const rawLimit = Number(searchParams.get("limit"));
  const rawOffset = Number(searchParams.get("offset"));

  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset =
    Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.min(Math.floor(rawOffset), MAX_OFFSET)
      : 0;

  return { limit, offset };
}

/** Standard list envelope: `{ data, pagination }`. */
export function paginated<T>(data: T[], pagination: Pagination, total: number) {
  return {
    data,
    pagination: { ...pagination, total },
  };
}
