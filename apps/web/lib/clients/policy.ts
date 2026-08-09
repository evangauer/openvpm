export const CLIENT_NAME_MAX_LENGTH = 128;
export const CLIENT_EMAIL_MAX_LENGTH = 255;
export const CLIENT_PHONE_MAX_LENGTH = 32;
export const CLIENT_ADDRESS_MAX_LENGTH = 500;
export const CLIENT_CITY_MAX_LENGTH = 128;
export const CLIENT_STATE_MAX_LENGTH = 64;
export const CLIENT_ZIP_MAX_LENGTH = 16;
export const CLIENT_SEARCH_MAX_LENGTH = 100;

export const CLIENT_CONTACT_METHODS = [
  "phone",
  "email",
  "sms",
  "portal",
] as const;
export type ClientContactMethod = (typeof CLIENT_CONTACT_METHODS)[number];

export function isRequiredClientTextValid(
  value: string,
  maxLength: number,
): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

export function isOptionalClientTextValid(
  value: string,
  maxLength: number,
): boolean {
  return value.trim().length <= maxLength;
}

export function isClientSearchInputValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= CLIENT_SEARCH_MAX_LENGTH;
}
