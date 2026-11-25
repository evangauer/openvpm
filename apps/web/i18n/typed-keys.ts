import { useTranslations } from "next-intl";

/** Imported by type-check so a misspelled catalog key fails `tsc`. */
export function typedCatalogKeys(): void {
  const signIn = useTranslations("auth.signIn");
  signIn("submit");
  signIn("rateLimitedMinutes", { count: 2 });
  // @ts-expect-error Unknown catalog keys must fail type-check.
  signIn("missingKey");

  const metadata = useTranslations("metadata");
  metadata("title");
  // @ts-expect-error Unknown catalog keys must fail type-check.
  metadata("missing");
}
