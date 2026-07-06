CREATE INDEX "api_keys_practice_created_idx" ON "api_keys" USING btree ("practice_id","deleted_at","created_at");
