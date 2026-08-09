CREATE TYPE "public"."sms_consent_action" AS ENUM('granted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."sms_consent_actor_type" AS ENUM('staff', 'client', 'system');--> statement-breakpoint
CREATE TABLE "sms_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_id" uuid,
	"location_id" uuid,
	"destination_e164" varchar(16) NOT NULL,
	"action" "sms_consent_action" NOT NULL,
	"source" varchar(64) NOT NULL,
	"disclosure_version" varchar(32),
	"disclosure" text,
	"detail" text,
	"actor_type" "sms_consent_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"actor_name" varchar(255),
	"provider" varchar(16),
	"provider_message_id" varchar(255),
	"event_key" varchar(200) NOT NULL,
	CONSTRAINT "sms_consent_events_destination_check" CHECK ("sms_consent_events"."destination_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "sms_consent_events_source_check" CHECK (length(btrim("sms_consent_events"."source")) between 1 and 64),
	CONSTRAINT "sms_consent_events_event_key_check" CHECK (length(btrim("sms_consent_events"."event_key")) between 1 and 200),
	CONSTRAINT "sms_consent_events_detail_check" CHECK ("sms_consent_events"."detail" is null or length("sms_consent_events"."detail") <= 2000),
	CONSTRAINT "sms_consent_events_evidence_shape_check" CHECK ((
          "sms_consent_events"."action" = 'granted'
          and length(btrim(coalesce("sms_consent_events"."disclosure_version", ''))) > 0
          and length(btrim(coalesce("sms_consent_events"."disclosure", ''))) > 0
        ) or (
          "sms_consent_events"."action" = 'revoked'
          and "sms_consent_events"."disclosure_version" is null
          and "sms_consent_events"."disclosure" is null
        )),
	CONSTRAINT "sms_consent_events_actor_shape_check" CHECK ((
          "sms_consent_events"."actor_type" = 'staff'
          and "sms_consent_events"."actor_user_id" is not null
          and length(btrim(coalesce("sms_consent_events"."actor_name", ''))) > 0
          and "sms_consent_events"."provider" is null
          and "sms_consent_events"."provider_message_id" is null
        ) or (
          "sms_consent_events"."actor_type" = 'client'
          and "sms_consent_events"."actor_user_id" is null
          and "sms_consent_events"."actor_name" is null
          and "sms_consent_events"."provider" in ('telnyx', 'twilio')
          and length(btrim(coalesce("sms_consent_events"."provider_message_id", ''))) > 0
        ) or (
          "sms_consent_events"."actor_type" = 'system'
          and "sms_consent_events"."actor_user_id" is null
          and "sms_consent_events"."actor_name" is null
          and "sms_consent_events"."provider" is null
          and "sms_consent_events"."provider_message_id" is null
        ))
);
--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_practice_id_uq" ON "locations" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_consent_events_practice_event_key_uq" ON "sms_consent_events" USING btree ("practice_id","event_key");--> statement-breakpoint
CREATE INDEX "sms_consent_events_client_history_idx" ON "sms_consent_events" USING btree ("practice_id","client_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "sms_consent_events_destination_history_idx" ON "sms_consent_events" USING btree ("practice_id","destination_e164","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_consent_events_provider_message_uq" ON "sms_consent_events" USING btree ("practice_id","provider","provider_message_id") WHERE "sms_consent_events"."provider" is not null and "sms_consent_events"."provider_message_id" is not null;--> statement-breakpoint
WITH consent_candidates AS MATERIALIZED (
	SELECT
		c.*,
		regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') AS phone_digits
	FROM clients c
	WHERE c.deleted_at IS NULL
		AND c.sms_consent = true
		AND c.sms_consent_at IS NOT NULL
		AND length(btrim(coalesce(c.sms_consent_source, ''))) > 0
		AND length(btrim(split_part(c.sms_consent_source, ':', 2))) > 0
		AND length(btrim(coalesce(c.sms_consent_disclosure, ''))) > 0
),
normalized_candidates AS (
	SELECT
		c.*,
		CASE
			WHEN left(btrim(c.phone), 1) = '+'
				THEN '+' || c.phone_digits
			WHEN length(c.phone_digits) = 10
				THEN '+1' || c.phone_digits
			WHEN length(c.phone_digits) = 11
				AND left(c.phone_digits, 1) = '1'
				THEN '+' || c.phone_digits
		END AS normalized_destination
	FROM consent_candidates c
),
valid_affirmative AS (
	SELECT *
	FROM normalized_candidates
	WHERE normalized_destination ~ '^\+[1-9][0-9]{7,14}$'
)
INSERT INTO sms_consent_events (
	id,
	created_at,
	occurred_at,
	practice_id,
	client_id,
	destination_e164,
	action,
	source,
	disclosure_version,
	disclosure,
	detail,
	actor_type,
	event_key
)
SELECT
	gen_random_uuid(),
	now(),
	c.sms_consent_at,
	c.practice_id,
	c.id,
	c.normalized_destination,
	'granted'::sms_consent_action,
	c.sms_consent_source,
	split_part(c.sms_consent_source, ':', 2),
	c.sms_consent_disclosure,
	'Backfilled from the existing affirmative client consent projection.',
	'system'::sms_consent_actor_type,
	'backfill:client:' || c.id::text || ':affirmative-v1'
FROM valid_affirmative c;--> statement-breakpoint
UPDATE clients c
SET
	sms_consent = false,
	sms_consent_at = null,
	sms_consent_source = null,
	sms_consent_disclosure = null
WHERE c.sms_consent = true
	AND NOT EXISTS (
		SELECT 1
		FROM sms_consent_events event
		WHERE event.practice_id = c.practice_id
			AND event.client_id = c.id
			AND event.action = 'granted'
	);--> statement-breakpoint
CREATE FUNCTION reject_sms_consent_event_mutation()
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
			WHERE namespace.nspname = 'public'
				AND class.relname = 'sms_consent_events'
		)
	THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION USING
		ERRCODE = '55000',
		MESSAGE = 'SMS consent events are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER sms_consent_events_immutable
	BEFORE UPDATE OR DELETE ON sms_consent_events
	FOR EACH ROW
	EXECUTE FUNCTION reject_sms_consent_event_mutation();--> statement-breakpoint
ALTER TABLE sms_consent_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sms_consent_events
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
		REVOKE ALL ON sms_consent_events FROM openpims_app;
		GRANT SELECT, INSERT ON sms_consent_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON sms_consent_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON sms_consent_events FROM authenticated;
	END IF;
END
$$;
