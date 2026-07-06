DROP INDEX "invoices_client_idx";--> statement-breakpoint
CREATE INDEX "invoices_patient_idx" ON "invoices" USING btree ("practice_id","patient_id","client_id","deleted_at");--> statement-breakpoint
CREATE INDEX "invoices_client_idx" ON "invoices" USING btree ("practice_id","client_id","deleted_at","created_at");