export const AUTH_EMAIL_MAX_LENGTH = 255;
export const AUTH_NAME_MAX_LENGTH = 255;
export const AUTH_PRACTICE_NAME_MAX_LENGTH = 255;
export const AUTH_LOCATION_NAME_MAX_LENGTH = 255;
export const AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH = 120;
export const AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH = 80;

export function isRequiredAuthTextValid(
  value: string,
  maxLength: number,
  minLength = 1
): boolean {
  const trimmed = value.trim();
  return trimmed.length >= minLength && trimmed.length <= maxLength;
}

export function isOptionalAuthTextValid(
  value: string,
  maxLength: number
): boolean {
  return value.trim().length <= maxLength;
}

export function isAuthEmailLengthValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= AUTH_EMAIL_MAX_LENGTH;
}
