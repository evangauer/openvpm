export const PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH = 255;
export const PRESCRIPTION_DOSAGE_MAX_LENGTH = 128;
export const PRESCRIPTION_FREQUENCY_MAX_LENGTH = 128;
export const PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH = 5000;
export const PRESCRIPTION_QUANTITY_MIN = 1;
export const PRESCRIPTION_REFILLS_MIN = 0;
export const PRESCRIPTION_COUNT_MAX = 2_147_483_647;

function integerInputToNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isPrescriptionRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isPrescriptionOptionalTextInputValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isPrescriptionPositiveIntegerInputValid(
  value: string
): boolean {
  const parsed = integerInputToNumber(value);
  return (
    parsed !== null &&
    parsed >= PRESCRIPTION_QUANTITY_MIN &&
    parsed <= PRESCRIPTION_COUNT_MAX
  );
}

export function isPrescriptionOptionalPositiveIntegerInputValid(
  value: string
): boolean {
  return (
    value.trim().length === 0 || isPrescriptionPositiveIntegerInputValid(value)
  );
}

export function isPrescriptionNonnegativeIntegerInputValid(
  value: string
): boolean {
  const parsed = integerInputToNumber(value);
  return (
    parsed !== null &&
    parsed >= PRESCRIPTION_REFILLS_MIN &&
    parsed <= PRESCRIPTION_COUNT_MAX
  );
}
