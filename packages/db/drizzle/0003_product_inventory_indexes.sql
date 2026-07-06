CREATE INDEX "products_practice_name_idx" ON "products" USING btree ("practice_id","deleted_at","name");--> statement-breakpoint
CREATE INDEX "products_stock_alert_idx" ON "products" USING btree ("practice_id","deleted_at","stock_quantity");
