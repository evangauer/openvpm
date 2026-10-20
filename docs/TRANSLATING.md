# Translating OpenVPM

The UI is **English-only until the message-catalog PR lands**. There is no
language switch, runtime i18n library, or UI message catalog yet. Most UI copy
is hardcoded English; `apps/web/app/portal/messages` is a messaging feature,
not a translation directory. The document language is currently `en`.

[I18N.md](I18N.md) defines the architecture and boundaries. Its PR 4 is a
message-catalog proof of concept, not an already merged catalog. Discuss that
approach with maintainers before adding a library or extracting UI strings.
Full UI translations can begin once that foundation lands.

## Join a language effort

| Language | BCP-47 tag | Coordination |
| --- | --- | --- |
| Spanish (Latin America) | `es-419` | [Issue #346](https://github.com/evangauer/openvpm/issues/346) |
| Italian | `it` | [Discussion #34](https://github.com/evangauer/openvpm/discussions/34) |

Use `es-419`, not `es-LA`. A UI language tag is separate from a country and
its formatting locale: for example, `es-MX`, `es-VE`, and `it-IT`. Language
does not automatically enable a country for clinic signup or payments.

## Help now: terminology glossaries

A docs-only glossary is a useful first contribution while catalogs are pending.
Coordinate in [glossary issue #351](https://github.com/evangauer/openvpm/issues/351)
and the language thread above, then cover one workflow in a small PR.

Create these contribution paths as needed; they do not exist as UI catalogs:

- `docs/i18n/es-419/glossary.md` for Latin American Spanish.
- `docs/i18n/it/glossary.md` for Italian.
- `docs/i18n/README.md` as an index of language folders, BCP-47 tags, and
  contributor or maintainer contacts. Use an agreed public GitHub handle or
  language thread; do not publish someone else's contact details.

Use a table like this, filling the translation and notes columns:

| English term | Translation | Notes / regional variants |
| --- | --- | --- |
| Patient | | |
| Client / animal owner | | |
| Appointment | | |
| SOAP note | | |
| Invoice | | |
| Vaccine certificate | | |
| Controlled drug | | |

Keep the English term as the baseline. Explain clinical meaning and regional
variants instead of translating word for word. A glossary needs normal review;
it does not need the country-launch approval required for a new clinic region.

## Formatting changes are region contributions

The existing implementation is in `apps/web/lib/locale/`:

- `format.ts`: `COUNTRY_LOCALE`, `localeForCountry`, `formatCurrency`,
  `formatDate`, and `regionDefaults`.
- `clinic-regions.ts`: `CLINIC_REGION_CODES` and `CLINIC_REGION_OPTIONS`, the
  countries selectable at signup and in settings. Current choices are US,
  CA, GB, IE, and AU.
- `useCurrency.ts`: the currency formatter bound to a practice.
- `__tests__/format.test.ts` and `__tests__/clinic-regions.test.ts`: checks for
  formatting and selectable regions.

Unknown countries currently fall back to `en-US` formatting and the US
defaults (USD, 8% default tax, `America/New_York`). Those application defaults
are not tax or legal advice. Adding an unused `COUNTRY_LOCALE` entry alone
does not make a country available to clinics.

**Get maintainer sign-off in the issue before coding a new region.** A region
addition opens hosted signup for that country. Coordinate Latin American
Spanish region work in [#349](https://github.com/evangauer/openvpm/issues/349)
and Italy in [#350](https://github.com/evangauer/openvpm/issues/350).
[Japan PR #343](https://github.com/evangauer/openvpm/pull/343) is a useful file
inventory, not approval to enable other countries. A region PR should cover:

1. `apps/web/lib/locale/format.ts`: formatting locale and `regionDefaults`
   (currency, timezone, and default tax rate with a cited authoritative source).
2. `apps/web/lib/locale/clinic-regions.ts`: selectable codes and labels.
3. Timezone choices in `apps/web/app/(dashboard)/settings/page.tsx` and
   `apps/web/components/onboarding/steps/practice-basics.tsx`; add the settings
   `CURRENCIES` entry if needed.
4. The `country` enum in `apps/web/app/api-docs/page.tsx`.
5. Formatting and region tests in `apps/web/lib/locale/__tests__/`.

Check the currency's Stripe minor-unit rules with a maintainer. Existing payment
code assumes two decimal places; zero-decimal currencies such as JPY, CLP, PYG,
and KRW require payment handling to be resolved before clinics can take card
payments in those currencies. Flag this in the issue rather than enabling
payments as part of a translation PR.

## Writing formatting tests

Use the Node version CI specifies in `.github/workflows/ci.yml` (currently
Node.js 24). ICU versions can change formatting and whitespace, so verify
exact output on that runtime. Choose values that demonstrate grouping.

For a future Italian region mapping, `Intl` on Node 24.21.0 / ICU 78.3 gives:

```ts
new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" })
  .format(12345.5); // "12.345,50\u00a0€"
```

The separator before `€` is a non-breaking space. `1234.5` formats as
`"1234,50\u00a0€"`, so it does not exercise grouping. With the Italian mapping
added, `formatDate("2026-03-05", "IT")` should produce `"05/03/2026"`.
The current unknown-country fallback is not Italian formatting.

Do not assume all Spanish locales format numbers alike: `es-MX` and `es-VE`
use different decimal and grouping conventions. Test the exact locale added.

## Workflow and checks

1. Claim the relevant issue or coordinate in the language thread. Wait for
   maintainer approval before a region addition or catalog proof of concept.
2. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for setup. Branch from `main`
   and target `main`, matching the updated PR template.
3. Keep each PR to one glossary, one region, one route, or one message
   namespace. Link its issue and include reproducible verification.
4. Run the checks appropriate to the change:

   ```bash
   pnpm --filter @openpims/web exec vitest run lib/locale
   pnpm type-check
   pnpm test
   pnpm build
   ```

For docs-only changes, check relative paths, anchors, and external links.
Code changes must preserve English behavior and its fallback. Do not add
tax, legal, prescription, or reporting rules to translation files. Justify
new dependencies; schema changes belong only in a scoped locale-settings PR.

First-time fork workflows may need maintainer approval to run. App previews
are currently quarantined under [repository governance](repository-governance.md#preview-and-non-production-credential-isolation);
a missing preview is not evidence that code checks passed. Report the actual
check results and ask a maintainer about an unavailable required check.
