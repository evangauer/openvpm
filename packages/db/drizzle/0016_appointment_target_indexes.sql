CREATE INDEX "appointments_client_status_idx" ON "appointments" USING btree ("practice_id","client_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "appointments_patient_status_idx" ON "appointments" USING btree ("practice_id","patient_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "appointments_doctor_status_idx" ON "appointments" USING btree ("practice_id","doctor_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "appointments_type_status_idx" ON "appointments" USING btree ("practice_id","type_id","status","deleted_at");--> statement-breakpoint
CREATE INDEX "appointments_room_status_idx" ON "appointments" USING btree ("practice_id","room_id","status","deleted_at");