CREATE TYPE "public"."messaging_registration_actor_type" AS ENUM('clinic_user', 'platform_operator', 'system');--> statement-breakpoint
CREATE TYPE "public"."messaging_registration_event_type" AS ENUM('details_saved', 'provider_operation_started', 'provider_operation_succeeded', 'provider_operation_failed', 'provider_state_observed', 'provider_ids_attached', 'stale_lock_cleared', 'provider_profile_enabled', 'provider_profile_disabled', 'provider_profile_verified');--> statement-breakpoint
CREATE TYPE "public"."messaging_registration_operation" AS ENUM('registration_details', 'brand_submission', 'campaign_submission', 'number_assignment', 'registration_reconciliation', 'provider_id_recovery', 'submission_lock_recovery', 'profile_activation', 'profile_deactivation', 'profile_verification');--> statement-breakpoint
CREATE TABLE "messaging_registration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"location_id" uuid,
	"event_type" "messaging_registration_event_type" NOT NULL,
	"operation" "messaging_registration_operation" NOT NULL,
	"status_before" "messaging_registration_status",
	"status_after" "messaging_registration_status" NOT NULL,
	"provider" varchar(16) NOT NULL,
	"provider_brand_id" varchar(128),
	"provider_campaign_id" varchar(128),
	"messaging_profile_id" varchar(128),
	"provider_brand_status" varchar(64),
	"provider_campaign_status" varchar(64),
	"actor_type" "messaging_registration_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_identity" varchar(255),
	"actor_name" varchar(255) NOT NULL,
	"operation_id" uuid NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	CONSTRAINT "messaging_registration_events_shape_check" CHECK ("messaging_registration_events"."provider" in ('telnyx', 'twilio')
        and "messaging_registration_events"."reason_code" ~ '^[a-z0-9_]{3,64}$'
        and "messaging_registration_events"."actor_name" = btrim("messaging_registration_events"."actor_name")
        and length("messaging_registration_events"."actor_name") between 1 and 255
        and (
          ("messaging_registration_events"."actor_type" = 'clinic_user'
            and "messaging_registration_events"."actor_user_id" is not null
            and "messaging_registration_events"."actor_identity" is null)
          or ("messaging_registration_events"."actor_type" = 'platform_operator'
            and "messaging_registration_events"."actor_user_id" is null
            and length(btrim(coalesce("messaging_registration_events"."actor_identity", ''))) between 1 and 255)
          or ("messaging_registration_events"."actor_type" = 'system'
            and "messaging_registration_events"."actor_user_id" is null
            and "messaging_registration_events"."actor_identity" is null)
        )
        and ("messaging_registration_events"."provider_brand_id" is null or (
          "messaging_registration_events"."provider_brand_id" = btrim("messaging_registration_events"."provider_brand_id")
          and length("messaging_registration_events"."provider_brand_id") between 3 and 128))
        and ("messaging_registration_events"."provider_campaign_id" is null or (
          "messaging_registration_events"."provider_campaign_id" = btrim("messaging_registration_events"."provider_campaign_id")
          and length("messaging_registration_events"."provider_campaign_id") between 3 and 128))
        and ("messaging_registration_events"."messaging_profile_id" is null or (
          "messaging_registration_events"."messaging_profile_id" = btrim("messaging_registration_events"."messaging_profile_id")
          and length("messaging_registration_events"."messaging_profile_id") between 3 and 128))
        and ("messaging_registration_events"."provider_brand_status" is null
          or length("messaging_registration_events"."provider_brand_status") between 1 and 64)
        and ("messaging_registration_events"."provider_campaign_status" is null
          or length("messaging_registration_events"."provider_campaign_status") between 1 and 64)
        and (
          ("messaging_registration_events"."event_type" = 'details_saved'
            and "messaging_registration_events"."operation" = 'registration_details')
          or ("messaging_registration_events"."event_type" in (
              'provider_operation_started',
              'provider_operation_succeeded',
              'provider_operation_failed'
            ) and "messaging_registration_events"."operation" in (
              'brand_submission',
              'campaign_submission',
              'number_assignment'
            ))
          or ("messaging_registration_events"."event_type" = 'provider_state_observed'
            and "messaging_registration_events"."operation" in (
              'brand_submission',
              'campaign_submission',
              'registration_reconciliation'
            ))
          or ("messaging_registration_events"."event_type" = 'provider_ids_attached'
            and "messaging_registration_events"."operation" = 'provider_id_recovery')
          or ("messaging_registration_events"."event_type" = 'stale_lock_cleared'
            and "messaging_registration_events"."operation" = 'submission_lock_recovery')
          or ("messaging_registration_events"."event_type" = 'provider_profile_enabled'
            and "messaging_registration_events"."operation" = 'profile_activation'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
          or ("messaging_registration_events"."event_type" = 'provider_profile_disabled'
            and "messaging_registration_events"."operation" = 'profile_deactivation'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
          or ("messaging_registration_events"."event_type" = 'provider_profile_verified'
            and "messaging_registration_events"."operation" = 'profile_verification'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
        ))
);
--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_registration_id_messaging_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."messaging_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_registrations_practice_id_uq" ON "messaging_registrations" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_registration_tenant_fk" FOREIGN KEY ("practice_id","registration_id") REFERENCES "public"."messaging_registrations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messaging_registration_events_registration_history_idx" ON "messaging_registration_events" USING btree ("practice_id","registration_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messaging_registration_events_practice_time_idx" ON "messaging_registration_events" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_registration_events_operation_event_uq" ON "messaging_registration_events" USING btree ("practice_id","operation_id","event_type");--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_messaging_registration_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	registration public.messaging_registrations%ROWTYPE;
	latest_status public.messaging_registration_status;
BEGIN
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'messaging-registration-event:' || NEW.practice_id::text || ':' || NEW.registration_id::text,
			0
		)
	);

	SELECT * INTO registration
	FROM public.messaging_registrations
	WHERE id = NEW.registration_id
		AND practice_id = NEW.practice_id
		AND deleted_at IS NULL
	FOR KEY SHARE;

	IF registration.id IS NULL
		OR NEW.created_at > pg_catalog.now()
		OR NEW.provider IS DISTINCT FROM registration.provider
		OR NEW.status_after IS DISTINCT FROM registration.status
		OR NEW.provider_brand_id IS DISTINCT FROM registration.provider_brand_id
		OR NEW.provider_campaign_id IS DISTINCT FROM registration.provider_campaign_id
		OR NEW.provider_brand_status IS DISTINCT FROM registration.provider_brand_status
		OR NEW.provider_campaign_status IS DISTINCT FROM registration.provider_campaign_status
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Messaging registration event must match the exact active carrier projection.';
	END IF;

	IF NEW.location_id IS NOT NULL AND NOT EXISTS (
		SELECT 1
		FROM public.location_messaging AS sender
		WHERE sender.practice_id = NEW.practice_id
			AND sender.location_id = NEW.location_id
			AND sender.provider = NEW.provider
			AND sender.deleted_at IS NULL
			AND (
				NEW.messaging_profile_id IS NULL
				OR sender.messaging_profile_id = NEW.messaging_profile_id
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Messaging registration event location must match the exact active sender projection.';
	END IF;

	SELECT event.status_after INTO latest_status
	FROM public.messaging_registration_events AS event
	WHERE event.practice_id = NEW.practice_id
		AND event.registration_id = NEW.registration_id
	ORDER BY event.created_at DESC, event.id DESC
	LIMIT 1;

	IF FOUND AND NEW.status_before IS DISTINCT FROM latest_status THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'Messaging registration event must continue the durable carrier status chain.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER messaging_registration_events_validate
BEFORE INSERT ON messaging_registration_events
FOR EACH ROW EXECUTE FUNCTION validate_messaging_registration_event_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_messaging_registration_event_mutation()
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
		MESSAGE = 'Messaging registration events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER messaging_registration_events_immutable
BEFORE UPDATE OR DELETE ON messaging_registration_events
FOR EACH ROW EXECUTE FUNCTION reject_messaging_registration_event_mutation();--> statement-breakpoint
ALTER TABLE messaging_registration_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON messaging_registration_events
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
		REVOKE ALL ON messaging_registration_events FROM openpims_app;
		GRANT SELECT, INSERT ON messaging_registration_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON messaging_registration_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON messaging_registration_events FROM authenticated;
	END IF;
END
$$;
