ALTER TABLE "clinical_record_corrections" DROP CONSTRAINT "clinical_record_corrections_source_type_check";--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" DROP CONSTRAINT "clinical_record_corrections_operation_shape_check";--> statement-breakpoint
ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old";--> statement-breakpoint
CREATE TYPE "public"."clinical_correction_record_type" AS ENUM('soap_note', 'vital_sign', 'vaccination_record', 'lab_result', 'patient_allergy');--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ALTER COLUMN "record_type" TYPE "public"."clinical_correction_record_type" USING "record_type"::text::"public"."clinical_correction_record_type";--> statement-breakpoint
DROP TYPE "public"."clinical_correction_record_type_old";--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD COLUMN "patient_allergy_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_patient_allergy_id_patient_allergies_id_fk" FOREIGN KEY ("patient_allergy_id") REFERENCES "public"."patient_allergies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_allergies_id_patient_uq" ON "patient_allergies" USING btree ("id","patient_id");--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_patient_allergy_source_fk" FOREIGN KEY ("patient_allergy_id","patient_id") REFERENCES "public"."patient_allergies"("id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_patient_allergy_uq" ON "clinical_record_corrections" USING btree ("practice_id","patient_allergy_id") WHERE "patient_allergy_id" is not null;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_source_type_check" CHECK ((
	"record_type" = 'soap_note'
	and "soap_note_id" is not null
	and "vital_sign_id" is null
	and "vaccination_record_id" is null
	and "lab_result_id" is null
	and "patient_allergy_id" is null
) or (
	"record_type" = 'vital_sign'
	and "vital_sign_id" is not null
	and "soap_note_id" is null
	and "vaccination_record_id" is null
	and "lab_result_id" is null
	and "patient_allergy_id" is null
) or (
	"record_type" = 'vaccination_record'
	and "vaccination_record_id" is not null
	and "soap_note_id" is null
	and "vital_sign_id" is null
	and "lab_result_id" is null
	and "patient_allergy_id" is null
) or (
	"record_type" = 'lab_result'
	and "lab_result_id" is not null
	and "soap_note_id" is null
	and "vital_sign_id" is null
	and "vaccination_record_id" is null
	and "patient_allergy_id" is null
) or (
	"record_type" = 'patient_allergy'
	and "patient_allergy_id" is not null
	and "soap_note_id" is null
	and "vital_sign_id" is null
	and "vaccination_record_id" is null
	and "lab_result_id" is null
	and "appointment_id" is null
));--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_operation_shape_check" CHECK ((
	"record_type" = 'lab_result'
	and "operation_id" is not null
	and "operation_payload_hash" ~ '^[0-9a-f]{64}$'
) or (
	"record_type" <> 'lab_result'
	and "operation_id" is null
	and "operation_payload_hash" is null
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
			SELECT 1 FROM public.soap_notes source
			WHERE source.practice_id = NEW.practice_id
				AND source.id = NEW.soap_note_id
				AND source.patient_id = NEW.patient_id
				AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
				AND source.status = 'finalized'
		) INTO source_matches;
	ELSIF NEW.record_type = 'vital_sign' THEN
		SELECT EXISTS (SELECT 1 FROM public.vital_signs source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.vital_sign_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'vaccination_record' THEN
		SELECT EXISTS (SELECT 1 FROM public.vaccination_records source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.vaccination_record_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'lab_result' THEN
		SELECT EXISTS (SELECT 1 FROM public.lab_results source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.lab_result_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'patient_allergy' THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.patient_allergies source
			JOIN public.patients patient ON patient.id = source.patient_id
			WHERE source.id = NEW.patient_allergy_id
				AND source.patient_id = NEW.patient_id
				AND patient.practice_id = NEW.practice_id
				AND NEW.appointment_id IS NULL
		) INTO source_matches;
	END IF;
	IF NOT source_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Clinical correction source does not match its patient and appointment, or is not final.';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
