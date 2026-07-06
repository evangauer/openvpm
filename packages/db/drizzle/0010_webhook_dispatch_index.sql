CREATE INDEX "webhooks_practice_active_idx" ON "webhooks" USING btree ("practice_id","deleted_at","active");
