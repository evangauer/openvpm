CREATE TYPE "public"."soap_note_status" AS ENUM('draft', 'finalized');--> statement-breakpoint
CREATE TABLE "soap_note_addenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"soap_note_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	CONSTRAINT "soap_note_addenda_content_check" CHECK (length(btrim("soap_note_addenda"."content")) between 1 and 10000),
	CONSTRAINT "soap_note_addenda_author_name_check" CHECK (length(btrim("soap_note_addenda"."author_name")) between 1 and 255),
	CONSTRAINT "soap_note_addenda_payload_hash_check" CHECK ("soap_note_addenda"."operation_payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "author_name" varchar(255);--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "status" "soap_note_status" DEFAULT 'finalized' NOT NULL;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "finalized_by" uuid;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD COLUMN "finalizer_name" varchar(255);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM soap_notes AS note
		JOIN users AS author_user ON author_user.id = note.author_id
		WHERE author_user.practice_id <> note.practice_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Cannot add tenant-safe SOAP attribution: a legacy SOAP author belongs to another practice.',
			HINT = 'Before retrying migration 0063, inspect: SELECT note.id, note.practice_id, note.author_id, author_user.practice_id AS author_practice_id FROM soap_notes note JOIN users author_user ON author_user.id = note.author_id WHERE author_user.practice_id <> note.practice_id; Correct the source attribution under an approved clinical data repair.';
	END IF;
END
$$;--> statement-breakpoint
UPDATE "soap_notes" AS note
SET
	"author_name" = COALESCE(NULLIF(btrim(author_user."name"), ''), CASE WHEN note."imported" THEN 'Imported record' ELSE 'Unknown clinician' END),
	"status" = 'finalized',
	"revision" = 1,
	"finalized_at" = note."created_at",
	"finalized_by" = note."author_id",
	"finalizer_name" = COALESCE(NULLIF(btrim(author_user."name"), ''), CASE WHEN note."imported" THEN 'Imported record' ELSE 'Unknown clinician' END)
FROM "users" AS author_user
WHERE author_user."id" = note."author_id"
	AND author_user."practice_id" = note."practice_id";--> statement-breakpoint
UPDATE "soap_notes"
SET
	"author_name" = CASE WHEN "imported" THEN 'Imported record' ELSE 'Unknown clinician' END,
	"status" = 'finalized',
	"revision" = 1,
	"finalized_at" = "created_at",
	"finalized_by" = "author_id",
	"finalizer_name" = CASE WHEN "imported" THEN 'Imported record' ELSE 'Unknown clinician' END
WHERE "author_name" IS NULL;--> statement-breakpoint
UPDATE public.practices AS practice
SET settings = pg_catalog.jsonb_set(
	practice.settings,
	'{demoData,soapNoteIds}',
	(
		SELECT COALESCE(pg_catalog.jsonb_agg(ids.id), '[]'::jsonb)
		FROM (
			SELECT existing_id.id
			FROM pg_catalog.jsonb_array_elements_text(
				CASE
					WHEN pg_catalog.jsonb_typeof(practice.settings #> '{demoData,soapNoteIds}') = 'array'
						THEN practice.settings #> '{demoData,soapNoteIds}'
					ELSE '[]'::jsonb
				END
			) AS existing_id(id)
			UNION
			SELECT note.id::text
			FROM public.soap_notes AS note
			WHERE note.practice_id = practice.id
				AND (
					note.appointment_id::text IN (
						SELECT demo_appointment.id
						FROM pg_catalog.jsonb_array_elements_text(
							CASE
								WHEN pg_catalog.jsonb_typeof(practice.settings #> '{demoData,appointmentIds}') = 'array'
									THEN practice.settings #> '{demoData,appointmentIds}'
								ELSE '[]'::jsonb
							END
						) AS demo_appointment(id)
					)
					OR note.patient_id::text IN (
						SELECT demo_patient.id
						FROM pg_catalog.jsonb_array_elements_text(
							CASE
								WHEN pg_catalog.jsonb_typeof(practice.settings #> '{demoData,patientIds}') = 'array'
									THEN practice.settings #> '{demoData,patientIds}'
								ELSE '[]'::jsonb
							END
						) AS demo_patient(id)
					)
				)
		) AS ids
	),
	true
)
WHERE pg_catalog.jsonb_typeof(practice.settings -> 'demoData') = 'object'
	AND (
		pg_catalog.jsonb_typeof(practice.settings #> '{demoData,appointmentIds}') = 'array'
		OR pg_catalog.jsonb_typeof(practice.settings #> '{demoData,patientIds}') = 'array'
	);--> statement-breakpoint
ALTER TABLE "soap_notes" ALTER COLUMN "author_name" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public.soap_notes AS note
		WHERE note.appointment_id IS NOT NULL
			AND note.deleted_at IS NULL
		GROUP BY note.practice_id, note.appointment_id
		HAVING count(*) FILTER (WHERE note.status = 'draft') > 1
			OR count(*) FILTER (
				WHERE note.status = 'finalized'
					AND NOT EXISTS (
						SELECT 1
						FROM public.clinical_record_corrections AS correction
						WHERE correction.practice_id = note.practice_id
							AND correction.soap_note_id = note.id
					)
			) > 1
			OR (
				count(*) FILTER (WHERE note.status = 'draft') > 0
				AND count(*) FILTER (
					WHERE note.status = 'finalized'
						AND NOT EXISTS (
							SELECT 1
							FROM public.clinical_record_corrections AS correction
							WHERE correction.practice_id = note.practice_id
								AND correction.soap_note_id = note.id
						)
				) > 0
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Cannot enforce encounter SOAP lifecycle: historical appointments contain conflicting active documentation.',
			HINT = 'Inspect active SOAP counts grouped by practice_id and appointment_id, excluding finalized notes referenced by clinical_record_corrections. Correct duplicate attribution under an approved clinical data repair, then retry migration 0063.';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "soap_note_addenda" ADD CONSTRAINT "soap_note_addenda_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_addenda" ADD CONSTRAINT "soap_note_addenda_practice_source_fk" FOREIGN KEY ("practice_id","soap_note_id") REFERENCES "public"."soap_notes"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_note_addenda" ADD CONSTRAINT "soap_note_addenda_practice_author_fk" FOREIGN KEY ("practice_id","author_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "soap_note_addenda_history_idx" ON "soap_note_addenda" USING btree ("practice_id","soap_note_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "soap_note_addenda_operation_uq" ON "soap_note_addenda" USING btree ("practice_id","operation_id");--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_practice_author_fk" FOREIGN KEY ("practice_id","author_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_practice_finalizer_fk" FOREIGN KEY ("practice_id","finalized_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "soap_notes_active_appointment_draft_uq" ON "soap_notes" USING btree ("practice_id","appointment_id") WHERE "soap_notes"."status" = 'draft' and "soap_notes"."appointment_id" is not null and "soap_notes"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_revision_check" CHECK ("soap_notes"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_author_name_check" CHECK (length(btrim("soap_notes"."author_name")) between 1 and 255);--> statement-breakpoint
ALTER TABLE "soap_notes" ADD CONSTRAINT "soap_notes_lifecycle_check" CHECK ((
        "soap_notes"."status" = 'draft'
        and "soap_notes"."finalized_at" is null
        and "soap_notes"."finalized_by" is null
        and "soap_notes"."finalizer_name" is null
        and "soap_notes"."imported" = false
      ) or (
        "soap_notes"."status" = 'finalized'
        and "soap_notes"."finalized_at" is not null
        and "soap_notes"."finalized_by" is not null
        and length(btrim("soap_notes"."finalizer_name")) between 1 and 255
      ));--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_soap_note_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	is_owner boolean;
	actor_name text;
	is_seeded_demo_note boolean;
BEGIN
	is_owner := current_user = (
		SELECT pg_catalog.pg_get_userbyid(class.relowner)
		FROM pg_catalog.pg_class class
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = TG_TABLE_SCHEMA
			AND class.relname = TG_TABLE_NAME
	);

	IF is_owner
		AND coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'INSERT' THEN
		SELECT NULLIF(btrim(actor."name"), '')
		INTO actor_name
		FROM public.users AS actor
		WHERE actor.id = NEW.author_id
			AND actor.practice_id = NEW.practice_id;
		IF NEW.appointment_id IS NOT NULL THEN
			PERFORM 1
			FROM public.appointments AS appointment
			WHERE appointment.id = NEW.appointment_id
				AND appointment.practice_id = NEW.practice_id
			FOR UPDATE;
		END IF;

		NEW.author_name := COALESCE(NULLIF(btrim(NEW.author_name), ''), actor_name,
			CASE WHEN NEW.imported THEN 'Imported record' ELSE 'Unknown clinician' END);
		NEW.revision := COALESCE(NEW.revision, 1);

		IF NEW.status = 'finalized' THEN
			NEW.finalized_at := COALESCE(
				NEW.finalized_at,
				CASE WHEN NEW.imported THEN NEW.created_at ELSE pg_catalog.now() END
			);
			NEW.finalized_by := COALESCE(NEW.finalized_by, NEW.author_id);
			NEW.finalizer_name := COALESCE(NULLIF(btrim(NEW.finalizer_name), ''), NEW.author_name);
		END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'DELETE' THEN
		IF OLD.status = 'draft' THEN
			IF OLD.appointment_id IS NULL THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'Only an open encounter SOAP draft may be discarded.';
			END IF;
			PERFORM 1
			FROM public.appointments AS appointment
			WHERE appointment.id = OLD.appointment_id
				AND appointment.practice_id = OLD.practice_id
				AND appointment.status = 'in_exam'
				AND appointment.deleted_at IS NULL
			FOR UPDATE;
			IF NOT FOUND OR EXISTS (
				SELECT 1
				FROM public.visit_closeouts AS closeout
				WHERE closeout.practice_id = OLD.practice_id
					AND closeout.appointment_id = OLD.appointment_id
					AND closeout.status IN ('clinical_finalized', 'completed')
					AND closeout.deleted_at IS NULL
			) THEN
				RAISE EXCEPTION USING
					ERRCODE = '55000',
					MESSAGE = 'Only a draft from an open, unsigned encounter may be discarded.';
			END IF;
			RETURN OLD;
		END IF;
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'SOAP notes may only be deleted during owner maintenance.';
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM public.practices AS practice
		CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
			CASE
				WHEN pg_catalog.jsonb_typeof(practice.settings #> '{demoData,soapNoteIds}') = 'array'
					THEN practice.settings #> '{demoData,soapNoteIds}'
				ELSE '[]'::jsonb
			END
		) AS demo_note(id)
		WHERE practice.id = OLD.practice_id
			AND demo_note.id = OLD.id::text
	) INTO is_seeded_demo_note;

	IF is_seeded_demo_note
		AND OLD.deleted_at IS NULL
		AND NEW.deleted_at IS NOT NULL
		AND NEW.id IS NOT DISTINCT FROM OLD.id
		AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
		AND NEW.practice_id IS NOT DISTINCT FROM OLD.practice_id
		AND NEW.patient_id IS NOT DISTINCT FROM OLD.patient_id
		AND NEW.appointment_id IS NOT DISTINCT FROM OLD.appointment_id
		AND NEW.author_id IS NOT DISTINCT FROM OLD.author_id
		AND NEW.author_name IS NOT DISTINCT FROM OLD.author_name
		AND NEW.status IS NOT DISTINCT FROM OLD.status
		AND NEW.revision IS NOT DISTINCT FROM OLD.revision
		AND NEW.finalized_at IS NOT DISTINCT FROM OLD.finalized_at
		AND NEW.finalized_by IS NOT DISTINCT FROM OLD.finalized_by
		AND NEW.finalizer_name IS NOT DISTINCT FROM OLD.finalizer_name
		AND NEW.subjective IS NOT DISTINCT FROM OLD.subjective
		AND NEW.objective IS NOT DISTINCT FROM OLD.objective
		AND NEW.assessment IS NOT DISTINCT FROM OLD.assessment
		AND NEW.plan IS NOT DISTINCT FROM OLD.plan
		AND NEW.imported IS NOT DISTINCT FROM OLD.imported
		AND NEW.import_fingerprint IS NOT DISTINCT FROM OLD.import_fingerprint
	THEN
		RETURN NEW;
	END IF;

	IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
		IF NEW.id IS DISTINCT FROM OLD.id
			OR NEW.created_at IS DISTINCT FROM OLD.created_at
			OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
			OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
			OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
			OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
			OR NEW.author_id IS DISTINCT FROM OLD.author_id
			OR NEW.author_name IS DISTINCT FROM OLD.author_name
			OR NEW.imported IS DISTINCT FROM OLD.imported
			OR NEW.import_fingerprint IS DISTINCT FROM OLD.import_fingerprint
			OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
			OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by
			OR NEW.finalizer_name IS DISTINCT FROM OLD.finalizer_name
			OR NEW.revision <> OLD.revision + 1
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '40001',
				MESSAGE = 'SOAP draft update must preserve identity and advance exactly one revision.';
		END IF;
		RETURN NEW;
	END IF;

	IF OLD.status = 'draft' AND NEW.status = 'finalized' THEN
		IF OLD.appointment_id IS NOT NULL THEN
			PERFORM 1
			FROM public.appointments AS appointment
			WHERE appointment.id = OLD.appointment_id
				AND appointment.practice_id = OLD.practice_id
			FOR UPDATE;
		END IF;
		IF NEW.id IS DISTINCT FROM OLD.id
			OR NEW.created_at IS DISTINCT FROM OLD.created_at
			OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
			OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
			OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
			OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
			OR NEW.author_id IS DISTINCT FROM OLD.author_id
			OR NEW.author_name IS DISTINCT FROM OLD.author_name
			OR NEW.subjective IS DISTINCT FROM OLD.subjective
			OR NEW.objective IS DISTINCT FROM OLD.objective
			OR NEW.assessment IS DISTINCT FROM OLD.assessment
			OR NEW.plan IS DISTINCT FROM OLD.plan
			OR NEW.imported IS DISTINCT FROM OLD.imported
			OR NEW.import_fingerprint IS DISTINCT FROM OLD.import_fingerprint
			OR NEW.revision IS DISTINCT FROM OLD.revision
			OR NEW.finalized_at IS NULL
			OR NEW.finalized_by IS NULL
			OR NULLIF(btrim(NEW.finalizer_name), '') IS NULL
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'SOAP finalization must preserve the saved draft and add attribution.';
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Finalized SOAP notes and SOAP identity are immutable.';
END;
$$;--> statement-breakpoint

CREATE TRIGGER soap_notes_lifecycle_guard
	BEFORE INSERT OR UPDATE OR DELETE ON soap_notes
	FOR EACH ROW EXECUTE FUNCTION guard_soap_note_lifecycle();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_soap_appointment_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	target_practice_id uuid;
	target_appointment_id uuid;
	draft_count integer;
	effective_final_count integer;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_practice_id := OLD.practice_id;
		target_appointment_id := OLD.appointment_id;
	ELSE
		target_practice_id := NEW.practice_id;
		target_appointment_id := NEW.appointment_id;
	END IF;
	IF target_appointment_id IS NULL THEN RETURN NULL; END IF;

	SELECT
		count(*) FILTER (WHERE note.status = 'draft'),
		count(*) FILTER (
			WHERE note.status = 'finalized'
				AND NOT EXISTS (
					SELECT 1
					FROM public.clinical_record_corrections AS correction
					WHERE correction.practice_id = note.practice_id
						AND correction.soap_note_id = note.id
				)
		)
	INTO draft_count, effective_final_count
	FROM public.soap_notes AS note
	WHERE note.practice_id = target_practice_id
		AND note.appointment_id = target_appointment_id
		AND note.deleted_at IS NULL;

	IF draft_count > 1
		OR effective_final_count > 1
		OR (draft_count > 0 AND effective_final_count > 0)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'soap_notes_appointment_invariant',
			MESSAGE = 'An encounter may have one active SOAP draft or one effective finalized SOAP note, but not both.';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER soap_notes_appointment_invariant
	AFTER INSERT OR UPDATE OR DELETE ON soap_notes
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION enforce_soap_appointment_invariant();--> statement-breakpoint

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
	END IF;
	IF NOT source_matches THEN
		RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Clinical correction source does not match its patient and appointment, or is not final.';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_soap_note_addendum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	is_owner boolean;
	expected_hash text;
	source_finalized_at timestamptz;
BEGIN
	is_owner := current_user = (
		SELECT pg_catalog.pg_get_userbyid(class.relowner)
		FROM pg_catalog.pg_class class
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = TG_TABLE_SCHEMA
			AND class.relname = TG_TABLE_NAME
	);

	IF TG_OP = 'INSERT' THEN
		SELECT note.finalized_at
		INTO source_finalized_at
		FROM public.soap_notes AS note
		WHERE note.id = NEW.soap_note_id
			AND note.practice_id = NEW.practice_id
			AND note.status = 'finalized';
		IF source_finalized_at IS NULL
			OR NEW.created_at < source_finalized_at
			OR NEW.created_at > pg_catalog.now()
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'SOAP addendum chronology is invalid.';
		END IF;
		expected_hash := pg_catalog.encode(
			pg_catalog.sha256(
				pg_catalog.convert_to(
					'{"noteId":' || pg_catalog.to_json(NEW.soap_note_id::text)::text ||
					',"authorId":' || pg_catalog.to_json(NEW.author_id::text)::text ||
					',"content":' || pg_catalog.to_json(NEW.content)::text || '}',
					'UTF8'
				)
			),
			'hex'
		);
		IF NEW.operation_payload_hash IS DISTINCT FROM expected_hash THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'SOAP addendum payload hash is invalid.';
		END IF;
	END IF;

	IF is_owner
		AND coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;

	IF TG_OP = 'INSERT' THEN
		IF NOT EXISTS (
			SELECT 1
			FROM public.soap_notes AS note
			WHERE note.id = NEW.soap_note_id
				AND note.practice_id = NEW.practice_id
				AND note.status = 'finalized'
				AND note.deleted_at IS NULL
				AND NOT EXISTS (
					SELECT 1
					FROM public.clinical_record_corrections AS correction
					WHERE correction.practice_id = NEW.practice_id
						AND correction.soap_note_id = note.id
				)
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'Addenda require an active finalized SOAP note.';
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'SOAP addenda are immutable.';
END;
$$;--> statement-breakpoint

CREATE TRIGGER soap_note_addenda_guard
	BEFORE INSERT OR UPDATE OR DELETE ON soap_note_addenda
	FOR EACH ROW EXECUTE FUNCTION guard_soap_note_addendum();--> statement-breakpoint

CREATE OR REPLACE FUNCTION restore_soap_note_addendum(
	p_id uuid,
	p_created_at timestamptz,
	p_practice_id uuid,
	p_soap_note_id uuid,
	p_author_id uuid,
	p_author_name text,
	p_content text,
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
	existing_addendum public.soap_note_addenda%ROWTYPE;
	expected_hash text;
	source_finalized_at timestamptz;
	source_deleted_at timestamptz;
	correction_created_at timestamptz;
BEGIN
	IF p_practice_id IS DISTINCT FROM nullif(current_setting('app.current_practice_id', true), '')::uuid THEN
		RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'SOAP addendum restore tenant mismatch.';
	END IF;

	SELECT note.finalized_at, note.deleted_at
	INTO source_finalized_at, source_deleted_at
		FROM public.soap_notes AS note
		WHERE note.id = p_soap_note_id
			AND note.practice_id = p_practice_id
			AND note.status = 'finalized';

	SELECT correction.created_at
	INTO correction_created_at
	FROM public.clinical_record_corrections AS correction
	WHERE correction.practice_id = p_practice_id
		AND correction.soap_note_id = p_soap_note_id
	LIMIT 1;

	IF source_finalized_at IS NULL OR NOT EXISTS (
		SELECT 1 FROM public.users AS actor
		WHERE actor.id = p_author_id AND actor.practice_id = p_practice_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'SOAP addendum restore source or attribution is invalid.';
	END IF;

	IF p_created_at IS NULL
		OR p_created_at < source_finalized_at
		OR p_created_at > pg_catalog.now()
		OR (source_deleted_at IS NOT NULL AND p_created_at > source_deleted_at)
		OR (correction_created_at IS NOT NULL AND p_created_at > correction_created_at)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'SOAP addendum restore chronology is invalid.';
	END IF;

	expected_hash := pg_catalog.encode(
		pg_catalog.sha256(
			pg_catalog.convert_to(
				'{"noteId":' || pg_catalog.to_json(p_soap_note_id::text)::text ||
				',"authorId":' || pg_catalog.to_json(p_author_id::text)::text ||
				',"content":' || pg_catalog.to_json(p_content)::text || '}',
				'UTF8'
			)
		),
		'hex'
	);
	IF p_operation_payload_hash IS DISTINCT FROM expected_hash THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'SOAP addendum restore payload hash is invalid.';
	END IF;

	PERFORM pg_catalog.set_config('app.ledger_maintenance', 'on', true);
	INSERT INTO public.soap_note_addenda (
		id, created_at, practice_id, soap_note_id, author_id, author_name,
		content, operation_id, operation_payload_hash
	) VALUES (
		p_id, p_created_at, p_practice_id, p_soap_note_id, p_author_id,
		p_author_name, p_content, p_operation_id, p_operation_payload_hash
	)
	ON CONFLICT (practice_id, operation_id) DO NOTHING
	RETURNING id INTO restored_id;

	IF restored_id IS NOT NULL THEN
		RETURN QUERY SELECT restored_id, true;
		RETURN;
	END IF;
	SELECT * INTO existing_addendum
	FROM public.soap_note_addenda
	WHERE practice_id = p_practice_id AND operation_id = p_operation_id;
	IF existing_addendum.id IS NULL
		OR existing_addendum.id IS DISTINCT FROM p_id
		OR existing_addendum.created_at IS DISTINCT FROM p_created_at
		OR existing_addendum.soap_note_id IS DISTINCT FROM p_soap_note_id
		OR existing_addendum.author_id IS DISTINCT FROM p_author_id
		OR existing_addendum.author_name IS DISTINCT FROM p_author_name
		OR existing_addendum.content IS DISTINCT FROM p_content
		OR existing_addendum.operation_payload_hash IS DISTINCT FROM p_operation_payload_hash
	THEN
		RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'SOAP addendum restore operation conflicts with existing evidence.';
	END IF;
	RETURN QUERY SELECT existing_addendum.id, false;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;--> statement-breakpoint

ALTER TABLE soap_note_addenda ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY practice_isolation ON soap_note_addenda
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
		REVOKE ALL ON soap_note_addenda FROM openpims_app;
		GRANT SELECT, INSERT ON soap_note_addenda TO openpims_app;
		GRANT EXECUTE ON FUNCTION restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) TO openpims_app;
	END IF;
END
$$;
