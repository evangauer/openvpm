CREATE TABLE "soap_note_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"correction_id" uuid NOT NULL,
	"source_soap_note_id" uuid NOT NULL,
	"replacement_soap_note_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_name" varchar(255) NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	CONSTRAINT "soap_note_replacements_shape_check" CHECK ("soap_note_replacements"."source_soap_note_id" <> "soap_note_replacements"."replacement_soap_note_id"
        and "soap_note_replacements"."actor_name" = btrim("soap_note_replacements"."actor_name")
        and length(btrim("soap_note_replacements"."actor_name")) between 1 and 255
        and "soap_note_replacements"."operation_payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_record_corrections_practice_record_soap_source_uq" ON "clinical_record_corrections" USING btree ("practice_id","id","soap_note_id");--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_correction_id_clinical_record_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."clinical_record_corrections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_source_soap_note_id_soap_notes_id_fk" FOREIGN KEY ("source_soap_note_id") REFERENCES "public"."soap_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_replacement_soap_note_id_soap_notes_id_fk" FOREIGN KEY ("replacement_soap_note_id") REFERENCES "public"."soap_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_source_tenant_fk" FOREIGN KEY ("practice_id","source_soap_note_id") REFERENCES "public"."soap_notes"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_replacement_tenant_fk" FOREIGN KEY ("practice_id","replacement_soap_note_id") REFERENCES "public"."soap_notes"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_correction_source_tenant_fk" FOREIGN KEY ("practice_id","correction_id","source_soap_note_id") REFERENCES "public"."clinical_record_corrections"("practice_id","id","soap_note_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_replacements" ADD CONSTRAINT "soap_note_replacements_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "soap_note_replacements_source_history_idx" ON "soap_note_replacements" USING btree ("practice_id","source_soap_note_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "soap_note_replacements_source_uq" ON "soap_note_replacements" USING btree ("practice_id","source_soap_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "soap_note_replacements_replacement_uq" ON "soap_note_replacements" USING btree ("practice_id","replacement_soap_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "soap_note_replacements_operation_uq" ON "soap_note_replacements" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_soap_note_replacement_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	lineage_matches boolean := false;
	cycle_exists boolean := false;
	historical_restore boolean := false;
	expected_payload_hash text;
BEGIN
	historical_restore :=
		coalesce(current_setting('app.soap_replacement_restore', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class AS class
			JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA
				AND class.relname = TG_TABLE_NAME
		);

	-- Serialize graph mutations per tenant so concurrent inserts cannot create a
	-- cycle that neither transaction can observe.
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('soap-note-replacement-graph:' || NEW.practice_id::text, 0)
	);

	SELECT pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				'{"patientId":' || pg_catalog.to_json(source.patient_id::text)::text ||
				',"sourceNoteId":' || pg_catalog.to_json(NEW.source_soap_note_id::text)::text ||
				',"actorId":' || pg_catalog.to_json(NEW.actor_id::text)::text ||
				',"reason":' || pg_catalog.to_json(correction.reason)::text ||
				',"subjective":' || coalesce(pg_catalog.to_json(replacement.subjective)::text, 'null') ||
				',"objective":' || coalesce(pg_catalog.to_json(replacement.objective)::text, 'null') ||
				',"assessment":' || coalesce(pg_catalog.to_json(replacement.assessment)::text, 'null') ||
				',"plan":' || coalesce(pg_catalog.to_json(replacement.plan)::text, 'null') || '}',
				'UTF8'
			)
		),
		'hex'
	)
	INTO expected_payload_hash
	FROM public.clinical_record_corrections AS correction
	JOIN public.soap_notes AS source
		ON source.practice_id = correction.practice_id
		AND source.id = correction.soap_note_id
	JOIN public.soap_notes AS replacement
		ON replacement.practice_id = source.practice_id
		AND replacement.id = NEW.replacement_soap_note_id
	WHERE correction.practice_id = NEW.practice_id
		AND correction.id = NEW.correction_id
		AND correction.soap_note_id = NEW.source_soap_note_id;

	IF NEW.operation_payload_hash IS DISTINCT FROM expected_payload_hash THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'SOAP replacement payload hash is invalid.';
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM public.clinical_record_corrections AS correction
		JOIN public.soap_notes AS source
			ON source.practice_id = correction.practice_id
			AND source.id = correction.soap_note_id
		JOIN public.soap_notes AS replacement
			ON replacement.practice_id = source.practice_id
			AND replacement.id = NEW.replacement_soap_note_id
		WHERE correction.practice_id = NEW.practice_id
			AND correction.id = NEW.correction_id
			AND correction.record_type = 'soap_note'
			AND correction.action = 'entered_in_error'
			AND correction.soap_note_id = NEW.source_soap_note_id
			AND source.status = 'finalized'
			AND replacement.status = 'finalized'
			AND (
				(source.deleted_at IS NULL AND replacement.deleted_at IS NULL)
				OR (
					historical_restore
					AND (source.deleted_at IS NULL OR NEW.created_at <= source.deleted_at)
					AND (replacement.deleted_at IS NULL OR NEW.created_at <= replacement.deleted_at)
				)
			)
			AND replacement.patient_id = source.patient_id
			AND replacement.appointment_id IS NOT DISTINCT FROM source.appointment_id
			AND replacement.finalized_by = NEW.actor_id
			AND replacement.finalizer_name = NEW.actor_name
			AND source.finalized_at <= correction.created_at
			AND correction.created_at <= replacement.finalized_at
			AND replacement.finalized_at <= NEW.created_at
			AND NEW.created_at <= pg_catalog.now()
			-- A replacement may itself be corrected later and become the source of
			-- another link. Historical restore therefore permits that correction
			-- only when its evidence is not earlier than this link.
			AND NOT EXISTS (
				SELECT 1
				FROM public.clinical_record_corrections AS replacement_correction
				WHERE replacement_correction.practice_id = NEW.practice_id
					AND replacement_correction.soap_note_id = NEW.replacement_soap_note_id
					AND replacement_correction.created_at < NEW.created_at
			)
	) INTO lineage_matches;

	IF NOT lineage_matches THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'SOAP replacement must preserve the exact correction, encounter, patient, finalizer, and chronology.';
	END IF;

	WITH RECURSIVE descendants(id) AS (
		SELECT link.replacement_soap_note_id
		FROM public.soap_note_replacements AS link
		WHERE link.practice_id = NEW.practice_id
			AND link.source_soap_note_id = NEW.replacement_soap_note_id
		UNION
		SELECT link.replacement_soap_note_id
		FROM public.soap_note_replacements AS link
		JOIN descendants AS prior ON prior.id = link.source_soap_note_id
		WHERE link.practice_id = NEW.practice_id
	)
	SELECT EXISTS (
		SELECT 1 FROM descendants WHERE id = NEW.source_soap_note_id
	) INTO cycle_exists;

	IF cycle_exists THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'SOAP note replacement lineage cannot contain a cycle.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER soap_note_replacements_validate
BEFORE INSERT ON soap_note_replacements
FOR EACH ROW EXECUTE FUNCTION validate_soap_note_replacement_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION restore_soap_note_replacement(
	p_id uuid,
	p_created_at timestamptz,
	p_practice_id uuid,
	p_correction_id uuid,
	p_source_soap_note_id uuid,
	p_replacement_soap_note_id uuid,
	p_actor_id uuid,
	p_actor_name text,
	p_operation_id uuid,
	p_operation_payload_hash text
)
RETURNS TABLE(result_id uuid, was_inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	restored_id uuid;
	existing_replacement public.soap_note_replacements%ROWTYPE;
BEGIN
	IF p_practice_id IS DISTINCT FROM nullif(current_setting('app.current_practice_id', true), '')::uuid THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'SOAP replacement restore tenant mismatch.';
	END IF;

	-- Only this definer-owned call can ask the validation trigger to accept
	-- historically deleted endpoints. The trigger still validates exact evidence,
	-- chronology, payload hash, and graph acyclicity.
	PERFORM pg_catalog.set_config('app.soap_replacement_restore', 'on', true);
	INSERT INTO public.soap_note_replacements (
		id, created_at, practice_id, correction_id, source_soap_note_id,
		replacement_soap_note_id, actor_id, actor_name, operation_id,
		operation_payload_hash
	) VALUES (
		p_id, p_created_at, p_practice_id, p_correction_id,
		p_source_soap_note_id, p_replacement_soap_note_id, p_actor_id,
		p_actor_name, p_operation_id, p_operation_payload_hash
	)
	ON CONFLICT (practice_id, operation_id) DO NOTHING
	RETURNING id INTO restored_id;

	IF restored_id IS NOT NULL THEN
		RETURN QUERY SELECT restored_id, true;
		RETURN;
	END IF;

	SELECT * INTO existing_replacement
	FROM public.soap_note_replacements
	WHERE practice_id = p_practice_id
		AND operation_id = p_operation_id;

	IF existing_replacement.id IS NULL
		OR existing_replacement.id IS DISTINCT FROM p_id
		OR existing_replacement.created_at IS DISTINCT FROM p_created_at
		OR existing_replacement.correction_id IS DISTINCT FROM p_correction_id
		OR existing_replacement.source_soap_note_id IS DISTINCT FROM p_source_soap_note_id
		OR existing_replacement.replacement_soap_note_id IS DISTINCT FROM p_replacement_soap_note_id
		OR existing_replacement.actor_id IS DISTINCT FROM p_actor_id
		OR existing_replacement.actor_name IS DISTINCT FROM p_actor_name
		OR existing_replacement.operation_payload_hash IS DISTINCT FROM p_operation_payload_hash
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23505',
			MESSAGE = 'SOAP replacement restore operation conflicts with existing evidence.';
	END IF;

	RETURN QUERY SELECT existing_replacement.id, false;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_soap_note_replacement_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class AS class
			JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA
				AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'SOAP note replacement evidence is append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER soap_note_replacements_immutable
BEFORE UPDATE OR DELETE ON soap_note_replacements
FOR EACH ROW EXECUTE FUNCTION reject_soap_note_replacement_mutation();--> statement-breakpoint
ALTER TABLE soap_note_replacements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON soap_note_replacements
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	)
	WITH CHECK (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON soap_note_replacements FROM openpims_app;
		GRANT SELECT, INSERT ON soap_note_replacements TO openpims_app;
		GRANT EXECUTE ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON soap_note_replacements FROM anon;
		REVOKE ALL ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON soap_note_replacements FROM authenticated;
		REVOKE ALL ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) FROM authenticated;
	END IF;
END
$$;
