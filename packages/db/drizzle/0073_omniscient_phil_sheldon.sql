ALTER TABLE "clinic_pilot_events" DROP CONSTRAINT "clinic_pilot_events_snapshot_check";--> statement-breakpoint
ALTER TABLE "clinic_pilots" DROP CONSTRAINT "clinic_pilots_operating_shape_check";--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD COLUMN "first_visit_validated_closeout_id" uuid;--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD COLUMN "clinic_use_validated_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD COLUMN "first_visit_validated_closeout_id" uuid;--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD COLUMN "clinic_use_validated_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_first_visit_validated_closeout_id_visit_closeouts_id_fk" FOREIGN KEY ("first_visit_validated_closeout_id") REFERENCES "public"."visit_closeouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD CONSTRAINT "clinic_pilots_first_visit_validated_closeout_id_visit_closeouts_id_fk" FOREIGN KEY ("first_visit_validated_closeout_id") REFERENCES "public"."visit_closeouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_pilot_events" ADD CONSTRAINT "clinic_pilot_events_snapshot_check" CHECK ("clinic_pilot_events"."projection_version" > 0
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
        and ("clinic_pilot_events"."first_visit_validated_at" is null) = ("clinic_pilot_events"."first_visit_validated_closeout_id" is null)
        and ("clinic_pilot_events"."clinic_use_validated_at" is null) = ("clinic_pilot_events"."clinic_use_validated_hash" is null)
        and ("clinic_pilot_events"."clinic_use_validated_hash" is null or "clinic_pilot_events"."clinic_use_validated_hash" ~ '^[a-f0-9]{64}$')
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
        and array_position("clinic_pilot_events"."blocker_codes", null) is null);--> statement-breakpoint
ALTER TABLE "clinic_pilots" ADD CONSTRAINT "clinic_pilots_operating_shape_check" CHECK ("clinic_pilots"."cohort_key" ~ '^pilot-[0-9]{4}-[0-9]{2}$'
        and jsonb_typeof("clinic_pilots"."qualification_checklist") = 'object'
        and jsonb_typeof("clinic_pilots"."readiness_checklist") = 'object'
        and "clinic_pilots"."owner_identity" = btrim("clinic_pilots"."owner_identity")
        and length("clinic_pilots"."owner_identity") between 3 and 255
        and ("clinic_pilots"."last_contact_at" is null) = ("clinic_pilots"."last_contact_outcome" is null)
        and ("clinic_pilots"."clinic_acceptance_at" is null) = ("clinic_pilots"."clinic_acceptance_by_user_id" is null)
        and ("clinic_pilots"."first_visit_validated_at" is null) = ("clinic_pilots"."first_visit_validated_closeout_id" is null)
        and ("clinic_pilots"."clinic_use_validated_at" is null) = ("clinic_pilots"."clinic_use_validated_hash" is null)
        and ("clinic_pilots"."clinic_use_validated_hash" is null or "clinic_pilots"."clinic_use_validated_hash" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint

-- Extend the deferred projection/event invariant to the evidence bindings
-- introduced above. An old attestation cannot validate replacement evidence.
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
      AND e.first_visit_validated_closeout_id IS NOT DISTINCT FROM NEW.first_visit_validated_closeout_id
      AND e.clinic_use_validated_at IS NOT DISTINCT FROM NEW.clinic_use_validated_at
      AND e.clinic_use_validated_hash IS NOT DISTINCT FROM NEW.clinic_use_validated_hash
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
$$;
