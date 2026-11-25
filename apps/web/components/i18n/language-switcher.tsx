"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setLanguage } from "@/i18n/actions";
import { SUPPORTED_LANGUAGES } from "@/i18n/config";

export function LanguageSwitcher() {
  const t = useTranslations("common.language");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string>(locale);

  useEffect(() => {
    setSelected(locale);
  }, [locale]);

  function onChange(next: string) {
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      try {
        await setLanguage(next);
        router.refresh();
      } catch {
        setSelected(previous);
      }
    });
  }

  return (
    <div className="mt-6 flex items-center justify-center gap-2">
      <label
        htmlFor="openvpm-language"
        className="text-sm text-muted-foreground"
      >
        {t("label")}
      </label>
      <select
        id="openvpm-language"
        value={selected}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {t(language)}
          </option>
        ))}
      </select>
    </div>
  );
}
