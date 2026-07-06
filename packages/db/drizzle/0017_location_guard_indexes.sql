DROP INDEX "users_location_idx";--> statement-breakpoint
DROP INDEX "products_location_idx";--> statement-breakpoint
CREATE INDEX "users_location_idx" ON "users" USING btree ("practice_id","location_id","deleted_at");--> statement-breakpoint
CREATE INDEX "products_location_idx" ON "products" USING btree ("practice_id","location_id","deleted_at");