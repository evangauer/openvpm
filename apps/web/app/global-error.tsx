"use client";

import { useSyncExternalStore } from "react";
import { AppErrorView } from "@/components/common/app-error-view";
import { IntlProvider } from "@/components/i18n/intl-provider";
import { messagesFor } from "@/i18n/catalog";
import {
  canonicalLanguage,
  DEFAULT_LANGUAGE,
  LOCALE_COOKIE,
  type Language,
} from "@/i18n/config";
import "@/styles/globals.css";

function subscribe(): () => void {
  return () => undefined;
}

function languageFromDocument(): Language {
  try {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`),
    );
    const raw = match?.[1] ? decodeURIComponent(match[1]) : null;
    return canonicalLanguage(raw) ?? DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // This screen replaces the root layout, so the language cookie is read here.
  const language = useSyncExternalStore(
    subscribe,
    languageFromDocument,
    () => DEFAULT_LANGUAGE,
  );

  return (
    <html lang={language}>
      <body>
        <IntlProvider locale={language} messages={messagesFor(language)}>
          <AppErrorView error={error} reset={reset} source="global-error" />
        </IntlProvider>
      </body>
    </html>
  );
}
