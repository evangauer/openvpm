CREATE TYPE "public"."clinical_correction_record_type" AS ENUM('soap_note', 'vital_sign');--> statement-breakpoint
CREATE TYPE "public"."clinical_correction_action" AS ENUM('entered_in_error');--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT s.practice_id, s.patient_id, s.appointment_id
			FROM soap_notes s
			UNION ALL
			SELECT v.practice_id, v.patient_id, v.appointment_id
			FROM vital_signs v
		) source
		LEFT JOIN patients p
			ON p.practice_id = source.practice_id
			AND p.id = source.patient_id
		LEFT JOIN appointments a
			ON a.practice_id = source.practice_id
			AND a.id = source.appointment_id
		WHERE p.id IS NULL
			OR (source.appointment_id IS NOT NULL AND a.id IS NULL)
			OR (source.appointment_id IS NOT NULL AND a.patient_id IS DISTINCT FROM source.patient_id)
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'Cannot install clinical corrections: a SOAP note or vital sign targets a patient or appointment outside its practice, or an appointment belonging to a different patient.',
			HINT = 'Reconcile cross-practice and appointment-patient clinical record links before retrying migration 0047.';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_practice_id_uq" ON "patients" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_practice_id_uq" ON "users" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "soap_notes_practice_record_uq" ON "soap_notes" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vital_signs_practice_record_uq" ON "vital_signs" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_practice_patient_id_uq" ON "appointments" USING btree ("practice_id","id","patient_id");--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_practice_appointment_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_practice_appointment_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "clinical_record_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"record_type" "clinical_correction_record_type" NOT NULL,
	"action" "clinical_correction_action" DEFAULT 'entered_in_error' NOT NULL,
	"soap_note_id" uuid,
	"vital_sign_id" uuid,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"reason" varchar(1000) NOT NULL,
	"corrected_by" uuid NOT NULL,
	"corrected_by_name" varchar(255) NOT NULL,
	CONSTRAINT "clinical_record_corrections_source_type_check" CHECK ((
		"clinical_record_corrections"."record_type" = 'soap_note'
		and "clinical_record_corrections"."soap_note_id" is not null
		and "clinical_record_corrections"."vital_sign_id" is null
	) or (
		"clinical_record_corrections"."record_type" = 'vital_sign'
		and "clinical_record_corrections"."vital_sign_id" is not null
		and "clinical_record_corrections"."soap_note_id" is null
	)),
	CONSTRAINT "clinical_record_corrections_reason_length_check" CHECK (length(btrim("clinical_record_corrections"."reason")) between 5 and 1000),
	CONSTRAINT "clinical_record_corrections_actor_name_check" CHECK (length(btrim("clinical_record_corrections"."corrected_by_name")) between 1 and 255)
);--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_soap_note_id_soap_notes_id_fk" FOREIGN KEY ("soap_note_id") REFERENCES "public"."soap_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_vital_sign_id_vital_signs_id_fk" FOREIGN KEY ("vital_sign_id") REFERENCES "public"."vital_signs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_practice_appointment_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_practice_actor_fk" FOREIGN KEY ("practice_id","corrected_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_soap_source_fk" FOREIGN KEY ("practice_id","soap_note_id") REFERENCES "public"."soap_notes"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_vital_source_fk" FOREIGN KEY ("practice_id","vital_sign_id") REFERENCES "public"."vital_signs"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_record_corrections_practice_patient_history_idx" ON "clinical_record_corrections" USING btree ("practice_id","patient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "clinical_record_corrections_practice_appointment_history_idx" ON "clinical_record_corrections" USING btree ("practice_id","appointment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "clinical_record_corrections_practice_type_history_idx" ON "clinical_record_corrections" USING btree ("practice_id","record_type","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_soap_note_uq" ON "clinical_record_corrections" USING btree ("practice_id","soap_note_id") WHERE "clinical_record_corrections"."soap_note_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_vital_sign_uq" ON "clinical_record_corrections" USING btree ("practice_id","vital_sign_id") WHERE "clinical_record_corrections"."vital_sign_id" is not null;--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_clinical_record_correction_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	source_matches boolean := false;
BEGIN
	IF NEW.record_type = 'soap_note' THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.soap_notes source
			WHERE source.practice_id = NEW.practice_id
				AND source.id = NEW.soap_note_id
				AND source.patient_id = NEW.patient_id
				AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
		) INTO source_matches;
	ELSIF NEW.record_type = 'vital_sign' THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.vital_signs source
			WHERE source.practice_id = NEW.practice_id
				AND source.id = NEW.vital_sign_id
				AND source.patient_id = NEW.patient_id
				AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
		) INTO source_matches;
	END IF;

	IF NOT source_matches THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'Clinical correction source does not match its patient and appointment.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clinical_record_corrections_validate_source
BEFORE INSERT ON "clinical_record_corrections"
FOR EACH ROW EXECUTE FUNCTION validate_clinical_record_correction_source();--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_clinical_record_correction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Clinical correction events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER clinical_record_corrections_immutable
BEFORE UPDATE OR DELETE ON "clinical_record_corrections"
FOR EACH ROW EXECUTE FUNCTION prevent_clinical_record_correction_mutation();--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "clinical_record_corrections"
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		or "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid
	)
	WITH CHECK (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		or "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid
	);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE UPDATE, DELETE ON clinical_record_corrections FROM openpims_app;
	END IF;
END $$;
