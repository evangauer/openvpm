CREATE TYPE "public"."lab_follow_up_status" AS ENUM('not_required', 'open', 'completed');--> statement-breakpoint
CREATE TYPE "public"."lab_result_flag" AS ENUM('unknown', 'normal', 'abnormal', 'critical');--> statement-breakpoint
CREATE TYPE "public"."lab_result_event_type" AS ENUM('created', 'completed', 'reviewed', 'follow_up_assigned', 'follow_up_reassigned', 'follow_up_completed');--> statement-breakpoint
CREATE TABLE "lab_result_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"lab_result_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"event_type" "lab_result_event_type" NOT NULL,
	"status_before" "lab_status",
	"status_after" "lab_status" NOT NULL,
	"result_value" varchar(128),
	"unit" varchar(32),
	"reference_range_low" numeric(10, 3),
	"reference_range_high" numeric(10, 3),
	"result_flag" "lab_result_flag" NOT NULL,
	"follow_up_status" "lab_follow_up_status" DEFAULT 'not_required' NOT NULL,
	"follow_up_assigned_to" uuid,
	"follow_up_due_at" timestamp with time zone,
	"actor_id" uuid NOT NULL,
	"actor_name" varchar(255) NOT NULL,
	"note" text,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	CONSTRAINT "lab_result_events_shape_check" CHECK (length(btrim("lab_result_events"."actor_name")) between 1 and 255
        and "lab_result_events"."operation_payload_hash" ~ '^[0-9a-f]{64}$'
        and ("lab_result_events"."note" is null or length("lab_result_events"."note") <= 1000)
        and ("lab_result_events"."status_after" <> 'pending' or "lab_result_events"."follow_up_status" = 'not_required')
        and not (
          "lab_result_events"."status_after" = 'reviewed'
          and "lab_result_events"."result_flag" = 'critical'
          and "lab_result_events"."follow_up_status" = 'not_required'
        )
        and not (
          "lab_result_events"."result_flag" = 'critical'
          and "lab_result_events"."follow_up_status" in ('open', 'completed')
          and "lab_result_events"."follow_up_due_at" is null
        )
        and (
          ("lab_result_events"."status_after" = 'pending'
            and "lab_result_events"."result_value" is null
            and "lab_result_events"."unit" is null
            and "lab_result_events"."reference_range_low" is null
            and "lab_result_events"."reference_range_high" is null
            and "lab_result_events"."result_flag" = 'unknown')
          or ("lab_result_events"."status_after" in ('completed', 'reviewed')
            and length(btrim(coalesce("lab_result_events"."result_value", ''))) between 1 and 128)
        )
        and (
          ("lab_result_events"."follow_up_status" = 'not_required'
            and "lab_result_events"."follow_up_assigned_to" is null
            and "lab_result_events"."follow_up_due_at" is null)
          or ("lab_result_events"."follow_up_status" in ('open', 'completed')
            and "lab_result_events"."follow_up_assigned_to" is not null)
        )
        and (
          "lab_result_events"."event_type" = 'created'
          and "lab_result_events"."status_before" is null
          and "lab_result_events"."status_after" in ('pending', 'completed')
          and ("lab_result_events"."status_after" <> 'pending' or "lab_result_events"."result_flag" = 'unknown')
        or "lab_result_events"."event_type" = 'completed'
          and "lab_result_events"."status_before" = 'pending'
          and "lab_result_events"."status_after" = 'completed'
        or "lab_result_events"."event_type" = 'reviewed'
          and "lab_result_events"."status_before" = 'completed'
          and "lab_result_events"."status_after" = 'reviewed'
        or "lab_result_events"."event_type" in ('follow_up_assigned', 'follow_up_reassigned')
          and "lab_result_events"."status_before" = "lab_result_events"."status_after"
          and "lab_result_events"."follow_up_status" = 'open'
          and "lab_result_events"."follow_up_assigned_to" is not null
        or "lab_result_events"."event_type" = 'follow_up_completed'
          and "lab_result_events"."status_before" = "lab_result_events"."status_after"
          and "lab_result_events"."follow_up_status" = 'completed'
          and "lab_result_events"."follow_up_assigned_to" is not null
          and length(btrim(coalesce("lab_result_events"."note", ''))) between 3 and 1000
        ))
);
--> statement-breakpoint
ALTER TABLE "lab_results" DROP CONSTRAINT "lab_results_practice_appointment_fk";
--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "creation_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "creation_payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "result_flag" "lab_result_flag" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_status" "lab_follow_up_status" DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_assigned_to" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_note" varchar(1000);--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_completed_by" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "follow_up_outcome" varchar(1000);--> statement-breakpoint
-- Promote legacy rows that already contain values into the review workflow.
UPDATE "lab_results"
SET "status" = 'completed'
WHERE "status" = 'pending'
  AND length(btrim(coalesce("result_value", ''))) > 0;--> statement-breakpoint
-- Rows without a result cannot truthfully remain completed or reviewed.
UPDATE "lab_results"
SET "status" = 'pending', "reviewed_by" = null
WHERE "status" in ('completed', 'reviewed')
  AND length(btrim(coalesce("result_value", ''))) = 0;--> statement-breakpoint
-- A legacy reviewed row without an attributable reviewer is awaiting review.
UPDATE "lab_results"
SET "status" = 'completed'
WHERE "status" = 'reviewed' AND "reviewed_by" is null;--> statement-breakpoint
-- Pending rows carry no partial values or follow-up ownership; both start only
-- after the values are atomically completed.
UPDATE "lab_results"
SET "result_value" = null,
    "unit" = null,
    "reference_range_low" = null,
    "reference_range_high" = null,
    "result_flag" = 'unknown',
    "reviewed_by" = null,
    "follow_up_status" = 'not_required',
    "follow_up_assigned_to" = null,
    "follow_up_due_at" = null,
    "follow_up_note" = null,
    "follow_up_completed_by" = null,
    "follow_up_completed_at" = null,
    "follow_up_outcome" = null
WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "lab_results"
SET "reviewed_by" = null
WHERE "status" = 'completed';--> statement-breakpoint
-- Existing completed/reviewed rows predate explicit lifecycle timestamps.
UPDATE "lab_results"
SET "completed_at" = coalesce("updated_at", "created_at")
WHERE "status" in ('completed', 'reviewed');--> statement-breakpoint
UPDATE "lab_results"
SET "reviewed_at" = coalesce("updated_at", "created_at")
WHERE "status" = 'reviewed';--> statement-breakpoint
-- Unlink any historically inconsistent appointment/patient association before
-- enforcing the stronger composite appointment key.
UPDATE "lab_results" result
SET "appointment_id" = null
WHERE result."appointment_id" is not null
  AND NOT EXISTS (
    SELECT 1 FROM "appointments" appointment
    WHERE appointment."practice_id" = result."practice_id"
      AND appointment."id" = result."appointment_id"
      AND appointment."patient_id" = result."patient_id"
  );--> statement-breakpoint
-- Required before the event ledger's composite tenant FK references it.
CREATE UNIQUE INDEX "lab_results_practice_record_uq" ON "lab_results" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_lab_result_id_lab_results_id_fk" FOREIGN KEY ("lab_result_id") REFERENCES "public"."lab_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_follow_up_assigned_to_users_id_fk" FOREIGN KEY ("follow_up_assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_result_tenant_fk" FOREIGN KEY ("practice_id","lab_result_id") REFERENCES "public"."lab_results"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_patient_tenant_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_events" ADD CONSTRAINT "lab_result_events_assignee_tenant_fk" FOREIGN KEY ("practice_id","follow_up_assigned_to") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_result_events_result_history_idx" ON "lab_result_events" USING btree ("practice_id","lab_result_id","created_at","id");--> statement-breakpoint
CREATE INDEX "lab_result_events_practice_time_idx" ON "lab_result_events" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_events_practice_operation_uq" ON "lab_result_events" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_result_events_created_uq" ON "lab_result_events" USING btree ("practice_id","lab_result_id") WHERE "lab_result_events"."event_type" = 'created';--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_follow_up_assigned_to_users_id_fk" FOREIGN KEY ("follow_up_assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_follow_up_completed_by_users_id_fk" FOREIGN KEY ("follow_up_completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_patient_fk" FOREIGN KEY ("practice_id","patient_id") REFERENCES "public"."patients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_ordered_by_fk" FOREIGN KEY ("practice_id","ordered_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_reviewed_by_fk" FOREIGN KEY ("practice_id","reviewed_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_follow_up_assigned_fk" FOREIGN KEY ("practice_id","follow_up_assigned_to") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_follow_up_completed_fk" FOREIGN KEY ("practice_id","follow_up_completed_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_practice_appointment_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id") REFERENCES "public"."appointments"("practice_id","id","patient_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_results_review_inbox_idx" ON "lab_results" USING btree ("practice_id","status","result_flag","completed_at","id");--> statement-breakpoint
CREATE INDEX "lab_results_follow_up_inbox_idx" ON "lab_results" USING btree ("practice_id","follow_up_status","follow_up_assigned_to","follow_up_due_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_results_creation_operation_uq" ON "lab_results" USING btree ("practice_id","creation_operation_id");--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lifecycle_shape_check" CHECK ((
          "lab_results"."status" = 'pending'
          and "lab_results"."completed_at" is null
          and "lab_results"."reviewed_at" is null
          and "lab_results"."reviewed_by" is null
        ) or (
          "lab_results"."status" = 'completed'
          and "lab_results"."completed_at" is not null
          and "lab_results"."reviewed_at" is null
          and "lab_results"."reviewed_by" is null
        ) or (
          "lab_results"."status" = 'reviewed'
          and "lab_results"."completed_at" is not null
          and "lab_results"."reviewed_at" is not null
          and "lab_results"."reviewed_by" is not null
        ));--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_creation_operation_shape_check" CHECK (("lab_results"."creation_operation_id" is null and "lab_results"."creation_payload_hash" is null)
        or ("lab_results"."creation_operation_id" is not null and "lab_results"."creation_payload_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_result_shape_check" CHECK ((
          "lab_results"."status" = 'pending'
          and "lab_results"."result_value" is null
          and "lab_results"."unit" is null
          and "lab_results"."reference_range_low" is null
          and "lab_results"."reference_range_high" is null
          and "lab_results"."result_flag" = 'unknown'
        ) or (
          "lab_results"."status" in ('completed', 'reviewed')
          and length(btrim(coalesce("lab_results"."result_value", ''))) > 0
        ));--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_follow_up_shape_check" CHECK (("lab_results"."status" <> 'pending' or "lab_results"."follow_up_status" = 'not_required')
        and not (
          "lab_results"."status" = 'reviewed'
          and "lab_results"."result_flag" = 'critical'
          and "lab_results"."follow_up_status" = 'not_required'
        )
        and not (
          "lab_results"."result_flag" = 'critical'
          and "lab_results"."follow_up_status" in ('open', 'completed')
          and "lab_results"."follow_up_due_at" is null
        )
        and ((
          "lab_results"."follow_up_status" = 'not_required'
          and "lab_results"."follow_up_assigned_to" is null
          and "lab_results"."follow_up_due_at" is null
          and "lab_results"."follow_up_note" is null
          and "lab_results"."follow_up_completed_by" is null
          and "lab_results"."follow_up_completed_at" is null
          and "lab_results"."follow_up_outcome" is null
        ) or (
          "lab_results"."follow_up_status" = 'open'
          and "lab_results"."follow_up_assigned_to" is not null
          and "lab_results"."follow_up_completed_by" is null
          and "lab_results"."follow_up_completed_at" is null
          and "lab_results"."follow_up_outcome" is null
        ) or (
          "lab_results"."follow_up_status" = 'completed'
          and "lab_results"."follow_up_assigned_to" is not null
          and "lab_results"."follow_up_completed_by" is not null
          and "lab_results"."follow_up_completed_at" is not null
          and length(btrim(coalesce("lab_results"."follow_up_outcome", ''))) between 3 and 1000
        )));--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_lab_result_event_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE source_matches boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM public.lab_results source
		WHERE source.practice_id = NEW.practice_id
			AND source.id = NEW.lab_result_id
			AND source.patient_id = NEW.patient_id
			AND source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
	) INTO source_matches;

	IF NOT source_matches THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'Lab result event source does not match its practice, patient, or appointment.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER lab_result_events_validate_source
	BEFORE INSERT ON lab_result_events
	FOR EACH ROW
	EXECUTE FUNCTION validate_lab_result_event_source();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_lab_result_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		AND current_user = (
			SELECT pg_catalog.pg_get_userbyid(class.relowner)
			FROM pg_catalog.pg_class class
			JOIN pg_catalog.pg_namespace namespace
				ON namespace.oid = class.relnamespace
			WHERE namespace.nspname = TG_TABLE_SCHEMA
				AND class.relname = TG_TABLE_NAME
		)
	THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'Lab result events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER lab_result_events_immutable
	BEFORE UPDATE OR DELETE ON lab_result_events
	FOR EACH ROW
	EXECUTE FUNCTION reject_lab_result_event_mutation();--> statement-breakpoint
ALTER TABLE lab_result_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON lab_result_events
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
		REVOKE ALL ON lab_result_events FROM openpims_app;
		GRANT SELECT, INSERT ON lab_result_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON lab_result_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON lab_result_events FROM authenticated;
	END IF;
END $$;
