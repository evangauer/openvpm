CREATE TYPE "public"."clinic_pilot_communication_mode" AS ENUM('email_only', 'email_and_sms');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_contact_outcome" AS ENUM('replied', 'no_reply', 'scheduled', 'completed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_decision" AS ENUM('pending', 'eligible', 'approved', 'paused', 'not_a_fit', 'graduated');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_event_type" AS ENUM('enrolled', 'updated');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_next_action" AS ENUM('confirm_fit', 'schedule_setup', 'validate_import', 'complete_first_visit', 'review_communications', 'configure_payment', 'review_clinic_week', 'resolve_blockers', 'decide_graduation', 'support_retention', 'revisit_fit');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_reason" AS ENUM('initial_review', 'clinic_feedback', 'product_evidence', 'support_review', 'blocker_review', 'graduation_decision');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_stage" AS ENUM('candidate', 'parallel_setup', 'visit_validation', 'pilot_week', 'graduation_review', 'completed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_support_cadence" AS ENUM('daily', 'twice_weekly', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."clinic_pilot_workflow" AS ENUM('general_practice', 'house_call');--> statement-breakpoint
CREATE TABLE "clinic_pilot_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_pilot_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"event_type" "clinic_pilot_event_type" NOT NULL,
	"reason" "clinic_pilot_reason" NOT NULL,
	"cohort_key" varchar(32) NOT NULL,
	"workflow" "clinic_pilot_workflow" NOT NULL,
	"stage" "clinic_pilot_stage" NOT NULL,
	"decision" "clinic_pilot_decision" NOT NULL,
	"qualification_checklist" jsonb NOT NULL,
	"readiness_checklist" jsonb NOT NULL,
	"blocker_codes" text[] NOT NULL,
	"next_action" "clinic_pilot_next_action" NOT NULL,
	"support_cadence" "clinic_pilot_support_cadence" NOT NULL,
	"owner_identity" varchar(255) NOT NULL,
	"communication_mode" "clinic_pilot_communication_mode" NOT NULL,
	"communication_tested_at" timestamp with time zone,
	"first_visit_validated_at" timestamp with time zone,
	"clinic_use_validated_at" timestamp with time zone,
	"clinic_acceptance_at" timestamp with time zone,
	"clinic_acceptance_by_user_id" uuid,
	"last_contact_at" timestamp with time zone,
	"last_contact_outcome" "clinic_pilot_contact_outcome",
	"target_start_on" date,
	"next_review_at" timestamp with time zone,
	"projection_version" integer NOT NULL,
	"actor_identity" varchar(255) NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_pilot_events_snapshot_check" CHECK ("clinic_pilot_events"."projection_version" > 0
        and "clinic_pilot_events"."payload_hash" ~ '^[a-f0-9]{64}$'
        and "clinic_pilot_events"."actor_identity" = btrim("clinic_pilot_events"."actor_identity")
        and length("clinic_pilot_events"."actor_identity") between 3 and 255
        and "clinic_pilot_events"."owner_identity" = btrim("clinic_pilot_events"."owner_identity")
        and length("clinic_pilot_events"."owner_identity") between 3 and 255
        and "clinic_pilot_events"."cohort_key" ~ '^pilot-[0-9]{4}-[0-9]{2}$'
        and jsonb_typeof("clinic_pilot_events"."qualification_checklist") = 'object'
        and jsonb_typeof("clinic_pilot_events"."readiness_checklist") = 'object'
        and jsonb_typeof("clinic_pilot_events"."evidence_snapshot") = 'object'
        and ("clinic_pilot_events"."last_contact_at" is null) = ("clinic_pilot_events"."last_contact_outcome" is null)
        and ("clinic_pilot_events"."clinic_acceptance_at" is null) = ("clinic_pilot_events"."clinic_acceptance_by_user_id" is null)
        and "clinic_pilot_events"."blocker_codes" <@ ARRAY[
          'workflow_fit',
          'data_import',
          'staff_training',
          'record_accuracy',
          'billing',
          'payments',
          'email',
          'sms',
          'permissions',
          'device_connectivity',
          'backup_export',
          'support_coverage'
        ]::text[]
        and cardinality("clinic_pilot_events"."blocker_codes") <= 12
        and array_position("clinic_pilot_events"."blocker_codes", null) is null)
);
--> statement-breakpoint
CREATE TABLE "clinic_pilots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"cohort_key" varchar(32) NOT NULL,
	"workflow" "clinic_pilot_workflow" NOT NULL,
	"stage" "clinic_pilot_stage" DEFAULT 'candidate' NOT NULL,
	"decision" "clinic_pilot_decision" DEFAULT 'pending' NOT NULL,
	"qualification_checklist" jsonb DEFAULT '{"supportedClinicType":false,"supportedJurisdictionConfirmed":false,"singleLocation":false,"connectedModeAccepted":false,"parallelRunAccepted":false,"championConfirmed":false,"supportedWorkflowConfirmed":false,"noUnsupportedMustHave":false}'::jsonb NOT NULL,
	"readiness_checklist" jsonb DEFAULT '{"rolesAndDevicesValidated":false,"migrationPlanAccepted":false,"sampleValidationAccepted":false,"firstVisitScheduled":false,"exportAndRollbackConfirmed":false,"supportCadenceConfirmed":false}'::jsonb NOT NULL,
	"blocker_codes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"next_action" "clinic_pilot_next_action" DEFAULT 'confirm_fit' NOT NULL,
	"support_cadence" "clinic_pilot_support_cadence" DEFAULT 'daily' NOT NULL,
	"owner_identity" varchar(255) NOT NULL,
	"communication_mode" "clinic_pilot_communication_mode" DEFAULT 'email_only' NOT NULL,
	"communication_tested_at" timestamp with time zone,
	"first_visit_validated_at" timestamp with time zone,
	"clinic_use_validated_at" timestamp with time zone,
	"clinic_acceptance_at" timestamp with time zone,
	"clinic_acceptance_by_user_id" uuid,
	"last_contact_at" timestamp with time zone,
	"last_contact_outcome" "clinic_pilot_contact_outcome",
	"target_start_on" date,
	"next_review_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_pilots_version_check" CHECK ("clinic_pilots"."version" > 0),
	CONSTRAINT "clinic_pilots_operating_shape_check" CHECK ("clinic_pilots"."cohort_key" ~ '^pilot-[0-9]{4}-[0-9]{2}$'
        and jsonb_typeof("clinic_pilots"."qualification_checklist") = 'object'
        and jsonb_typeof("clinic_pilots"."readiness_checklist") = 'object'
        and "clinic_pilots"."owner_identity" = btrim("clinic_pilots"."owner_identity")
        and length("clinic_pilots"."owner_identity") between 3 and 255
        and ("clinic_pilots"."last_contact_at" is null) = ("clinic_pilots"."last_contact_outcome" is null)
        and ("clinic_pilots"."clinic_acceptance_at" is null) = ("clinic_pilots"."clinic_acceptance_by_user_id" is null)),
	CONSTRAINT "clinic_pilots_blocker_codes_check" CHECK ("clinic_pilots"."blocker_codes" <@ ARRAY[
          'workflow_fit',
          'data_import',
          'staff_training',
          'record_accuracy',
          'billing',
          'payments',
          'email',
          'sms',
          'permissions',
          'device_connectivity',
          'backup_export',
          'support_coverage'
        ]::text[]
        and cardinality("clinic_pilots"."blocker_codes") <= 12
        and array_position("clinic_pilots"."blocker_codes", null) is null),
	CONSTRAINT "clinic_pilots_lifecycle_check" CHECK ((
          "clinic_pilots"."stage" = 'completed'
          and "clinic_pilots"."decision" = 'graduated'
          and cardinality("clinic_pilots"."blocker_codes") = 0
          and "clinic_pilots"."next_action" = 'support_retention'
          and "clinic_pilots"."next_review_at" is null
        ) or (
          "clinic_pilots"."stage" = 'closed'
          and "clinic_pilots"."decision" = 'not_a_fit'
          and "clinic_pilots"."next_action" = 'revisit_fit'
          and "clinic_pilots"."next_review_at" is null
        ) or (
          "clinic_pilots"."stage" not in ('completed', 'closed')
          and "clinic_pilots"."decision" not in ('graduated', 'not_a_fit')
          and "clinic_pilots"."next_review_at" is not null
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_pilots_id_practice_uq" ON "clinic_pilots" USING btree ("id","practice_id");--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_clinic_pilot_id_clinic_pilots_id_fk" FOREIGN KEY ("clinic_pilot_id") REFERENCES "public"."clinic_pilots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_pilot_practice_fk" FOREIGN KEY ("clinic_pilot_id","practice_id") REFERENCES "public"."clinic_pilots"("id","practice_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_acceptance_user_practice_fk" FOREIGN KEY ("practice_id","clinic_acceptance_by_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD CONSTRAINT "clinic_pilots_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD CONSTRAINT "clinic_pilots_acceptance_user_practice_fk" FOREIGN KEY ("practice_id","clinic_acceptance_by_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_pilot_events_operation_uq" ON "clinic_pilot_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "clinic_pilot_events_history_idx" ON "clinic_pilot_events" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_pilots_practice_uq" ON "clinic_pilots" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "clinic_pilots_review_idx" ON "clinic_pilots" USING btree ("stage","next_review_at","practice_id");--> statement-breakpoint

-- Install system-only access in the same transaction that creates these
-- cross-tenant tables, so there is no fail-open interval before db:rls runs.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;--> statement-breakpoint
ALTER TABLE clinic_pilots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON clinic_pilots
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());--> statement-breakpoint
ALTER TABLE clinic_pilot_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_read ON clinic_pilot_events
  FOR SELECT USING (app_rls_bypass());--> statement-breakpoint
CREATE POLICY system_insert ON clinic_pilot_events
  FOR INSERT WITH CHECK (app_rls_bypass());--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON clinic_pilots, clinic_pilot_events FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON clinic_pilots TO openpims_app;
    GRANT SELECT, INSERT ON clinic_pilot_events TO openpims_app;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON clinic_pilots, clinic_pilot_events FROM %I', r
      );
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- An event ledger is an invariant, not an application convention. Projection
-- writes and event inserts are checked together at transaction commit.
CREATE OR REPLACE FUNCTION enforce_clinic_pilot_projection_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.clinic_pilot_events e
    WHERE e.clinic_pilot_id = NEW.id
      AND e.practice_id = NEW.practice_id
      AND e.projection_version = NEW.version
      AND e.cohort_key = NEW.cohort_key
      AND e.workflow = NEW.workflow
      AND e.stage = NEW.stage
      AND e.decision = NEW.decision
      AND e.qualification_checklist = NEW.qualification_checklist
      AND e.readiness_checklist = NEW.readiness_checklist
      AND e.blocker_codes = NEW.blocker_codes
      AND e.next_action = NEW.next_action
      AND e.support_cadence = NEW.support_cadence
      AND e.owner_identity = NEW.owner_identity
      AND e.communication_mode = NEW.communication_mode
      AND e.communication_tested_at IS NOT DISTINCT FROM NEW.communication_tested_at
      AND e.first_visit_validated_at IS NOT DISTINCT FROM NEW.first_visit_validated_at
      AND e.clinic_use_validated_at IS NOT DISTINCT FROM NEW.clinic_use_validated_at
      AND e.clinic_acceptance_at IS NOT DISTINCT FROM NEW.clinic_acceptance_at
      AND e.clinic_acceptance_by_user_id IS NOT DISTINCT FROM NEW.clinic_acceptance_by_user_id
      AND e.last_contact_at IS NOT DISTINCT FROM NEW.last_contact_at
      AND e.last_contact_outcome IS NOT DISTINCT FROM NEW.last_contact_outcome
      AND e.target_start_on IS NOT DISTINCT FROM NEW.target_start_on
      AND e.next_review_at IS NOT DISTINCT FROM NEW.next_review_at
  ) THEN
    RAISE EXCEPTION 'clinic pilot projection version % requires a matching immutable event', NEW.version;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER clinic_pilots_require_event
AFTER INSERT OR UPDATE ON clinic_pilots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_clinic_pilot_projection_audit();--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_clinic_pilot_event_mutation()
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
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Clinic pilot events are immutable.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER clinic_pilot_events_immutable
BEFORE UPDATE OR DELETE ON clinic_pilot_events
FOR EACH ROW EXECUTE FUNCTION reject_clinic_pilot_event_mutation();
