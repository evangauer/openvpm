CREATE INDEX "appointment_types_practice_name_idx" ON "appointment_types" USING btree ("practice_id","deleted_at","name");--> statement-breakpoint
CREATE INDEX "rooms_practice_name_idx" ON "rooms" USING btree ("practice_id","deleted_at","name");--> statement-breakpoint
CREATE INDEX "rooms_location_idx" ON "rooms" USING btree ("practice_id","location_id","deleted_at");--> statement-breakpoint
CREATE INDEX "staff_schedules_location_idx" ON "staff_schedules" USING btree ("practice_id","location_id","deleted_at");--> statement-breakpoint
CREATE INDEX "staff_schedules_user_idx" ON "staff_schedules" USING btree ("practice_id","user_id","deleted_at");
