CREATE TYPE "public"."subscription_checkout_attempt_state" AS ENUM('reserved', 'creating', 'outcome_unknown', 'manual_review', 'open', 'completed', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "subscription_checkout_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"practice_id" uuid NOT NULL,
	"state" "subscription_checkout_attempt_state" DEFAULT 'reserved' NOT NULL,
	"source" varchar(16) NOT NULL,
	"billing_cadence" varchar(8) NOT NULL,
	"return_target" varchar(16) NOT NULL,
	"location_price_id" varchar(255) NOT NULL,
	"location_quantity" integer NOT NULL,
	"customer_id" varchar(64),
	"customer_email" varchar(255),
	"customer_identity_source" varchar(24) NOT NULL,
	"customer_identity_user_id" uuid,
	"trial_end" timestamp with time zone,
	"trial_period_days" integer,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"provider_idempotency_key" varchar(200) NOT NULL,
	"request_fingerprint_sha256" varchar(64) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_provider_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"provider_session_id" varchar(255),
	"provider_expires_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	CONSTRAINT "subscription_checkout_attempts_identity_check" CHECK ("subscription_checkout_attempts"."source" in ('signup', 'settings')
        and "subscription_checkout_attempts"."billing_cadence" in ('month', 'year')
        and (
          ("subscription_checkout_attempts"."source" = 'signup' and "subscription_checkout_attempts"."return_target" = 'login')
          or ("subscription_checkout_attempts"."source" = 'settings' and "subscription_checkout_attempts"."return_target" in ('settings', 'setup'))
        )
        and length(btrim("subscription_checkout_attempts"."location_price_id")) between 1 and 255
        and "subscription_checkout_attempts"."location_quantity" >= 1
        and "subscription_checkout_attempts"."customer_identity_source" in ('stripe_customer', 'practice_email', 'user_email')
        and (
          ("subscription_checkout_attempts"."customer_identity_source" = 'stripe_customer'
            and "subscription_checkout_attempts"."customer_id" is not null and "subscription_checkout_attempts"."customer_email" is null
            and "subscription_checkout_attempts"."customer_identity_user_id" is null)
          or ("subscription_checkout_attempts"."customer_identity_source" = 'practice_email'
            and "subscription_checkout_attempts"."customer_id" is null and "subscription_checkout_attempts"."customer_email" is not null
            and "subscription_checkout_attempts"."customer_identity_user_id" is null)
          or ("subscription_checkout_attempts"."customer_identity_source" = 'user_email'
            and "subscription_checkout_attempts"."customer_id" is null and "subscription_checkout_attempts"."customer_email" is not null
            and "subscription_checkout_attempts"."customer_identity_user_id" is not null)
        )
        and ("subscription_checkout_attempts"."customer_id" is null or length(btrim("subscription_checkout_attempts"."customer_id")) between 1 and 64)
        and ("subscription_checkout_attempts"."customer_email" is null or (
          length(btrim("subscription_checkout_attempts"."customer_email")) between 3 and 255
          and "subscription_checkout_attempts"."customer_email" = lower(btrim("subscription_checkout_attempts"."customer_email"))
        ))
        and num_nonnulls("subscription_checkout_attempts"."trial_end", "subscription_checkout_attempts"."trial_period_days") <= 1
        and ("subscription_checkout_attempts"."trial_period_days" is null or "subscription_checkout_attempts"."trial_period_days" >= 1)
        and length("subscription_checkout_attempts"."success_url") between 1 and 2048
        and length("subscription_checkout_attempts"."cancel_url") between 1 and 2048
        and length(btrim("subscription_checkout_attempts"."provider_idempotency_key")) between 1 and 200
        and "subscription_checkout_attempts"."request_fingerprint_sha256" ~ '^[0-9a-f]{64}$'
        and ("subscription_checkout_attempts"."last_error_code" is null or "subscription_checkout_attempts"."last_error_code" ~ '^[A-Za-z0-9_.:-]{1,64}$')),
	CONSTRAINT "subscription_checkout_attempts_state_check" CHECK ("subscription_checkout_attempts"."attempt_count" >= 0 and (
        ("subscription_checkout_attempts"."state" = 'reserved'
          and "subscription_checkout_attempts"."attempt_count" = 0
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."last_attempt_at" is null and "subscription_checkout_attempts"."provider_session_id" is null
          and "subscription_checkout_attempts"."first_provider_attempt_at" is null and "subscription_checkout_attempts"."provider_expires_at" is null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null and "subscription_checkout_attempts"."last_error_code" is null)
        or ("subscription_checkout_attempts"."state" = 'creating'
          and "subscription_checkout_attempts"."attempt_count" >= 1
          and "subscription_checkout_attempts"."lease_token" is not null and "subscription_checkout_attempts"."lease_expires_at" is not null
          and "subscription_checkout_attempts"."first_provider_attempt_at" is not null and "subscription_checkout_attempts"."last_attempt_at" is not null
          and "subscription_checkout_attempts"."provider_session_id" is null and "subscription_checkout_attempts"."provider_expires_at" is null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null and "subscription_checkout_attempts"."last_error_code" is null)
        or ("subscription_checkout_attempts"."state" = 'outcome_unknown'
          and "subscription_checkout_attempts"."attempt_count" >= 1
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."first_provider_attempt_at" is not null and "subscription_checkout_attempts"."last_attempt_at" is not null
          and "subscription_checkout_attempts"."provider_session_id" is null and "subscription_checkout_attempts"."provider_expires_at" is null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null and "subscription_checkout_attempts"."last_error_code" is not null)
        or ("subscription_checkout_attempts"."state" = 'manual_review'
          and "subscription_checkout_attempts"."attempt_count" >= 1
          and "subscription_checkout_attempts"."first_provider_attempt_at" is not null and "subscription_checkout_attempts"."last_attempt_at" is not null
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and num_nonnulls("subscription_checkout_attempts"."provider_session_id", "subscription_checkout_attempts"."provider_expires_at") in (0, 2)
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null and "subscription_checkout_attempts"."last_error_code" is not null)
        or ("subscription_checkout_attempts"."state" = 'open'
          and "subscription_checkout_attempts"."attempt_count" >= 1
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."first_provider_attempt_at" is not null and "subscription_checkout_attempts"."last_attempt_at" is not null
          and "subscription_checkout_attempts"."provider_session_id" is not null and "subscription_checkout_attempts"."provider_expires_at" is not null
          and "subscription_checkout_attempts"."last_reconciled_at" is not null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null)
        or ("subscription_checkout_attempts"."state" = 'completed'
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."provider_session_id" is not null
          and "subscription_checkout_attempts"."completed_at" is not null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is null)
        or ("subscription_checkout_attempts"."state" = 'expired'
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."expired_at" is not null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."failed_at" is null)
        or ("subscription_checkout_attempts"."state" = 'failed'
          and "subscription_checkout_attempts"."lease_token" is null and "subscription_checkout_attempts"."lease_expires_at" is null
          and "subscription_checkout_attempts"."provider_session_id" is null
          and "subscription_checkout_attempts"."completed_at" is null and "subscription_checkout_attempts"."expired_at" is null
          and "subscription_checkout_attempts"."failed_at" is not null and "subscription_checkout_attempts"."last_error_code" is not null)
      ))
);
--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "stripe_subscription_sync_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "stripe_quantity_sync_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "stripe_quantity_sync_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "stripe_quantity_sync_requested_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "stripe_quantity_sync_completed_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_state" varchar(16);--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_revision" integer;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_reconciliation_subscription_id" varchar(128);--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_state" varchar(16);--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD COLUMN "subscription_quantity_sync_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription_checkout_attempts" ADD CONSTRAINT "subscription_checkout_attempts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_attempts_practice_id_uq" ON "subscription_checkout_attempts" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_attempts_provider_idempotency_uq" ON "subscription_checkout_attempts" USING btree ("provider_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_attempts_provider_session_uq" ON "subscription_checkout_attempts" USING btree ("provider_session_id") WHERE "subscription_checkout_attempts"."provider_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkout_attempts_one_active_uq" ON "subscription_checkout_attempts" USING btree ("practice_id") WHERE "subscription_checkout_attempts"."state" in ('reserved', 'creating', 'outcome_unknown', 'manual_review', 'open');--> statement-breakpoint
CREATE INDEX "subscription_checkout_attempts_history_idx" ON "subscription_checkout_attempts" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE INDEX "subscription_checkout_attempts_customer_identity_user_idx" ON "subscription_checkout_attempts" USING btree ("practice_id","customer_identity_user_id");--> statement-breakpoint
CREATE INDEX "stripe_events_pending_subscription_quantity_sync_idx" ON "stripe_events" USING btree ("subscription_quantity_sync_lease_expires_at","event_id") WHERE "stripe_events"."subscription_quantity_sync_state" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_stripe_subscription_sync_revision_check" CHECK ("practices"."stripe_subscription_sync_revision" >= 0);--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_stripe_quantity_sync_lease_shape_check" CHECK (("practices"."stripe_quantity_sync_lease_token" is null) = ("practices"."stripe_quantity_sync_lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_stripe_quantity_sync_revision_check" CHECK ("practices"."stripe_quantity_sync_requested_revision" >= 0 and "practices"."stripe_quantity_sync_completed_revision" >= 0 and "practices"."stripe_quantity_sync_completed_revision" <= "practices"."stripe_quantity_sync_requested_revision");--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_subscription_reconciliation_shape_check" CHECK ((
        "stripe_events"."subscription_reconciliation_state" is null and
        "stripe_events"."subscription_reconciliation_attempts" = 0 and
        "stripe_events"."subscription_reconciliation_revision" is null and
        "stripe_events"."subscription_reconciliation_authorized_at" is null and
        "stripe_events"."subscription_reconciliation_resolved_at" is null and
        "stripe_events"."subscription_reconciliation_subscription_id" is null
      ) or (
        "stripe_events"."subscription_reconciliation_state" in ('authorized', 'applied', 'superseded') and
        "stripe_events"."practice_id" is not null and
        "stripe_events"."subscription_reconciliation_subscription_id" is not null and
        length(btrim("stripe_events"."subscription_reconciliation_subscription_id")) > 0 and
        "stripe_events"."subscription_reconciliation_attempts" > 0 and
        "stripe_events"."subscription_reconciliation_revision" is not null and
        "stripe_events"."subscription_reconciliation_revision" > 0 and
        "stripe_events"."subscription_reconciliation_authorized_at" is not null and
        (("stripe_events"."subscription_reconciliation_state" = 'authorized' and "stripe_events"."subscription_reconciliation_resolved_at" is null) or
         ("stripe_events"."subscription_reconciliation_state" in ('applied', 'superseded') and "stripe_events"."subscription_reconciliation_resolved_at" is not null))
      ));--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_subscription_quantity_sync_shape_check" CHECK ((
        "stripe_events"."subscription_quantity_sync_state" is null and
        "stripe_events"."subscription_quantity_sync_attempts" = 0 and
        "stripe_events"."subscription_quantity_sync_lease_token" is null and
        "stripe_events"."subscription_quantity_sync_lease_expires_at" is null and
        "stripe_events"."subscription_quantity_sync_last_attempt_at" is null and
        "stripe_events"."subscription_quantity_sync_completed_at" is null
      ) or (
        "stripe_events"."subscription_quantity_sync_state" = 'pending' and
        "stripe_events"."subscription_reconciliation_state" = 'applied' and
        "stripe_events"."subscription_quantity_sync_lease_token" is null and
        "stripe_events"."subscription_quantity_sync_lease_expires_at" is null and
        "stripe_events"."subscription_quantity_sync_completed_at" is null
      ) or (
        "stripe_events"."subscription_quantity_sync_state" = 'running' and
        "stripe_events"."subscription_reconciliation_state" = 'applied' and
        "stripe_events"."subscription_quantity_sync_attempts" > 0 and
        "stripe_events"."subscription_quantity_sync_lease_token" is not null and
        "stripe_events"."subscription_quantity_sync_lease_expires_at" is not null and
        "stripe_events"."subscription_quantity_sync_last_attempt_at" is not null and
        "stripe_events"."subscription_quantity_sync_completed_at" is null
      ) or (
        "stripe_events"."subscription_quantity_sync_state" = 'completed' and
        "stripe_events"."subscription_reconciliation_state" = 'applied' and
        "stripe_events"."subscription_quantity_sync_attempts" > 0 and
        "stripe_events"."subscription_quantity_sync_lease_token" is null and
        "stripe_events"."subscription_quantity_sync_lease_expires_at" is null and
        "stripe_events"."subscription_quantity_sync_last_attempt_at" is not null and
        "stripe_events"."subscription_quantity_sync_completed_at" is not null and
        "stripe_events"."subscription_quantity_sync_completed_at" >= "stripe_events"."subscription_quantity_sync_last_attempt_at"
      ));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_subscription_checkout_user_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF NEW.customer_identity_source = 'user_email' AND NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE practice_id = NEW.practice_id
      AND id = NEW.customer_identity_user_id
      AND deleted_at IS NULL
      AND email = NEW.customer_email
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Subscription Checkout user billing identity must reference an active tenant user with the captured email.';
  END IF;
  RETURN NEW;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER subscription_checkout_attempts_user_identity_check
  BEFORE INSERT ON subscription_checkout_attempts
  FOR EACH ROW EXECUTE FUNCTION validate_subscription_checkout_user_identity();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.validate_subscription_checkout_user_identity() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_subscription_checkout_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription Checkout attempts cannot be deleted.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.billing_cadence IS DISTINCT FROM OLD.billing_cadence
    OR NEW.return_target IS DISTINCT FROM OLD.return_target
    OR NEW.location_price_id IS DISTINCT FROM OLD.location_price_id
    OR NEW.location_quantity IS DISTINCT FROM OLD.location_quantity
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.customer_email IS DISTINCT FROM OLD.customer_email
    OR NEW.customer_identity_source IS DISTINCT FROM OLD.customer_identity_source
    OR NEW.customer_identity_user_id IS DISTINCT FROM OLD.customer_identity_user_id
    OR NEW.trial_end IS DISTINCT FROM OLD.trial_end
    OR NEW.trial_period_days IS DISTINCT FROM OLD.trial_period_days
    OR NEW.success_url IS DISTINCT FROM OLD.success_url
    OR NEW.cancel_url IS DISTINCT FROM OLD.cancel_url
    OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key
    OR NEW.request_fingerprint_sha256 IS DISTINCT FROM OLD.request_fingerprint_sha256
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription Checkout attempt request identity is immutable.';
  END IF;

  IF OLD.first_provider_attempt_at IS NOT NULL
    AND NEW.first_provider_attempt_at IS DISTINCT FROM OLD.first_provider_attempt_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription Checkout first provider attempt is immutable.';
  END IF;

  IF OLD.state IN ('completed', 'expired', 'failed') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Terminal Subscription Checkout attempts are immutable.';
  END IF;

  IF OLD.provider_session_id IS NOT NULL
    AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Subscription Checkout provider identity is immutable.';
  END IF;

  RETURN NEW;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER subscription_checkout_attempts_state_guard
  BEFORE UPDATE OR DELETE ON subscription_checkout_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_subscription_checkout_attempt_mutation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_subscription_checkout_attempt_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_practice_during_subscription_checkout_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.subscription_checkout_attempts
    WHERE practice_id = OLD.id AND state = 'creating'
  ) AND (
    TG_OP = 'DELETE'
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.recovery_hold IS DISTINCT FROM OLD.recovery_hold
    OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
    OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.email IS DISTINCT FROM OLD.email
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Practice billing identity is locked during Subscription Checkout dispatch.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER practices_subscription_checkout_dispatch_guard
  BEFORE UPDATE OR DELETE ON practices
  FOR EACH ROW EXECUTE FUNCTION guard_practice_during_subscription_checkout_dispatch();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_practice_during_subscription_checkout_dispatch() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_user_during_subscription_checkout_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.subscription_checkout_attempts
    WHERE practice_id = OLD.practice_id
      AND customer_identity_user_id = OLD.id
      AND customer_identity_source = 'user_email'
      AND state = 'creating'
  ) AND (
    TG_OP = 'DELETE'
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'User billing identity is locked during Subscription Checkout dispatch.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER users_subscription_checkout_dispatch_guard
  BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_user_during_subscription_checkout_dispatch();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_user_during_subscription_checkout_dispatch() FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE public.subscription_checkout_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.subscription_checkout_attempts
  USING (public.app_rls_bypass() OR practice_id = public.app_current_practice_id())
  WITH CHECK (public.app_rls_bypass() OR practice_id = public.app_current_practice_id());
--> statement-breakpoint
REVOKE ALL ON public.subscription_checkout_attempts FROM PUBLIC;
--> statement-breakpoint
DO $body$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.subscription_checkout_attempts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.subscription_checkout_attempts FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON public.subscription_checkout_attempts FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON public.subscription_checkout_attempts TO openpims_app;
  END IF;
END
$body$;
