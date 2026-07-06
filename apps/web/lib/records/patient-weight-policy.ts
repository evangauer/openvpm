export const PATIENT_WEIGHT_MIN_KG = 0.001;
export const PATIENT_WEIGHT_MAX_KG = 99999.999;
export const PATIENT_WEIGHT_STEP = 0.001;
export const PATIENT_WEIGHT_SCALE = 3;
export const PATIENT_WEIGHT_MAX_INTEGER_DIGITS = 5;
export const PATIENT_WEIGHT_ERROR_MESSAGE =
  "Weight must be a positive numeric value with up to 3 decimal places.";

export function isPatientWeightInputValid(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(
    `^\\d{1,${PATIENT_WEIGHT_MAX_INTEGER_DIGITS}}(?:\\.\\d{1,${PATIENT_WEIGHT_SCALE}})?$`
  );
  if (!pattern.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return (
    Number.isFinite(parsed) &&
    parsed >= PATIENT_WEIGHT_MIN_KG &&
    parsed <= PATIENT_WEIGHT_MAX_KG
  );
}
