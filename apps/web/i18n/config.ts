/**
 * UI language. This is not a formatting locale and it does not select a
 * country, currency, or clinic region.
 */
export const SUPPORTED_LANGUAGES = ["en", "es-419", "it"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

/** Cookie set by the language switcher. Contributors can also set it directly. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * next-intl needs one zone so server and client markup match. Clinic dates,
 * times, and currencies stay on the helpers in `lib/locale`.
 */
export const MESSAGE_TIME_ZONE = "UTC";

export function canonicalLanguage(
  value: string | null | undefined,
): Language | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(normalized)
    ? (normalized as Language)
    : null;
}

export function isSupportedLanguage(
  value: string | null | undefined,
): value is Language {
  return canonicalLanguage(value) !== null;
}
