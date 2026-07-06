CREATE INDEX "wellness_plans_practice_created_idx" ON "wellness_plans" USING btree ("practice_id","deleted_at","created_at");
