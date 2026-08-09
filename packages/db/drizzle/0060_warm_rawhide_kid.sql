ALTER TABLE "clinical_record_corrections" DROP CONSTRAINT "clinical_record_corrections_source_type_check";--> statement-breakpoint
ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old";--> statement-breakpoint
CREATE TYPE "public"."clinical_correction_record_type" AS ENUM('soap_note', 'vital_sign', 'vaccination_record', 'lab_result');--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ALTER COLUMN "record_type" TYPE "public"."clinical_correction_record_type" USING "record_type"::text::"public"."clinical_correction_record_type";--> statement-breakpoint
DROP TYPE "public"."clinical_correction_record_type_old";--> statement-breakpoint
CREATE TABLE "lab_result_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"correction_id" uuid NOT NULL,
	"source_lab_result_id" uuid NOT NULL,
	"replacement_lab_result_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_name" varchar(255) NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	CONSTRAINT "lab_result_replacements_shape_check" CHECK (
		"source_lab_result_id" <> "replacement_lab_result_id"
		and length(btrim("actor_name")) between 1 and 255
		and "operation_payload_hash" ~ '^[0-9a-f]{64}$'
	)
);--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD COLUMN "lab_result_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD COLUMN "operation_payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_lab_result_id_lab_results_id_fk" FOREIGN KEY ("lab_result_id") REFERENCES "public"."lab_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_lab_result_source_fk" FOREIGN KEY ("practice_id","lab_result_id") REFERENCES "public"."lab_results"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_lab_result_uq" ON "clinical_record_corrections" USING btree ("practice_id","lab_result_id") WHERE "lab_result_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_operation_uq" ON "clinical_record_corrections" USING btree ("practice_id","operation_id") WHERE "operation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_practice_record_lab_source_uq" ON "clinical_record_corrections" USING btree ("practice_id","id","lab_result_id");--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_operation_shape_check" CHECK ((
	"record_type" = 'lab_result'
	and "operation_id" is not null
	and "operation_payload_hash" ~ '^[0-9a-f]{64}$'
) or (
	"record_type" <> 'lab_result'
	and "operation_id" is null
	and "operation_payload_hash" is null
));--> statement-breakpoint
ALTER TABLE "clinical_record_corrections" ADD CONSTRAINT "clinical_record_corrections_source_type_check" CHECK ((
	"record_type" = 'soap_note' and "soap_note_id" is not null and "vital_sign_id" is null and "vaccination_record_id" is null and "lab_result_id" is null
) or (
	"record_type" = 'vital_sign' and "vital_sign_id" is not null and "soap_note_id" is null and "vaccination_record_id" is null and "lab_result_id" is null
) or (
	"record_type" = 'vaccination_record' and "vaccination_record_id" is not null and "soap_note_id" is null and "vital_sign_id" is null and "lab_result_id" is null
) or (
	"record_type" = 'lab_result' and "lab_result_id" is not null and "soap_note_id" is null and "vital_sign_id" is null and "vaccination_record_id" is null
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
		SELECT EXISTS (SELECT 1 FROM public.soap_notes source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.soap_note_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'vital_sign' THEN
		SELECT EXISTS (SELECT 1 FROM public.vital_signs source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.vital_sign_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'vaccination_record' THEN
		SELECT EXISTS (SELECT 1 FROM public.vaccination_records source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.vaccination_record_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	ELSIF NEW.record_type = 'lab_result' THEN
		SELECT EXISTS (SELECT 1 FROM public.lab_results source WHERE source.practice_id = NEW.practice_id AND source.id = NEW.lab_result_id AND source.patient_id = NEW.patient_id AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id) INTO source_matches;
	END IF;
	IF NOT source_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Clinical correction source does not match its patient and appointment.';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_clinical_record_correction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Clinical correction events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_correction_id_clinical_record_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."clinical_record_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_source_lab_result_id_lab_results_id_fk" FOREIGN KEY ("source_lab_result_id") REFERENCES "public"."lab_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_replacement_lab_result_id_lab_results_id_fk" FOREIGN KEY ("replacement_lab_result_id") REFERENCES "public"."lab_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_source_tenant_fk" FOREIGN KEY ("practice_id","source_lab_result_id") REFERENCES "public"."lab_results"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_replacement_tenant_fk" FOREIGN KEY ("practice_id","replacement_lab_result_id") REFERENCES "public"."lab_results"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_correction_source_tenant_fk" FOREIGN KEY ("practice_id","correction_id","source_lab_result_id") REFERENCES "public"."clinical_record_corrections"("practice_id","id","lab_result_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ADD CONSTRAINT "lab_result_replacements_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_result_replacements_source_history_idx" ON "lab_result_replacements" USING btree ("practice_id","source_lab_result_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_replacements_source_uq" ON "lab_result_replacements" USING btree ("practice_id","source_lab_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_replacements_replacement_uq" ON "lab_result_replacements" USING btree ("practice_id","replacement_lab_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_replacements_operation_uq" ON "lab_result_replacements" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_lab_result_replacement_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	correction_matches boolean := false;
	cycle_exists boolean := false;
BEGIN
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('lab-result-replacement-graph:' || NEW.practice_id::text, 0)
	);
	SELECT EXISTS (
		SELECT 1 FROM public.clinical_record_corrections correction
		WHERE correction.practice_id = NEW.practice_id
			AND correction.id = NEW.correction_id
			AND correction.record_type = 'lab_result'
			AND correction.lab_result_id = NEW.source_lab_result_id
	) INTO correction_matches;
	IF NOT correction_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Replacement must identify the exact entered-in-error lab correction for its source.';
	END IF;
	WITH RECURSIVE descendants(id) AS (
		SELECT link.replacement_lab_result_id
		FROM public.lab_result_replacements link
		WHERE link.practice_id = NEW.practice_id AND link.source_lab_result_id = NEW.replacement_lab_result_id
		UNION
		SELECT link.replacement_lab_result_id
		FROM public.lab_result_replacements link
		JOIN descendants prior ON prior.id = link.source_lab_result_id
		WHERE link.practice_id = NEW.practice_id
	)
	SELECT EXISTS (SELECT 1 FROM descendants WHERE id = NEW.source_lab_result_id) INTO cycle_exists;
	IF cycle_exists THEN
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Lab result replacement lineage cannot contain a cycle.';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER lab_result_replacements_validate
BEFORE INSERT ON "lab_result_replacements"
FOR EACH ROW EXECUTE FUNCTION validate_lab_result_replacement_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_lab_result_replacement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Lab result replacement evidence is append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER lab_result_replacements_immutable
BEFORE UPDATE OR DELETE ON "lab_result_replacements"
FOR EACH ROW EXECUTE FUNCTION reject_lab_result_replacement_mutation();--> statement-breakpoint
ALTER TABLE "lab_result_replacements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "lab_result_replacements"
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid)
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on' OR "practice_id" = nullif(current_setting('app.current_practice_id', true), '')::uuid);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON lab_result_replacements FROM openpims_app;
		GRANT SELECT, INSERT ON lab_result_replacements TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON lab_result_replacements FROM anon; END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON lab_result_replacements FROM authenticated; END IF;
END $$;
