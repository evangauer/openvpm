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
