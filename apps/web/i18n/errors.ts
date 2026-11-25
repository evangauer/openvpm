import { IntlError, IntlErrorCode } from "next-intl";
import en from "../messages/en.json";
import { lookupMessage } from "./merge";

const logged = new Set<string>();

/** Development-only, once per key. Never throws. */
export function logMissingOnce(path: string): void {
  if (process.env.NODE_ENV !== "development") return;
  if (!path || logged.has(path)) return;
  logged.add(path);
  console.warn(`[i18n] Missing message "${path}". Falling back to English.`);
}

export function onIntlError(error: IntlError): void {
  try {
    if (error.code === IntlErrorCode.MISSING_MESSAGE) {
      logMissingOnce(error.originalMessage ?? error.message);
      return;
    }
    if (process.env.NODE_ENV === "development") {
      const key = `${error.code}:${error.message}`;
      if (logged.has(key)) return;
      logged.add(key);
      console.error(error);
    }
  } catch {
    // Message lookup must not take down the page.
  }
}

export function getIntlMessageFallback({
  namespace,
  key,
}: {
  error: IntlError;
  key: string;
  namespace?: string;
}): string {
  try {
    const path = [namespace, key].filter((part) => part).join(".");
    if (!path) return "";
    return lookupMessage(en, path) ?? path;
  } catch {
    return key || namespace || "";
  }
}
