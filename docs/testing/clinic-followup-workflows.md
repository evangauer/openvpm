# Charge catalog and prescription stock follow-up

The September 14 release fixed decimal prescription storage but did not establish end-to-end coverage for large charge catalogs or low-stock inventory-linked forms.

## Changes

- Charge capture searches all products on the server, with 50-item pages and explicit load-more, loading, and retry controls. Selection survives search reset.
- Inventory-linked prescriptions fetch the selected product's current stock and explain blocked quantities and untracked inventory next to the quantity field. Inventory review opens separately so the prescription draft is retained; Refresh stock updates the form after a reviewed correction.
- Opening quantities and stock adjustments support three decimals. Reorder points remain integers. Dispensing still cannot overdraw recorded inventory.

This does not establish a customer's physical stock or convert bottles into mL. Stock quantities and prices must be reviewed in the same dispensing unit. Do not invent stock or disable stock guards to make a prescription save.

## Local acceptance

Seed a disposable localhost database named `openvpm_jayne_*`; use matching DATABASE_URL for the app and JAYNE_GAPS_E2E_DATABASE_URL for the test runner. The suite rejects remote databases. Start the app with the local database and NEXTAUTH_URL/NEXT_PUBLIC_APP_URL matching the local server.

```sh
JAYNE_GAPS_E2E=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55439/openvpm_jayne_followup \
JAYNE_GAPS_E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/openvpm_jayne_followup \
PLAYWRIGHT_BASE_URL=http://localhost:3509 pnpm exec playwright test --config playwright.jayne-followup.config.ts
```

The suite uses desktop Chromium and iPhone WebKit. It tests browsing beyond 100, searching product 826, no matches, retained selection, persisted fractional charges, low/zero stock, fractional adjustment and dispensing, untracked opening balances, stale responses, keyboard selection, and network failure/retry. Data assertions follow actual UI writes. Synthetic setup alone uses SQL.

## Release verification

No new migration is required; migration 0105 already provides decimal stock storage. Verify the release SHA and run authenticated workflows in a designated synthetic practice on the deployed release. Record staging and production evidence separately. Do not describe login/schema/log-only checks as production workflow tests.

## Verified September 22

- TypeScript passed; optimized preview build passed.
- Web tests: 4,441 passed initially, with two resource-load timeouts; the two affected files then passed all 52 tests in an isolated single-worker rerun. 22 existing skips remain.
- Follow-up local browser checks: six workflow cases plus two failure/retry cases passed across desktop Chromium and iPhone WebKit.
- Hosted preview `openvpm-of5krb418-evangauers-projects.vercel.app`: all six authenticated workflow cases passed against a newly provisioned synthetic staging clinic. API reads confirmed invoice quantity 1.5, subtotal 2.99, tax 0.24, total 3.23, and exact stock balances after 1.5 and 0.125 prescriptions.
- Production verification is not implied by the staging result; record it separately after release.

`playwright.jayne-hosted.config.ts` runs `e2e/jayne-hosted-followup.spec.ts` against an explicitly supplied synthetic fixture (JAYNE_HOSTED_E2E=1, JAYNE_HOSTED_FIXTURE, PLAYWRIGHT_BASE_URL). Credentials belong in a private temporary fixture, never in source control. The test verifies random synthetic patient identity before writes. Provision distinct tracked and untracked products per browser project, with 1 and 0 opening units respectively, plus 826 catalog entries. JAYNE_PREVIEW_ACCESS_URL can supply temporary deployment-protection access for a preview.
