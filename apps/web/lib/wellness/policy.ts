export const WELLNESS_PLAN_NAME_MAX_LENGTH = 255;
export const WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH = 2000;
export const WELLNESS_PLAN_PRICE_MIN = 0;
export const WELLNESS_PLAN_PRICE_MAX = 99999999.99;
export const WELLNESS_PLAN_PRICE_SCALE = 2;

export function hasWellnessPlanPriceScale(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Number(value.toFixed(WELLNESS_PLAN_PRICE_SCALE)) === value;
}

export function isWellnessPlanPriceInputValid(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const price = Number(trimmed);
  return (
    Number.isFinite(price) &&
    price >= WELLNESS_PLAN_PRICE_MIN &&
    price <= WELLNESS_PLAN_PRICE_MAX &&
    hasWellnessPlanPriceScale(price)
  );
}
