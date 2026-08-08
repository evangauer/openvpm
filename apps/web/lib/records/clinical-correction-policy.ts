export const CLINICAL_CORRECTION_REASON_MIN_LENGTH = 5;
export const CLINICAL_CORRECTION_REASON_MAX_LENGTH = 1000;

export function isClinicalCorrectionReasonValid(reason: string): boolean {
  const length = reason.trim().length;
  return (
    length >= CLINICAL_CORRECTION_REASON_MIN_LENGTH &&
    length <= CLINICAL_CORRECTION_REASON_MAX_LENGTH
  );
}
