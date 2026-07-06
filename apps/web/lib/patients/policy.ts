export const PATIENT_NAME_MAX_LENGTH = 128;
export const PATIENT_BREED_MAX_LENGTH = 128;
export const PATIENT_COLOR_MAX_LENGTH = 64;
export const PATIENT_MICROCHIP_NUMBER_MAX_LENGTH = 64;
export const PATIENT_PHOTO_URL_MAX_LENGTH = 512;
export const PATIENT_SEARCH_MAX_LENGTH = 128;

export function isRequiredPatientTextValid(
  value: string,
  maxLength: number
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isOptionalPatientTextValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isPatientSearchInputValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= PATIENT_SEARCH_MAX_LENGTH;
}
