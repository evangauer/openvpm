# Clinic workflow regression and release checks

Baseline: production `app.openvpm.com` was verified against `main` commit
`a6e65362b73779a121d3fa773b2184fc4ae164ea` on September 14, 2026.

## Reported gaps and fixes

| Report | Reproduction / cause | Change |
| --- | --- | --- |
| Fractional medication quantities fail | Prescription form policy, API validation, and persisted quantities required integers. | Support quantities from 0.001 with up to three decimals in prescription forms, refill events, dispensing, stock, and invoice lines. Refill counts remain integers. |
| Cannot mark up medication cost | Inventory exposed cost and selling price without a percentage workflow. | Enter markup on per-unit cost, apply the resulting selling price, then save the product. Existing invoices and dispense snapshots retain their original prices. |
| Cannot delete appointments | Schedule offered cancellation but no removal action. | Delete an unstarted mistaken booking with a reason. This soft-deletes it and cancels reminders; clinical and financial evidence prevents deletion. |
| Cannot select void or no-charge | Actions were disabled until a separate reason input had three characters. | Select the action first, enter the labeled reason, then confirm. Role checks and audit requirements remain enforced. |
| Changing captured quantity reports a tax error | Fractional-cent line totals failed integer-cent validation, replacing the editor. Browser testing also reproduced timestamp precision conflicts on otherwise valid edits. | Round each line once before tax, keep invalid inputs editable, and preserve the database timestamp precision in the invoice compare-and-swap. |

## Database rollout

Apply `0105_fractional_medication_quantities.sql` before deploying the new code.
It changes five quantity columns to `numeric(13,3)` and recreates the dependent
`invoice_items_validate_dispense_charge` trigger within the migration transaction.
The existing integer values remain representable. Deploy using the repository's
normal migration runner; do not run its statements individually outside a
transaction. The migration requires table locks, so schedule it appropriately.

The migration is additive in supported values, but a code rollback after users
record fractional prescriptions would restore integer-only validation. Retain
the numeric columns and fix forward; do not convert quantities back to integers.

## Automated acceptance

The browser suite requires a disposable localhost database named
`openvpm_jayne_*`, seeded by `packages/db/seed.ts`. It creates uniquely identified
synthetic patients, medication, prescriptions, and appointments. It never uses a
customer record as its fixture.

Run the application with `DATABASE_URL` pointing to that database,
`AMBULATORY_WORKSPACE_ENABLED=true`, `HOSTED_BILLING_ENABLED=false`, and
`NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL` matching the local server. Then run:

```sh
JAYNE_GAPS_E2E=1 \
DATABASE_URL=postgresql://postgres@127.0.0.1:55439/openvpm_jayne_gaps \
JAYNE_GAPS_E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/openvpm_jayne_gaps \
PLAYWRIGHT_BASE_URL=http://localhost:3509 \
pnpm exec playwright test --config playwright.jayne.config.ts
```

The report is written to `outputs/jayne-gaps/playwright-report`.

## Deployed acceptance checklist

Use a designated synthetic clinic with clinician and admin test access.
Do not run the database-fixture browser suite against production.

1. Verify deployment commit and migration 0105 are present.
2. Prescribe 1.5 units and 0.125 units, reload, and verify retained quantities.
3. Dispense 1.5 from 10 units of stock, then refill: expect 8.5 and 7 units.
4. Apply 50% markup to a 1.99 per-unit cost: selling price should be 2.99.
   Save and reload; confirm previously invoiced prices remain unchanged.
5. Delete a duplicate scheduled booking with a reason. Confirm it disappears,
   cannot receive reminders, and is auditable. Confirm visits with clinical or
   financial evidence cannot be removed.
6. Select No charge and Void/corrected before entering a reason. Enter and
   confirm each reason; reload and verify the recorded resolution.
7. Edit a draft invoice line priced at 1.99 to quantity 1.5. Expect line/subtotal
   2.99, tax 0.24 at 8%, and total 3.23. Invalid quantity input should leave the
   editor usable. Saving and reloading should retain the corrected quantity.
8. In a second tab, attempt to save an outdated invoice revision: expect a
   conflict, with the newer saved charges preserved.
9. Verify viewers cannot prescribe, reconcile, edit inventory, or delete
   appointments; only authorized billing roles can modify invoice charges.

## Verified locally (September 14, 2026)

- Full web suite: 4,429 passed; 22 existing skips.
- Browser acceptance: all five workflows passed on desktop and mobile (10 tests).
- TypeScript check and optimized Next.js production build passed.
- Fresh PostgreSQL migration history, including 0105, applied successfully.
- A deliberately mismatched dispense invoice quantity was rejected by the
  restored trigger; 1.5-unit dispensing and refilling retained exact quantities.
- Public-release content check passed.

These are local results against synthetic data. Deployed acceptance remains
pending; the production baseline has not been changed by this work.
