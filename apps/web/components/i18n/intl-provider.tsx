"use client";

import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import type { ReactNode } from "react";
import { getIntlMessageFallback, onIntlError } from "@/i18n/errors";
import { MESSAGE_TIME_ZONE, type Language } from "@/i18n/config";

export function IntlProvider({
  locale,
  messages,
  children,
}: {
  locale: Language;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone={MESSAGE_TIME_ZONE}
      onError={onIntlError}
      getMessageFallback={getIntlMessageFallback}
    >
      {children}
    </NextIntlClientProvider>
  );
}
