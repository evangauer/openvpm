CREATE INDEX "services_practice_name_idx" ON "services" USING btree ("practice_id","deleted_at","name");--> statement-breakpoint
CREATE INDEX "suppliers_practice_name_idx" ON "suppliers" USING btree ("practice_id","deleted_at","name");
