-- Preserve the historical behavior (all invoice lines were taxed) while
-- making future catalog tax treatment explicit and snapshotting it on each
-- invoice line. The staged backfill is safe for databases that already have
-- products and invoices.
ALTER TABLE "products" ADD COLUMN "taxable" boolean;
UPDATE "products" SET "taxable" = true WHERE "taxable" IS NULL;
ALTER TABLE "products" ALTER COLUMN "taxable" SET DEFAULT true;
ALTER TABLE "products" ALTER COLUMN "taxable" SET NOT NULL;

ALTER TABLE "invoice_items" ADD COLUMN "taxable" boolean;
UPDATE "invoice_items" SET "taxable" = true WHERE "taxable" IS NULL;
ALTER TABLE "invoice_items" ALTER COLUMN "taxable" SET DEFAULT true;
ALTER TABLE "invoice_items" ALTER COLUMN "taxable" SET NOT NULL;
