CREATE INDEX "vital_signs_appointment_idx" ON "vital_signs" USING btree ("practice_id","appointment_id","deleted_at","recorded_at");
