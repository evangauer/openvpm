export const VITALS_TEMPERATURE_MIN_C = 20;
export const VITALS_TEMPERATURE_MAX_C = 45;
export const VITALS_TEMPERATURE_STEP = 0.1;
export const VITALS_TEMPERATURE_SCALE = 1;
export const VITALS_HEART_RATE_MIN_BPM = 0;
export const VITALS_HEART_RATE_MAX_BPM = 400;
export const VITALS_RESPIRATORY_RATE_MIN_BPM = 0;
export const VITALS_RESPIRATORY_RATE_MAX_BPM = 300;
export const VITALS_WEIGHT_MIN_KG = 0.001;
// Numeric storage supports 99,999.999 kg. Keep a conservative clinical ceiling
// that still accommodates large bovine/equine patients and group weights.
export const VITALS_WEIGHT_MAX_KG = 10_000;
export const VITALS_WEIGHT_STEP = 0.001;
export const VITALS_WEIGHT_SCALE = 3;
export const VITALS_BODY_CONDITION_MIN = 1;
export const VITALS_BODY_CONDITION_MAX = 9;
export const VITALS_PAIN_SCORE_MIN = 0;
export const VITALS_PAIN_SCORE_MAX = 10;
export const VITALS_CAPILLARY_REFILL_MIN_SEC = 0;
export const VITALS_CAPILLARY_REFILL_MAX_SEC = 10;
export const VITALS_CAPILLARY_REFILL_STEP = 0.1;
export const VITALS_CAPILLARY_REFILL_SCALE = 1;
export const VITALS_MUCOUS_MEMBRANE_MAX_LENGTH = 64;
export const VITALS_NOTES_MAX_LENGTH = 5000;

function decimalInputToNumber(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const [, decimals = ""] = trimmed.split(".");
  return decimals.length <= scale ? parsed : null;
}

function isOptionalDecimalInputValid(
  value: string,
  options: {
    min: number;
    max: number;
    scale: number;
  },
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const parsed = decimalInputToNumber(trimmed, options.scale);
  return parsed !== null && parsed >= options.min && parsed <= options.max;
}

function isOptionalIntegerInputValid(
  value: string,
  options: {
    min: number;
    max: number;
  },
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!/^\d+$/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return (
    Number.isSafeInteger(parsed) &&
    parsed >= options.min &&
    parsed <= options.max
  );
}

export function isVitalsOptionalTemperatureInputValid(value: string): boolean {
  return isOptionalDecimalInputValid(value, {
    min: VITALS_TEMPERATURE_MIN_C,
    max: VITALS_TEMPERATURE_MAX_C,
    scale: VITALS_TEMPERATURE_SCALE,
  });
}

export function isVitalsOptionalHeartRateInputValid(value: string): boolean {
  return isOptionalIntegerInputValid(value, {
    min: VITALS_HEART_RATE_MIN_BPM,
    max: VITALS_HEART_RATE_MAX_BPM,
  });
}

export function isVitalsOptionalRespiratoryRateInputValid(
  value: string,
): boolean {
  return isOptionalIntegerInputValid(value, {
    min: VITALS_RESPIRATORY_RATE_MIN_BPM,
    max: VITALS_RESPIRATORY_RATE_MAX_BPM,
  });
}

export function isVitalsOptionalWeightInputValid(value: string): boolean {
  return isOptionalDecimalInputValid(value, {
    min: VITALS_WEIGHT_MIN_KG,
    max: VITALS_WEIGHT_MAX_KG,
    scale: VITALS_WEIGHT_SCALE,
  });
}

export function isVitalsOptionalBodyConditionInputValid(
  value: string,
  max: 5 | 9 = VITALS_BODY_CONDITION_MAX,
): boolean {
  return isOptionalIntegerInputValid(value, {
    min: VITALS_BODY_CONDITION_MIN,
    max,
  });
}

export function isVitalsOptionalPainScoreInputValid(value: string): boolean {
  return isOptionalIntegerInputValid(value, {
    min: VITALS_PAIN_SCORE_MIN,
    max: VITALS_PAIN_SCORE_MAX,
  });
}

export function isVitalsOptionalCapillaryRefillInputValid(
  value: string,
): boolean {
  return isOptionalDecimalInputValid(value, {
    min: VITALS_CAPILLARY_REFILL_MIN_SEC,
    max: VITALS_CAPILLARY_REFILL_MAX_SEC,
    scale: VITALS_CAPILLARY_REFILL_SCALE,
  });
}

export function isVitalsOptionalTextInputValid(
  value: string,
  maxLength: number,
): boolean {
  return value.trim().length <= maxLength;
}
