export const PROCEDURE_NAME_MAX_LENGTH = 255;
export const PROCEDURE_DESCRIPTION_MAX_LENGTH = 5000;
export const PROCEDURE_ANESTHESIA_MAX_LENGTH = 2000;
export const PROCEDURE_NOTES_MAX_LENGTH = 5000;
export const PROCEDURE_DURATION_MIN_MINUTES = 1;
export const PROCEDURE_DURATION_MAX_MINUTES = 24 * 60;

export function isProcedureRequiredTextInputValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isProcedureOptionalTextInputValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isProcedureOptionalDurationInputValid(
  value: string
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!/^\d+$/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return (
    Number.isSafeInteger(parsed) &&
    parsed >= PROCEDURE_DURATION_MIN_MINUTES &&
    parsed <= PROCEDURE_DURATION_MAX_MINUTES
  );
}
