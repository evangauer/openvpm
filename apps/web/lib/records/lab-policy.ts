export const LAB_TEST_NAME_MAX_LENGTH = 255;
export const LAB_RESULT_VALUE_MAX_LENGTH = 128;
export const LAB_UNIT_MAX_LENGTH = 32;
export const LAB_REFERENCE_MIN = -9999999.999;
export const LAB_REFERENCE_MAX = 9999999.999;
export const LAB_REFERENCE_STEP = 0.001;

const LAB_REFERENCE_RE = /^-?\d{1,7}(?:\.\d{1,3})?$/;

export function isLabRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isLabOptionalTextInputValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isLabReferenceInputValid(value: string): boolean {
  const trimmed = value.trim();
  if (!LAB_REFERENCE_RE.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return (
    Number.isFinite(parsed) &&
    parsed >= LAB_REFERENCE_MIN &&
    parsed <= LAB_REFERENCE_MAX
  );
}

export function isLabOptionalReferenceInputValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || isLabReferenceInputValid(trimmed);
}

export function isLabReferenceRangeOrdered(low: string, high: string): boolean {
  const trimmedLow = low.trim();
  const trimmedHigh = high.trim();
  if (!trimmedLow || !trimmedHigh) return true;
  if (
    !isLabReferenceInputValid(trimmedLow) ||
    !isLabReferenceInputValid(trimmedHigh)
  ) {
    return false;
  }
  return Number(trimmedLow) <= Number(trimmedHigh);
}
