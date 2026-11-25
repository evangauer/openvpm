SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "scribe_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"appointment_id" uuid,
	"recording_key" uuid NOT NULL,
	"source" varchar(16) NOT NULL,
	"device_key_hash" varchar(64),
	"audio_seconds" integer DEFAULT 0 NOT NULL,
	"metered_runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "scribe_recordings_source_check" CHECK ("scribe_recordings"."source" in ('browser', 'phone')),
	CONSTRAINT "scribe_recordings_counts_check" CHECK ("scribe_recordings"."audio_seconds" >= 0 and "scribe_recordings"."metered_runs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "scribe_transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"client_key" uuid NOT NULL,
	"source" varchar(16) NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "scribe_transcript_segments_source_check" CHECK ("scribe_transcript_segments"."source" in ('browser', 'phone')),
	CONSTRAINT "scribe_transcript_segments_text_length_check" CHECK (length("scribe_transcript_segments"."text") <= 8000)
);
--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD COLUMN "purpose" varchar(16) DEFAULT 'photos' NOT NULL;--> statement-breakpoint
ALTER TABLE "scribe_recordings" ADD CONSTRAINT "scribe_recordings_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_recordings" ADD CONSTRAINT "scribe_recordings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_recordings" ADD CONSTRAINT "scribe_recordings_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_recordings" ADD CONSTRAINT "scribe_recordings_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id") REFERENCES "public"."appointments"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_recordings" ADD CONSTRAINT "scribe_recordings_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_transcript_segments" ADD CONSTRAINT "scribe_transcript_segments_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_transcript_segments" ADD CONSTRAINT "scribe_transcript_segments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_transcript_segments" ADD CONSTRAINT "scribe_transcript_segments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_transcript_segments" ADD CONSTRAINT "scribe_transcript_segments_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id") REFERENCES "public"."appointments"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scribe_transcript_segments" ADD CONSTRAINT "scribe_transcript_segments_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scribe_recordings_recording_key_uq" ON "scribe_recordings" USING btree ("practice_id","recording_key");--> statement-breakpoint
CREATE INDEX "capture_sessions_scribe_visit_idx" ON "capture_sessions" USING btree ("practice_id","appointment_id") WHERE "capture_sessions"."purpose" = 'scribe' and "capture_sessions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "scribe_recordings_visit_idx" ON "scribe_recordings" USING btree ("practice_id","appointment_id","updated_at");--> statement-breakpoint
CREATE INDEX "scribe_recordings_created_idx" ON "scribe_recordings" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scribe_transcript_segments_client_key_uq" ON "scribe_transcript_segments" USING btree ("practice_id","appointment_id","client_key");--> statement-breakpoint
CREATE INDEX "scribe_transcript_segments_visit_idx" ON "scribe_transcript_segments" USING btree ("practice_id","appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "scribe_transcript_segments_created_idx" ON "scribe_transcript_segments" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_purpose_check" CHECK ("capture_sessions"."purpose" in ('photos', 'scribe')) NOT VALID;--> statement-breakpoint
ALTER TABLE "capture_sessions" VALIDATE CONSTRAINT "capture_sessions_purpose_check";
--> statement-breakpoint
ALTER TABLE scribe_transcript_segments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON scribe_transcript_segments
USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid)
WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE scribe_recordings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON scribe_recordings
USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid)
WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid);
