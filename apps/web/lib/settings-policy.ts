export const SETTINGS_PHONE_MAX_LENGTH = 32;
export const SETTINGS_ADDRESS_MAX_LENGTH = 500;
export const SETTINGS_EMAIL_MAX_LENGTH = 255;
export const SETTINGS_WEBSITE_MAX_LENGTH = 255;
export const SETTINGS_TIMEZONE_MAX_LENGTH = 64;
export const SETTINGS_VAT_NUMBER_MAX_LENGTH = 32;
export const SETTINGS_TAX_RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
export const SETTINGS_TAX_RATE_MAX_PERCENT = 100;
export const ACCOUNT_DELETION_REASON_MAX_LENGTH = 1000;
export const PRACTICE_NAME_MAX_LENGTH = 255;
export const LOCATION_NAME_MAX_LENGTH = 255;
export const STAFF_NAME_MAX_LENGTH = 255;
export const STAFF_LICENSE_NUMBER_MAX_LENGTH = 64;
export const APPOINTMENT_TYPE_NAME_MAX_LENGTH = 128;
export const APPOINTMENT_TYPE_DURATION_MIN_MINUTES = 5;
export const APPOINTMENT_TYPE_DURATION_MAX_MINUTES = 480;
export const ROOM_NAME_MAX_LENGTH = 128;

export function isValidSettingsTaxRate(value: string): boolean {
  const normalized = value.trim();
  if (!SETTINGS_TAX_RATE_PATTERN.test(normalized)) return false;
  const rate = Number(normalized);
  return (
    Number.isFinite(rate) &&
    rate >= 0 &&
    rate <= SETTINGS_TAX_RATE_MAX_PERCENT
  );
}

export function isSupportedPracticeTimezone(value: string): boolean {
  const timezone = value.trim();
  if (
    timezone.length === 0 ||
    timezone.length > SETTINGS_TIMEZONE_MAX_LENGTH
  ) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
      new Date(0)
    );
    return true;
  } catch {
    return false;
  }
}
