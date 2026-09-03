SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TYPE "public"."appointment_origin" AS ENUM('scheduled', 'field');--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'bovine' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'ovine' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'caprine' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'porcine' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'poultry' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."species" ADD VALUE 'camelid' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "recent_clinical_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "origin" "appointment_origin" DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "body_condition_scale" integer DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_patient_tenant_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ADD CONSTRAINT "recent_clinical_items_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recent_clinical_items_user_patient_uq" ON "recent_clinical_items" USING btree ("practice_id","user_id","patient_id");--> statement-breakpoint
CREATE INDEX "recent_clinical_items_user_viewed_idx" ON "recent_clinical_items" USING btree ("practice_id","user_id","viewed_at");--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_body_condition_scale_check" CHECK ("vital_signs"."body_condition_scale" in (5, 9)) NOT VALID;--> statement-breakpoint
ALTER TABLE "vital_signs" VALIDATE CONSTRAINT "vital_signs_body_condition_scale_check";--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_body_condition_score_check" CHECK ("vital_signs"."body_condition_score" is null or ("vital_signs"."body_condition_score" >= 1 and "vital_signs"."body_condition_score" <= "vital_signs"."body_condition_scale")) NOT VALID;--> statement-breakpoint
ALTER TABLE "vital_signs" VALIDATE CONSTRAINT "vital_signs_body_condition_score_check";--> statement-breakpoint
ALTER TABLE "recent_clinical_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "recent_clinical_items"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON recent_clinical_items FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON recent_clinical_items TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON recent_clinical_items FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON recent_clinical_items FROM authenticated; END IF;
END $$;
