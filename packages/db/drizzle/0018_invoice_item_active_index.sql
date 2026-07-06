DROP INDEX "invoice_items_item_idx";--> statement-breakpoint
CREATE INDEX "invoice_items_item_idx" ON "invoice_items" USING btree ("item_type","deleted_at","item_id");