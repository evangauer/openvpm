-- Reissue durable subscription cadence operations after canonical clinic close 0108.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '5min';
--> statement-breakpoint
CREATE TYPE "public"."subscription_cadence_operation_state" AS ENUM('reserved', 'inspecting', 'authorized', 'creating_schedule', 'schedule_created', 'configuring_schedule', 'outcome_unknown', 'scheduled', 'applied', 'failed', 'manual_review', 'superseded');--> statement-breakpoint
CREATE TABLE "subscription_cadence_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"practice_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" "subscription_cadence_operation_state" DEFAULT 'reserved' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"from_cadence" varchar(8) NOT NULL,
	"target_cadence" varchar(8) NOT NULL,
	"stripe_customer_id" varchar(64) NOT NULL,
	"stripe_subscription_id" varchar(64) NOT NULL,
	"subscription_generation" integer NOT NULL,
	"subscription_sync_revision" integer NOT NULL,
	"target_location_price_id" varchar(255) NOT NULL,
	"requested_location_quantity" integer NOT NULL,
	"request_fingerprint_sha256" varchar(64) NOT NULL,
	"schedule_create_idempotency_key" varchar(200) NOT NULL,
	"schedule_configure_idempotency_key" varchar(200) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_provider_attempt_at" timestamp with time zone,
	"last_provider_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"authorized_at" timestamp with time zone,
	"provider_snapshot_fingerprint_sha256" varchar(64),
	"current_location_item_id" varchar(255),
	"current_location_price_id" varchar(255),
	"current_location_quantity" integer,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"observed_provider_schedule_id" varchar(255),
	"provider_schedule_id" varchar(255),
	"schedule_created_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"manual_review_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"last_error_code" varchar(64),
	CONSTRAINT "subscription_cadence_operations_request_identity_check" CHECK ("subscription_cadence_operations"."from_cadence" = 'month'
        and "subscription_cadence_operations"."target_cadence" = 'year'
        and length(btrim("subscription_cadence_operations"."stripe_customer_id")) between 1 and 64
        and length(btrim("subscription_cadence_operations"."stripe_subscription_id")) between 1 and 64
        and "subscription_cadence_operations"."subscription_generation" >= 0
        and "subscription_cadence_operations"."subscription_sync_revision" >= 0
        and length(btrim("subscription_cadence_operations"."target_location_price_id")) between 1 and 255
        and "subscription_cadence_operations"."requested_location_quantity" >= 1
        and "subscription_cadence_operations"."request_fingerprint_sha256" ~ '^[0-9a-f]{64}$'
        and length(btrim("subscription_cadence_operations"."schedule_create_idempotency_key")) between 1 and 200
        and length(btrim("subscription_cadence_operations"."schedule_configure_idempotency_key")) between 1 and 200
        and "subscription_cadence_operations"."schedule_create_idempotency_key" <> "subscription_cadence_operations"."schedule_configure_idempotency_key"
        and ("subscription_cadence_operations"."last_error_code" is null or "subscription_cadence_operations"."last_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')),
	CONSTRAINT "subscription_cadence_operations_evidence_shape_check" CHECK ("subscription_cadence_operations"."revision" >= 0
        and "subscription_cadence_operations"."attempt_count" >= 0
        and (("subscription_cadence_operations"."lease_token" is null) = ("subscription_cadence_operations"."lease_expires_at" is null))
        and (
          ("subscription_cadence_operations"."authorized_at" is null
            and "subscription_cadence_operations"."provider_snapshot_fingerprint_sha256" is null
            and "subscription_cadence_operations"."current_location_item_id" is null
            and "subscription_cadence_operations"."current_location_price_id" is null
            and "subscription_cadence_operations"."current_location_quantity" is null
            and "subscription_cadence_operations"."current_period_start" is null
            and "subscription_cadence_operations"."current_period_end" is null)
          or ("subscription_cadence_operations"."authorized_at" is not null
            and "subscription_cadence_operations"."provider_snapshot_fingerprint_sha256" is not null
            and "subscription_cadence_operations"."provider_snapshot_fingerprint_sha256" ~ '^[0-9a-f]{64}$'
            and "subscription_cadence_operations"."current_location_item_id" is not null
            and length(btrim("subscription_cadence_operations"."current_location_item_id")) between 1 and 255
            and "subscription_cadence_operations"."current_location_price_id" is not null
            and length(btrim("subscription_cadence_operations"."current_location_price_id")) between 1 and 255
            and "subscription_cadence_operations"."current_location_quantity" is not null
            and "subscription_cadence_operations"."current_location_quantity" >= 1
            and "subscription_cadence_operations"."current_period_start" is not null
            and "subscription_cadence_operations"."current_period_end" > "subscription_cadence_operations"."current_period_start")
        )
        and (("subscription_cadence_operations"."provider_schedule_id" is null and "subscription_cadence_operations"."schedule_created_at" is null)
          or ("subscription_cadence_operations"."provider_schedule_id" is not null
            and length(btrim("subscription_cadence_operations"."provider_schedule_id")) between 1 and 255
            and "subscription_cadence_operations"."schedule_created_at" is not null))
        and ("subscription_cadence_operations"."observed_provider_schedule_id" is null
          or length(btrim("subscription_cadence_operations"."observed_provider_schedule_id")) between 1 and 255)
        and (("subscription_cadence_operations"."scheduled_at" is null) = ("subscription_cadence_operations"."effective_at" is null))
        and ("subscription_cadence_operations"."applied_at" is null or "subscription_cadence_operations"."applied_at" >= "subscription_cadence_operations"."effective_at")
        and ("subscription_cadence_operations"."first_provider_attempt_at" is null
          or ("subscription_cadence_operations"."last_provider_attempt_at" is not null
            and "subscription_cadence_operations"."last_provider_attempt_at" >= "subscription_cadence_operations"."first_provider_attempt_at"))),
	CONSTRAINT "subscription_cadence_operations_state_check" CHECK ((
        ("subscription_cadence_operations"."state" = 'reserved'
          and "subscription_cadence_operations"."attempt_count" = 0 and "subscription_cadence_operations"."revision" = 0
          and "subscription_cadence_operations"."first_provider_attempt_at" is null and "subscription_cadence_operations"."last_provider_attempt_at" is null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."authorized_at" is null
          and "subscription_cadence_operations"."provider_schedule_id" is null and "subscription_cadence_operations"."scheduled_at" is null
          and "subscription_cadence_operations"."effective_at" is null and "subscription_cadence_operations"."applied_at" is null
          and "subscription_cadence_operations"."failed_at" is null and "subscription_cadence_operations"."manual_review_at" is null
          and "subscription_cadence_operations"."superseded_at" is null and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'inspecting'
          and "subscription_cadence_operations"."attempt_count" >= 1 and "subscription_cadence_operations"."first_provider_attempt_at" is not null
          and "subscription_cadence_operations"."last_provider_attempt_at" is not null and "subscription_cadence_operations"."lease_token" is not null
          and "subscription_cadence_operations"."authorized_at" is null and "subscription_cadence_operations"."provider_schedule_id" is null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'authorized'
          and "subscription_cadence_operations"."attempt_count" >= 1 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."provider_schedule_id" is null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'creating_schedule'
          and "subscription_cadence_operations"."attempt_count" >= 2 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is not null and "subscription_cadence_operations"."provider_schedule_id" is null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'schedule_created'
          and "subscription_cadence_operations"."attempt_count" >= 2 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."provider_schedule_id" is not null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'configuring_schedule'
          and "subscription_cadence_operations"."attempt_count" >= 3 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is not null and "subscription_cadence_operations"."provider_schedule_id" is not null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'outcome_unknown'
          and "subscription_cadence_operations"."attempt_count" >= 2 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."scheduled_at" is null
          and "subscription_cadence_operations"."effective_at" is null and "subscription_cadence_operations"."applied_at" is null
          and "subscription_cadence_operations"."failed_at" is null and "subscription_cadence_operations"."manual_review_at" is null
          and "subscription_cadence_operations"."superseded_at" is null and "subscription_cadence_operations"."last_error_code" is not null)
        or ("subscription_cadence_operations"."state" = 'scheduled'
          and "subscription_cadence_operations"."attempt_count" >= 3 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."provider_schedule_id" is not null
          and "subscription_cadence_operations"."scheduled_at" is not null and "subscription_cadence_operations"."effective_at" = "subscription_cadence_operations"."current_period_end"
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'applied'
          and "subscription_cadence_operations"."attempt_count" >= 3 and "subscription_cadence_operations"."authorized_at" is not null
          and "subscription_cadence_operations"."lease_token" is null and "subscription_cadence_operations"."provider_schedule_id" is not null
          and "subscription_cadence_operations"."scheduled_at" is not null and "subscription_cadence_operations"."effective_at" = "subscription_cadence_operations"."current_period_end"
          and "subscription_cadence_operations"."applied_at" is not null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is null)
        or ("subscription_cadence_operations"."state" = 'failed'
          and "subscription_cadence_operations"."attempt_count" >= 1 and "subscription_cadence_operations"."lease_token" is null
          and "subscription_cadence_operations"."scheduled_at" is null and "subscription_cadence_operations"."effective_at" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is not null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is not null)
        or ("subscription_cadence_operations"."state" = 'manual_review'
          and "subscription_cadence_operations"."attempt_count" >= 1 and "subscription_cadence_operations"."lease_token" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is not null and "subscription_cadence_operations"."superseded_at" is null
          and "subscription_cadence_operations"."last_error_code" is not null)
        or ("subscription_cadence_operations"."state" = 'superseded'
          and "subscription_cadence_operations"."attempt_count" >= 0 and "subscription_cadence_operations"."lease_token" is null
          and "subscription_cadence_operations"."applied_at" is null and "subscription_cadence_operations"."failed_at" is null
          and "subscription_cadence_operations"."manual_review_at" is null and "subscription_cadence_operations"."superseded_at" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "subscription_cadence_operations" ADD CONSTRAINT "subscription_cadence_operations_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_cadence_operations" ADD CONSTRAINT "subscription_cadence_operations_requester_tenant_fk" FOREIGN KEY ("practice_id","requested_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cadence_operations_practice_id_uq" ON "subscription_cadence_operations" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cadence_operations_create_idempotency_uq" ON "subscription_cadence_operations" USING btree ("schedule_create_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cadence_operations_configure_idempotency_uq" ON "subscription_cadence_operations" USING btree ("schedule_configure_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cadence_operations_provider_schedule_uq" ON "subscription_cadence_operations" USING btree ("provider_schedule_id") WHERE "subscription_cadence_operations"."provider_schedule_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_cadence_operations_one_active_uq" ON "subscription_cadence_operations" USING btree ("practice_id") WHERE "subscription_cadence_operations"."state" in ('reserved', 'inspecting', 'authorized', 'creating_schedule', 'schedule_created', 'configuring_schedule', 'outcome_unknown', 'scheduled', 'manual_review');--> statement-breakpoint
CREATE INDEX "subscription_cadence_operations_history_idx" ON "subscription_cadence_operations" USING btree ("practice_id","created_at","id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.validate_subscription_cadence_operation_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
DECLARE
  practice_row record;
BEGIN
  SELECT
    p.deleted_at,
    p.recovery_hold,
    p.billing_status,
    p.stripe_customer_id,
    p.stripe_subscription_id,
    p.subscription_generation,
    p.stripe_subscription_sync_revision,
    p.stripe_quantity_sync_lease_token
  INTO practice_row
  FROM public.practices p
  WHERE p.id = NEW.practice_id
  FOR UPDATE;

  IF NOT FOUND OR practice_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Subscription cadence change requires an active practice.';
  END IF;
  IF practice_row.recovery_hold THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Subscription cadence change is blocked during protected recovery.';
  END IF;
  IF practice_row.billing_status NOT IN ('active', 'trialing')
    OR practice_row.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
    OR practice_row.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id
    OR practice_row.subscription_generation IS DISTINCT FROM NEW.subscription_generation
    OR practice_row.stripe_subscription_sync_revision IS DISTINCT FROM NEW.subscription_sync_revision
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Subscription cadence request identity is stale or ineligible.';
  END IF;
  IF practice_row.stripe_quantity_sync_lease_token IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence change must wait for quantity reconciliation.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.practice_id = NEW.practice_id
      AND u.id = NEW.requested_by
      AND u.role = 'admin'
      AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Subscription cadence change requires an active clinic administrator.';
  END IF;
  RETURN NEW;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER subscription_cadence_operations_validate_insert
  BEFORE INSERT ON public.subscription_cadence_operations
  FOR EACH ROW EXECUTE FUNCTION public.validate_subscription_cadence_operation_insert();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_subscription_cadence_operation_insert() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_subscription_cadence_operation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence operations cannot be deleted.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.from_cadence IS DISTINCT FROM OLD.from_cadence
    OR NEW.target_cadence IS DISTINCT FROM OLD.target_cadence
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.subscription_generation IS DISTINCT FROM OLD.subscription_generation
    OR NEW.subscription_sync_revision IS DISTINCT FROM OLD.subscription_sync_revision
    OR NEW.target_location_price_id IS DISTINCT FROM OLD.target_location_price_id
    OR NEW.requested_location_quantity IS DISTINCT FROM OLD.requested_location_quantity
    OR NEW.request_fingerprint_sha256 IS DISTINCT FROM OLD.request_fingerprint_sha256
    OR NEW.schedule_create_idempotency_key IS DISTINCT FROM OLD.schedule_create_idempotency_key
    OR NEW.schedule_configure_idempotency_key IS DISTINCT FROM OLD.schedule_configure_idempotency_key
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence request identity is immutable.';
  END IF;

  IF NEW.revision IS DISTINCT FROM OLD.revision + 1
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence operation updates require the next revision and database time.';
  END IF;

  IF OLD.first_provider_attempt_at IS NOT NULL
    AND NEW.first_provider_attempt_at IS DISTINCT FROM OLD.first_provider_attempt_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence first provider attempt is immutable.';
  END IF;

  IF OLD.authorized_at IS NOT NULL AND (
    NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
    OR NEW.provider_snapshot_fingerprint_sha256 IS DISTINCT FROM OLD.provider_snapshot_fingerprint_sha256
    OR NEW.current_location_item_id IS DISTINCT FROM OLD.current_location_item_id
    OR NEW.current_location_price_id IS DISTINCT FROM OLD.current_location_price_id
    OR NEW.current_location_quantity IS DISTINCT FROM OLD.current_location_quantity
    OR NEW.current_period_start IS DISTINCT FROM OLD.current_period_start
    OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Authorized Subscription cadence provider evidence is immutable.';
  END IF;
  IF OLD.authorized_at IS NULL AND NEW.authorized_at IS NOT NULL
    AND NOT (OLD.state = 'inspecting' AND NEW.state = 'authorized')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence evidence requires an inspecting-to-authorized transition.';
  END IF;

  IF OLD.observed_provider_schedule_id IS NOT NULL
    AND NEW.observed_provider_schedule_id IS DISTINCT FROM OLD.observed_provider_schedule_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Observed Subscription schedule identity is immutable.';
  END IF;
  IF OLD.observed_provider_schedule_id IS NULL
    AND NEW.observed_provider_schedule_id IS NOT NULL
    AND NOT (OLD.state = 'inspecting' AND NEW.state = 'manual_review')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'An attached Subscription schedule requires manual review from provider inspection.';
  END IF;
  IF OLD.provider_schedule_id IS NOT NULL AND (
    NEW.provider_schedule_id IS DISTINCT FROM OLD.provider_schedule_id
    OR NEW.schedule_created_at IS DISTINCT FROM OLD.schedule_created_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Owned Subscription schedule identity is immutable.';
  END IF;
  IF OLD.provider_schedule_id IS NULL AND NEW.provider_schedule_id IS NOT NULL
    AND NOT (OLD.state = 'creating_schedule' AND NEW.state = 'schedule_created')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription schedule identity requires a committed creation transition.';
  END IF;

  IF OLD.scheduled_at IS NOT NULL AND (
    NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Scheduled Subscription cadence evidence is immutable.';
  END IF;
  IF OLD.scheduled_at IS NULL AND NEW.scheduled_at IS NOT NULL
    AND NOT (OLD.state = 'configuring_schedule' AND NEW.state = 'scheduled')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription cadence effectiveness requires a configuring-to-scheduled transition.';
  END IF;

  IF OLD.state IN ('applied', 'failed', 'superseded') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Terminal Subscription cadence operations are immutable.';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('inspecting', 'failed', 'manual_review', 'superseded'))
    OR (OLD.state = 'inspecting' AND NEW.state IN ('authorized', 'failed', 'manual_review', 'superseded'))
    OR (OLD.state = 'authorized' AND NEW.state IN ('creating_schedule', 'manual_review', 'superseded'))
    OR (OLD.state = 'creating_schedule' AND NEW.state IN ('schedule_created', 'outcome_unknown', 'manual_review', 'superseded'))
    OR (OLD.state = 'schedule_created' AND NEW.state IN ('configuring_schedule', 'manual_review', 'superseded'))
    OR (OLD.state = 'configuring_schedule' AND NEW.state IN ('scheduled', 'outcome_unknown', 'manual_review', 'superseded'))
    OR (OLD.state = 'outcome_unknown' AND (
      (NEW.state = 'creating_schedule' AND OLD.provider_schedule_id IS NULL)
      OR (NEW.state = 'configuring_schedule' AND OLD.provider_schedule_id IS NOT NULL)
      OR NEW.state IN ('manual_review', 'superseded')
    ))
    OR (OLD.state = 'scheduled' AND NEW.state IN ('applied', 'manual_review', 'superseded'))
    OR (OLD.state = 'manual_review' AND NEW.state = 'superseded')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Invalid Subscription cadence operation state transition.';
  END IF;

  RETURN NEW;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER subscription_cadence_operations_state_guard
  BEFORE UPDATE OR DELETE ON public.subscription_cadence_operations
  FOR EACH ROW EXECUTE FUNCTION public.guard_subscription_cadence_operation_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_subscription_cadence_operation_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_practice_during_subscription_cadence_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.subscription_cadence_operations
    WHERE practice_id = OLD.id
      AND state IN ('inspecting', 'creating_schedule', 'schedule_created', 'configuring_schedule', 'outcome_unknown')
  ) AND (
    TG_OP = 'DELETE'
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.recovery_hold IS DISTINCT FROM OLD.recovery_hold
    OR NEW.billing_status IS DISTINCT FROM OLD.billing_status
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.subscription_generation IS DISTINCT FROM OLD.subscription_generation
    OR NEW.stripe_subscription_sync_revision IS DISTINCT FROM OLD.stripe_subscription_sync_revision
    OR NEW.stripe_quantity_sync_lease_token IS DISTINCT FROM OLD.stripe_quantity_sync_lease_token
    OR NEW.stripe_quantity_sync_lease_expires_at IS DISTINCT FROM OLD.stripe_quantity_sync_lease_expires_at
    OR NEW.stripe_quantity_sync_requested_revision IS DISTINCT FROM OLD.stripe_quantity_sync_requested_revision
    OR NEW.stripe_quantity_sync_completed_revision IS DISTINCT FROM OLD.stripe_quantity_sync_completed_revision
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Practice billing identity is locked during Subscription cadence provider dispatch.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER practices_subscription_cadence_dispatch_guard
  BEFORE UPDATE OR DELETE ON public.practices
  FOR EACH ROW EXECUTE FUNCTION public.guard_practice_during_subscription_cadence_dispatch();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_practice_during_subscription_cadence_dispatch() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_locations_during_subscription_cadence_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
DECLARE
  affected_practice_id uuid;
BEGIN
  affected_practice_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.practice_id ELSE OLD.practice_id END;
  IF EXISTS (
    SELECT 1 FROM public.subscription_cadence_operations
    WHERE practice_id = affected_practice_id
      AND state IN ('inspecting', 'creating_schedule', 'schedule_created', 'configuring_schedule', 'outcome_unknown')
  ) AND (
    TG_OP IN ('INSERT', 'DELETE')
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Billable location quantity is locked during Subscription cadence provider dispatch.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER locations_subscription_cadence_dispatch_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.guard_locations_during_subscription_cadence_dispatch();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_locations_during_subscription_cadence_dispatch() FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.subscription_cadence_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscription_cadence_operations
  USING (public.app_rls_bypass() OR practice_id = public.app_current_practice_id())
  WITH CHECK (public.app_rls_bypass() OR practice_id = public.app_current_practice_id());
--> statement-breakpoint
REVOKE ALL ON public.subscription_cadence_operations FROM PUBLIC;
--> statement-breakpoint
DO $body$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.subscription_cadence_operations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.subscription_cadence_operations FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON public.subscription_cadence_operations FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON public.subscription_cadence_operations TO openpims_app;
  END IF;
END;
$body$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_subscription_cadence_operation_insert()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_subscription_cadence_operation_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_practice_during_subscription_cadence_dispatch()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_locations_during_subscription_cadence_dispatch()
  FROM PUBLIC;
