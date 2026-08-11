CREATE TYPE "public"."sms_provider_event_conflict_resolution" AS ENUM('semantic_duplicate_confirmed', 'provider_identity_rotated', 'incident_closed_no_projection');--> statement-breakpoint
CREATE TYPE "public"."sms_provider_event_kind" AS ENUM('inbound', 'delivery', 'a2p');--> statement-breakpoint
CREATE TYPE "public"."sms_provider_event_state" AS ENUM('pending', 'retry', 'blocked_recovery', 'projected', 'ignored', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."sms_provider_inbound_classification" AS ENUM('stop', 'start', 'help', 'other');--> statement-breakpoint
CREATE TABLE "sms_provider_event_conflict_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"conflict_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"resolution" "sms_provider_event_conflict_resolution" NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"detail" varchar(2000),
	"reviewed_by_identity" varchar(255) NOT NULL,
	"reviewed_by_name" varchar(255) NOT NULL,
	CONSTRAINT "sms_provider_event_conflict_reviews_shape_check" CHECK ((
          ("sms_provider_event_conflict_reviews"."resolution" = 'semantic_duplicate_confirmed' and "sms_provider_event_conflict_reviews"."reason_code" in (
            'provider_replay_verified', 'signature_evidence_verified'
          ))
          or ("sms_provider_event_conflict_reviews"."resolution" = 'provider_identity_rotated' and "sms_provider_event_conflict_reviews"."reason_code" in (
            'sender_identity_rotated', 'provider_identity_reprovisioned'
          ))
          or ("sms_provider_event_conflict_reviews"."resolution" = 'incident_closed_no_projection' and "sms_provider_event_conflict_reviews"."reason_code" in (
            'provider_support_incident_closed', 'security_review_closed'
          ))
        )
        and "sms_provider_event_conflict_reviews"."reviewed_by_identity" = btrim("sms_provider_event_conflict_reviews"."reviewed_by_identity")
        and length("sms_provider_event_conflict_reviews"."reviewed_by_identity") between 1 and 255
        and "sms_provider_event_conflict_reviews"."reviewed_by_name" = btrim("sms_provider_event_conflict_reviews"."reviewed_by_name")
        and length("sms_provider_event_conflict_reviews"."reviewed_by_name") between 1 and 255
        and ("sms_provider_event_conflict_reviews"."detail" is null or length(btrim("sms_provider_event_conflict_reviews"."detail")) between 1 and 2000))
);
--> statement-breakpoint
CREATE TABLE "sms_provider_event_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"original_event_id" uuid NOT NULL,
	"incoming_raw_body_fingerprint_sha256" varchar(64) NOT NULL,
	"incoming_provider_event_type" varchar(80) NOT NULL,
	"incoming_provider_event_id" varchar(255),
	"incoming_provider_message_id" varchar(255),
	CONSTRAINT "sms_provider_event_conflicts_shape_check" CHECK ("sms_provider_event_conflicts"."incoming_raw_body_fingerprint_sha256" ~ '^[0-9a-f]{64}$'
        and length(btrim("sms_provider_event_conflicts"."incoming_provider_event_type")) between 1 and 80
        and "sms_provider_event_conflicts"."incoming_provider_event_type" ~ '^[A-Za-z0-9_.:-]+$'
        and ("sms_provider_event_conflicts"."incoming_provider_event_id" is null or (
          "sms_provider_event_conflicts"."incoming_provider_event_id" = btrim("sms_provider_event_conflicts"."incoming_provider_event_id")
          and length("sms_provider_event_conflicts"."incoming_provider_event_id") between 1 and 255
        ))
        and ("sms_provider_event_conflicts"."incoming_provider_message_id" is null or (
          "sms_provider_event_conflicts"."incoming_provider_message_id" = btrim("sms_provider_event_conflicts"."incoming_provider_message_id")
          and length("sms_provider_event_conflicts"."incoming_provider_message_id") between 1 and 255
        )))
);
--> statement-breakpoint
CREATE TABLE "sms_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"provider" varchar(16) NOT NULL,
	"kind" "sms_provider_event_kind" NOT NULL,
	"provider_event_id" varchar(255),
	"provider_message_id" varchar(255),
	"provider_event_type" varchar(80) NOT NULL,
	"event_key" varchar(255) NOT NULL,
	"raw_body_fingerprint_sha256" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone,
	"from_e164" varchar(16),
	"to_e164" varchar(16),
	"messaging_profile_id" varchar(128),
	"message_body" text,
	"inbound_classification" "sms_provider_inbound_classification",
	"delivery_classification" "sms_delivery_classification",
	"provider_status" varchar(80),
	"provider_error_code" varchar(80),
	"a2p_brand_id" varchar(128),
	"a2p_campaign_id" varchar(128),
	"a2p_phone_e164" varchar(16),
	"a2p_status" varchar(80),
	"a2p_type" varchar(80),
	"a2p_event_type" varchar(80),
	"a2p_observed_status" "messaging_registration_status",
	"provider_detail" varchar(1000),
	"practice_id" uuid,
	"location_id" uuid,
	"state" "sms_provider_event_state" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp(),
	"last_attempt_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_error_detail" varchar(2000),
	CONSTRAINT "sms_provider_events_provider_check" CHECK ("sms_provider_events"."provider" in ('telnyx', 'twilio')),
	CONSTRAINT "sms_provider_events_identifiers_check" CHECK (("sms_provider_events"."provider_event_id" is null or (
          "sms_provider_events"."provider_event_id" = btrim("sms_provider_events"."provider_event_id")
          and length("sms_provider_events"."provider_event_id") between 1 and 255
        ))
        and ("sms_provider_events"."provider_message_id" is null or (
          "sms_provider_events"."provider_message_id" = btrim("sms_provider_events"."provider_message_id")
          and length("sms_provider_events"."provider_message_id") between 1 and 255
        ))
        and length(btrim("sms_provider_events"."provider_event_type")) between 1 and 80
        and "sms_provider_events"."provider_event_type" ~ '^[A-Za-z0-9_.:-]+$'
        and length("sms_provider_events"."event_key") between 1 and 255
        and "sms_provider_events"."event_key" ~ '^[A-Za-z0-9_.:-]+$'
        and "sms_provider_events"."raw_body_fingerprint_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sms_provider_events_e164_check" CHECK (("sms_provider_events"."from_e164" is null or "sms_provider_events"."from_e164" ~ '^\+[1-9][0-9]{7,14}$')
        and ("sms_provider_events"."to_e164" is null or "sms_provider_events"."to_e164" ~ '^\+[1-9][0-9]{7,14}$')
        and ("sms_provider_events"."a2p_phone_e164" is null or "sms_provider_events"."a2p_phone_e164" ~ '^\+[1-9][0-9]{7,14}$')),
	CONSTRAINT "sms_provider_events_bounded_facts_check" CHECK (("sms_provider_events"."messaging_profile_id" is null or (
          "sms_provider_events"."messaging_profile_id" = btrim("sms_provider_events"."messaging_profile_id")
          and length("sms_provider_events"."messaging_profile_id") between 1 and 128
        ))
        and ("sms_provider_events"."provider_status" is null or (
          length(btrim("sms_provider_events"."provider_status")) between 1 and 80
          and "sms_provider_events"."provider_status" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."provider_error_code" is null or (
          length(btrim("sms_provider_events"."provider_error_code")) between 1 and 80
          and "sms_provider_events"."provider_error_code" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."a2p_brand_id" is null or (
          "sms_provider_events"."a2p_brand_id" = btrim("sms_provider_events"."a2p_brand_id")
          and length("sms_provider_events"."a2p_brand_id") between 1 and 128
        ))
        and ("sms_provider_events"."a2p_campaign_id" is null or (
          "sms_provider_events"."a2p_campaign_id" = btrim("sms_provider_events"."a2p_campaign_id")
          and length("sms_provider_events"."a2p_campaign_id") between 1 and 128
        ))
        and ("sms_provider_events"."a2p_status" is null or (
          length(btrim("sms_provider_events"."a2p_status")) between 1 and 80
          and "sms_provider_events"."a2p_status" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."a2p_type" is null or (
          length(btrim("sms_provider_events"."a2p_type")) between 1 and 80
          and "sms_provider_events"."a2p_type" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."a2p_event_type" is null or (
          length(btrim("sms_provider_events"."a2p_event_type")) between 1 and 80
          and "sms_provider_events"."a2p_event_type" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."provider_detail" is null or length(btrim("sms_provider_events"."provider_detail")) between 1 and 1000)
        and ("sms_provider_events"."last_error_code" is null or (
          length(btrim("sms_provider_events"."last_error_code")) between 1 and 64
          and "sms_provider_events"."last_error_code" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("sms_provider_events"."last_error_detail" is null or length(btrim("sms_provider_events"."last_error_detail")) between 1 and 2000)),
	CONSTRAINT "sms_provider_events_attribution_check" CHECK ("sms_provider_events"."location_id" is null or "sms_provider_events"."practice_id" is not null),
	CONSTRAINT "sms_provider_events_kind_shape_check" CHECK ((
          "sms_provider_events"."kind" = 'inbound'
          and "sms_provider_events"."provider_event_type" = 'message.received'
          and "sms_provider_events"."provider_message_id" is not null
          and "sms_provider_events"."from_e164" is not null
          and ("sms_provider_events"."to_e164" is not null or "sms_provider_events"."messaging_profile_id" is not null)
          and "sms_provider_events"."message_body" is not null
          and length(btrim("sms_provider_events"."message_body")) >= 1
          and length("sms_provider_events"."message_body") <= 1600
          and "sms_provider_events"."inbound_classification" is not null
          and "sms_provider_events"."delivery_classification" is null
          and "sms_provider_events"."provider_status" is null
          and "sms_provider_events"."provider_error_code" is null
          and "sms_provider_events"."a2p_brand_id" is null
          and "sms_provider_events"."a2p_campaign_id" is null
          and "sms_provider_events"."a2p_phone_e164" is null
          and "sms_provider_events"."a2p_status" is null
          and "sms_provider_events"."a2p_type" is null
          and "sms_provider_events"."a2p_event_type" is null
          and "sms_provider_events"."a2p_observed_status" is null
          and "sms_provider_events"."provider_detail" is null
        ) or (
          "sms_provider_events"."kind" = 'delivery'
          and "sms_provider_events"."provider_event_type" like 'message.%'
          and "sms_provider_events"."provider_event_type" <> 'message.received'
          and "sms_provider_events"."provider_message_id" is not null
          and "sms_provider_events"."from_e164" is null
          and "sms_provider_events"."to_e164" is null
          and "sms_provider_events"."messaging_profile_id" is null
          and "sms_provider_events"."message_body" is null
          and "sms_provider_events"."inbound_classification" is null
          and "sms_provider_events"."delivery_classification" is not null
          and "sms_provider_events"."a2p_brand_id" is null
          and "sms_provider_events"."a2p_campaign_id" is null
          and "sms_provider_events"."a2p_phone_e164" is null
          and "sms_provider_events"."a2p_status" is null
          and "sms_provider_events"."a2p_type" is null
          and "sms_provider_events"."a2p_event_type" is null
          and "sms_provider_events"."a2p_observed_status" is null
          and "sms_provider_events"."provider_detail" is null
        ) or (
          "sms_provider_events"."kind" = 'a2p'
          and "sms_provider_events"."provider" = 'telnyx'
          and "sms_provider_events"."provider_event_type" in (
            '10dlc.brand.update',
            '10dlc.campaign.update',
            '10dlc.phone_number.update'
          )
          and (
            "sms_provider_events"."a2p_brand_id" is not null
            or "sms_provider_events"."a2p_campaign_id" is not null
            or "sms_provider_events"."a2p_phone_e164" is not null
          )
          and "sms_provider_events"."a2p_observed_status" is not null
          and "sms_provider_events"."a2p_observed_status" in ('pending', 'action_required', 'failed', 'suspended')
          and "sms_provider_events"."provider_message_id" is null
          and "sms_provider_events"."from_e164" is null
          and "sms_provider_events"."to_e164" is null
          and "sms_provider_events"."messaging_profile_id" is null
          and "sms_provider_events"."message_body" is null
          and "sms_provider_events"."inbound_classification" is null
          and "sms_provider_events"."delivery_classification" is null
          and "sms_provider_events"."provider_error_code" is null
        )),
	CONSTRAINT "sms_provider_events_state_shape_check" CHECK ("sms_provider_events"."attempt_count" >= 0 and (
        (
          "sms_provider_events"."state" = 'pending'
          and "sms_provider_events"."attempt_count" = 0
          and "sms_provider_events"."next_attempt_at" is not null
          and "sms_provider_events"."next_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."last_attempt_at" is null
          and "sms_provider_events"."processed_at" is null
          and "sms_provider_events"."last_error_code" is null
          and "sms_provider_events"."last_error_detail" is null
        ) or (
          "sms_provider_events"."state" = 'retry'
          and "sms_provider_events"."attempt_count" >= 1
          and "sms_provider_events"."next_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."next_attempt_at" > "sms_provider_events"."last_attempt_at"
          and "sms_provider_events"."processed_at" is null
          and "sms_provider_events"."last_error_code" is not null
        ) or (
          "sms_provider_events"."state" = 'blocked_recovery'
          and "sms_provider_events"."practice_id" is not null
          and "sms_provider_events"."attempt_count" >= 1
          and "sms_provider_events"."next_attempt_at" is null
          and "sms_provider_events"."last_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."processed_at" is null
        ) or (
          "sms_provider_events"."state" = 'projected'
          and ("sms_provider_events"."practice_id" is not null or "sms_provider_events"."kind" = 'delivery')
          and "sms_provider_events"."attempt_count" >= 1
          and "sms_provider_events"."next_attempt_at" is null
          and "sms_provider_events"."last_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."processed_at" is not null
          and "sms_provider_events"."processed_at" >= "sms_provider_events"."last_attempt_at"
          and "sms_provider_events"."last_error_code" is null
          and "sms_provider_events"."last_error_detail" is null
        ) or (
          "sms_provider_events"."state" = 'ignored'
          and "sms_provider_events"."attempt_count" >= 1
          and "sms_provider_events"."next_attempt_at" is null
          and "sms_provider_events"."last_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."processed_at" is not null
          and "sms_provider_events"."processed_at" >= "sms_provider_events"."last_attempt_at"
          and "sms_provider_events"."last_error_code" is null
          and "sms_provider_events"."last_error_detail" is null
        ) or (
          "sms_provider_events"."state" = 'quarantined'
          and "sms_provider_events"."attempt_count" >= 1
          and "sms_provider_events"."next_attempt_at" is null
          and "sms_provider_events"."last_attempt_at" is not null
          and "sms_provider_events"."last_attempt_at" >= "sms_provider_events"."received_at"
          and "sms_provider_events"."processed_at" is not null
          and "sms_provider_events"."processed_at" >= "sms_provider_events"."last_attempt_at"
          and "sms_provider_events"."last_error_code" is not null
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "sms_provider_event_conflict_reviews" ADD CONSTRAINT "sms_provider_event_conflict_reviews_conflict_id_sms_provider_event_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "public"."sms_provider_event_conflicts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_event_conflicts" ADD CONSTRAINT "sms_provider_event_conflicts_original_event_id_sms_provider_events_id_fk" FOREIGN KEY ("original_event_id") REFERENCES "public"."sms_provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_events" ADD CONSTRAINT "sms_provider_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_provider_events" ADD CONSTRAINT "sms_provider_events_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_conflict_reviews_conflict_uq" ON "sms_provider_event_conflict_reviews" USING btree ("conflict_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_conflict_reviews_operation_uq" ON "sms_provider_event_conflict_reviews" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "sms_provider_event_conflict_reviews_history_idx" ON "sms_provider_event_conflict_reviews" USING btree ("reviewed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_event_conflicts_identity_uq" ON "sms_provider_event_conflicts" USING btree ("original_event_id","incoming_raw_body_fingerprint_sha256");--> statement-breakpoint
CREATE INDEX "sms_provider_event_conflicts_recovery_idx" ON "sms_provider_event_conflicts" USING btree ("received_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_events_provider_event_key_uq" ON "sms_provider_events" USING btree ("provider","event_key");--> statement-breakpoint
CREATE INDEX "sms_provider_events_due_idx" ON "sms_provider_events" USING btree ("next_attempt_at","received_at","id") WHERE "sms_provider_events"."state" in ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "sms_provider_events_practice_idx" ON "sms_provider_events" USING btree ("practice_id","state","received_at","id") WHERE "sms_provider_events"."practice_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_events_blocked_idx" ON "sms_provider_events" USING btree ("practice_id","received_at","id") WHERE "sms_provider_events"."state" = 'blocked_recovery';--> statement-breakpoint
CREATE INDEX "sms_provider_events_provider_message_idx" ON "sms_provider_events" USING btree ("provider","provider_message_id","received_at","id") WHERE "sms_provider_events"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_events_consent_order_idx" ON "sms_provider_events" USING btree ("practice_id","from_e164",coalesce("occurred_at", "received_at"),"received_at","id") WHERE "sms_provider_events"."kind" = 'inbound'
          and "sms_provider_events"."inbound_classification" in ('stop', 'start')
          and "sms_provider_events"."practice_id" is not null
          and "sms_provider_events"."from_e164" is not null;--> statement-breakpoint
CREATE INDEX "sms_provider_events_location_idx" ON "sms_provider_events" USING btree ("practice_id","location_id","received_at","id") WHERE "sms_provider_events"."location_id" is not null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_sms_provider_event_mutation()
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

	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider events cannot be deleted.';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.state <> 'pending' THEN
			RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'New SMS provider events must enter the pending state.';
		END IF;
		RETURN NEW;
	END IF;
	IF OLD.state IN ('projected', 'ignored', 'quarantined') THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Terminal SMS provider events are immutable.';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.received_at IS DISTINCT FROM OLD.received_at
		OR NEW.provider IS DISTINCT FROM OLD.provider
		OR NEW.kind IS DISTINCT FROM OLD.kind
		OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
		OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
		OR NEW.provider_event_type IS DISTINCT FROM OLD.provider_event_type
		OR NEW.event_key IS DISTINCT FROM OLD.event_key
		OR NEW.raw_body_fingerprint_sha256 IS DISTINCT FROM OLD.raw_body_fingerprint_sha256
		OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
		OR NEW.from_e164 IS DISTINCT FROM OLD.from_e164
		OR NEW.to_e164 IS DISTINCT FROM OLD.to_e164
		OR NEW.messaging_profile_id IS DISTINCT FROM OLD.messaging_profile_id
		OR NEW.message_body IS DISTINCT FROM OLD.message_body
		OR NEW.inbound_classification IS DISTINCT FROM OLD.inbound_classification
		OR NEW.delivery_classification IS DISTINCT FROM OLD.delivery_classification
		OR NEW.provider_status IS DISTINCT FROM OLD.provider_status
		OR NEW.provider_error_code IS DISTINCT FROM OLD.provider_error_code
		OR NEW.a2p_brand_id IS DISTINCT FROM OLD.a2p_brand_id
		OR NEW.a2p_campaign_id IS DISTINCT FROM OLD.a2p_campaign_id
		OR NEW.a2p_phone_e164 IS DISTINCT FROM OLD.a2p_phone_e164
		OR NEW.a2p_status IS DISTINCT FROM OLD.a2p_status
		OR NEW.a2p_type IS DISTINCT FROM OLD.a2p_type
		OR NEW.a2p_event_type IS DISTINCT FROM OLD.a2p_event_type
		OR NEW.a2p_observed_status IS DISTINCT FROM OLD.a2p_observed_status
		OR NEW.provider_detail IS DISTINCT FROM OLD.provider_detail
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event facts are immutable.';
	END IF;

	IF (OLD.practice_id IS NOT NULL AND NEW.practice_id IS DISTINCT FROM OLD.practice_id)
		OR (OLD.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM OLD.location_id)
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event attribution is set-once.';
	END IF;
	IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event processing time is set-once.';
	END IF;
	IF NEW.attempt_count < OLD.attempt_count THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event attempts cannot decrease.';
	END IF;
	IF NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at AND (
		NEW.attempt_count <= OLD.attempt_count
		OR NEW.last_attempt_at IS NULL
		OR (OLD.last_attempt_at IS NOT NULL AND NEW.last_attempt_at <= OLD.last_attempt_at)
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event attempt time must advance with its attempt count.';
	END IF;
	IF NEW.attempt_count > OLD.attempt_count
		AND NEW.last_attempt_at IS NOT DISTINCT FROM OLD.last_attempt_at
	THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event attempt increments require a new attempt time.';
	END IF;

	IF NOT (
		(OLD.state = 'pending' AND NEW.state IN ('pending', 'retry', 'blocked_recovery', 'projected', 'ignored', 'quarantined'))
		OR (OLD.state = 'retry' AND NEW.state IN ('retry', 'blocked_recovery', 'projected', 'ignored', 'quarantined'))
		OR (OLD.state = 'blocked_recovery' AND NEW.state IN ('retry', 'blocked_recovery', 'projected', 'ignored', 'quarantined'))
	) THEN
		RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider event state transition is not permitted.';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sms_provider_events_mutation_guard
	BEFORE INSERT OR UPDATE OR DELETE ON sms_provider_events
	FOR EACH ROW EXECUTE FUNCTION guard_sms_provider_event_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_sms_provider_conflict_evidence_mutation()
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
	RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SMS provider conflict evidence is immutable.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sms_provider_event_conflicts_immutable
	BEFORE UPDATE OR DELETE ON sms_provider_event_conflicts
	FOR EACH ROW EXECUTE FUNCTION reject_sms_provider_conflict_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER sms_provider_event_conflict_reviews_immutable
	BEFORE UPDATE OR DELETE ON sms_provider_event_conflict_reviews
	FOR EACH ROW EXECUTE FUNCTION reject_sms_provider_conflict_evidence_mutation();
--> statement-breakpoint
ALTER TABLE sms_provider_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON sms_provider_events
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
ALTER TABLE sms_provider_event_conflicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON sms_provider_event_conflicts
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
ALTER TABLE sms_provider_event_conflict_reviews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON sms_provider_event_conflict_reviews
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');
--> statement-breakpoint
REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON sms_provider_events TO openpims_app;
		GRANT SELECT, INSERT ON sms_provider_event_conflicts, sms_provider_event_conflict_reviews TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews FROM authenticated;
	END IF;
END
$$;
