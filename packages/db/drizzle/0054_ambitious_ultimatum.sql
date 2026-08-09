ALTER TABLE "clinical_record_corrections" DROP CONSTRAINT "clinical_record_corrections_source_type_check";--> statement-breakpoint
ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old";--> statement-breakpoint
CREATE TYPE "public"."clinical_correction_record_type" AS ENUM('soap_note', 'vital_sign', 'vaccination_record');--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ALTER COLUMN "record_type" TYPE "public"."clinical_correction_record_type" USING "record_type"::text::"public"."clinical_correction_record_type";--> statement-breakpoint
DROP TYPE "public"."clinical_correction_record_type_old";--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD COLUMN "vaccination_record_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "vaccination_records_practice_record_uq" ON "vaccination_records" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_vaccination_record_id_vaccination_records_id_fk" FOREIGN KEY ("vaccination_record_id") REFERENCES "public"."vaccination_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_vaccination_source_fk" FOREIGN KEY ("practice_id","vaccination_record_id") REFERENCES "public"."vaccination_records"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_vaccination_record_uq" ON "clinical_record_corrections" USING btree ("practice_id","vaccination_record_id") WHERE "clinical_record_corrections"."vaccination_record_id" is not null;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_source_type_check" CHECK ((
        "clinical_record_corrections"."record_type" = 'soap_note'
        and "clinical_record_corrections"."soap_note_id" is not null
        and "clinical_record_corrections"."vital_sign_id" is null
        and "clinical_record_corrections"."vaccination_record_id" is null
      ) or (
        "clinical_record_corrections"."record_type" = 'vital_sign'
        and "clinical_record_corrections"."vital_sign_id" is not null
        and "clinical_record_corrections"."soap_note_id" is null
        and "clinical_record_corrections"."vaccination_record_id" is null
      ) or (
        "clinical_record_corrections"."record_type" = 'vaccination_record'
        and "clinical_record_corrections"."vaccination_record_id" is not null
        and "clinical_record_corrections"."soap_note_id" is null
        and "clinical_record_corrections"."vital_sign_id" is null
      ));--> statement-breakpoint
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
	ELSIF NEW.record_type = 'vaccination_record' THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.vaccination_records source
			WHERE source.practice_id = NEW.practice_id
				AND source.id = NEW.vaccination_record_id
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
$$;
