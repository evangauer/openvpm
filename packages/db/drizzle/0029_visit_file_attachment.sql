ALTER TABLE "capture_sessions" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_appointment_idx" ON "files" USING btree ("appointment_id");