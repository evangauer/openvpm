import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { messagesFor } from "./catalog";
import { DEFAULT_LANGUAGE, LOCALE_COOKIE, MESSAGE_TIME_ZONE } from "./config";
import { getIntlMessageFallback, logMissingOnce, onIntlError } from "./errors";
import { resolveLanguage } from "./resolve";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const language = resolveLanguage({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  const messages = messagesFor(
    language,
    language === DEFAULT_LANGUAGE ? undefined : logMissingOnce,
  );

  return {
    locale: language,
    messages,
    timeZone: MESSAGE_TIME_ZONE,
    onError: onIntlError,
    getMessageFallback: getIntlMessageFallback,
  };
});
