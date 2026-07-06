DROP INDEX "invoices_practice_idx";--> statement-breakpoint
CREATE INDEX "invoices_practice_idx" ON "invoices" USING btree ("practice_id","deleted_at","created_at");