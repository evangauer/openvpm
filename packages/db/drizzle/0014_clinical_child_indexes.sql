CREATE INDEX "case_entries_case_idx" ON "case_entries" USING btree ("case_id","deleted_at");--> statement-breakpoint
CREATE INDEX "treatment_plan_items_plan_order_idx" ON "treatment_plan_items" USING btree ("plan_id","deleted_at","sort_order");
