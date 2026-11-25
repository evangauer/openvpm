# Contributing translations

English is the source language and the fallback. A missing translation renders
the English string. Translation files hold user-facing text only. Do not put
tax, legal, prescription, or reporting rules in them.

UI language is separate from formatting locale, country, and currency. Do not
change `apps/web/lib/locale/format.ts`, `COUNTRY_LOCALE`, or clinic region
codes to translate a screen.

## Claim a namespace

1. Claim a namespace on the language issue, for example
   [#346](https://github.com/evangauer/openvpm/issues/346) for Spanish
   (Latin America).
2. Edit only `apps/web/messages/<lang>.json`. Add keys that already exist in
   `apps/web/messages/en.json`. Supported files today are `en.json`,
   `es-419.json`, and `it.json`.
3. Run the checks:

   ```bash
   pnpm --filter @openpims/web i18n:check
   pnpm test
   ```

   `i18n:check` fails when a translation uses a key that English does not have,
   when a placeholder name does not match English, or when the ICU message does
   not parse. It prints how much of each language is still untranslated, and
   that report does not fail the check.
4. Preview the change with the language switcher on the sign-in screen, or set
   the `NEXT_LOCALE` cookie to `en`, `es-419`, or `it` and reload.
5. Open a pull request that links the language issue. Say whether the strings
   are a native review or a draft that still needs one.

`es-419.json` and `it.json` in the catalog proof of concept are machine drafts
for the migrated screens. Native speakers should replace them.

## Add UI copy

1. Add the key to `apps/web/messages/en.json` first. Keys are semantic
   (`auth.signIn.submit`), grouped by surface. Do not use an English sentence
   as the key.
2. Read it with `useTranslations` in a Client Component or `getTranslations` in
   a Server Component.
3. Leave the other language files alone when you do not have a translation.
   The missing key falls back to English.
4. Hardcoded English on a screen that already uses the catalog is rejected in
   review.

Migrated surfaces today are document metadata, practice sign-in, and the
not-found and error screens. Registration, the hosted demo sign-in, billing,
and checkout are not in the catalog yet.

## Glossary

Propose terminology in `docs/i18n/<lang>/glossary.md`. That path is a proposal.
Confirm it with a maintainer before treating it as the canonical glossary.
Keep regulatory notes out of the glossary. Link the language issue when you
add terms.
