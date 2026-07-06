import { normalizeE164 } from "./phone";

export const MESSAGING_PHONE_MIN_LENGTH = 7;
export const MESSAGING_PHONE_MAX_LENGTH = 32;
export const MESSAGING_AREA_CODE_LENGTH = 3;
export const MESSAGING_SEARCH_LIMIT_MAX = 20;

export function isMessagingPhoneInputValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= MESSAGING_PHONE_MIN_LENGTH &&
    trimmed.length <= MESSAGING_PHONE_MAX_LENGTH &&
    normalizeE164(trimmed) !== null
  );
}

export function isMessagingAreaCodeInputValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    new RegExp(`^\\d{${MESSAGING_AREA_CODE_LENGTH}}$`).test(trimmed)
  );
}
