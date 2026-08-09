CREATE TYPE "public"."sms_send_actor_type" AS ENUM('clinic_user', 'platform_operator');--> statement-breakpoint
CREATE TYPE "public"."sms_send_attempt_event_kind" AS ENUM('provider_result', 'reconciliation');--> statement-breakpoint
CREATE TYPE "public"."sms_send_outcome" AS ENUM('accepted', 'definite_failure', 'outcome_unknown');--> statement-breakpoint
CREATE TABLE "sms_send_attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" "sms_send_attempt_event_kind" NOT NULL,
	"outcome" "sms_send_outcome" NOT NULL,
	"provider_message_id" varchar(255),
	"detail" text,
	"actor_type" "sms_send_actor_type",
	"actor_user_id" uuid,
	"actor_identity" varchar(255),
	"actor_name" varchar(255),
	"event_key" varchar(200) NOT NULL,
	CONSTRAINT "sms_send_attempt_events_event_key_check" CHECK (length(btrim("sms_send_attempt_events"."event_key")) between 1 and 200),
	CONSTRAINT "sms_send_attempt_events_detail_check" CHECK ("sms_send_attempt_events"."detail" is null or length("sms_send_attempt_events"."detail") <= 2000),
	CONSTRAINT "sms_send_attempt_events_outcome_shape_check" CHECK ((
          "sms_send_attempt_events"."outcome" = 'accepted'
          and length(btrim(coalesce("sms_send_attempt_events"."provider_message_id", ''))) > 0
        ) or (
          "sms_send_attempt_events"."outcome" in ('definite_failure', 'outcome_unknown')
          and "sms_send_attempt_events"."provider_message_id" is null
        )),
	CONSTRAINT "sms_send_attempt_events_actor_shape_check" CHECK ((
          "sms_send_attempt_events"."kind" = 'provider_result'
          and "sms_send_attempt_events"."actor_type" is null
          and "sms_send_attempt_events"."actor_user_id" is null
          and "sms_send_attempt_events"."actor_identity" is null
          and "sms_send_attempt_events"."actor_name" is null
        ) or (
          "sms_send_attempt_events"."kind" = 'reconciliation'
          and "sms_send_attempt_events"."outcome" in ('accepted', 'definite_failure')
          and "sms_send_attempt_events"."actor_type" is not null
          and length(btrim(coalesce("sms_send_attempt_events"."actor_identity", ''))) between 1 and 255
          and length(btrim(coalesce("sms_send_attempt_events"."actor_name", ''))) between 1 and 255
          and (
            ("sms_send_attempt_events"."actor_type" = 'clinic_user' and "sms_send_attempt_events"."actor_user_id" is not null)
            or ("sms_send_attempt_events"."actor_type" = 'platform_operator' and "sms_send_attempt_events"."actor_user_id" is null)
          )
        ))
);
--> statement-breakpoint
CREATE TABLE "sms_send_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_id" uuid,
	"location_id" uuid,
	"communication_id" uuid,
	"requested_by_actor_type" "sms_send_actor_type",
	"requested_by_user_id" uuid,
	"requested_by_identity" varchar(255),
	"requested_by_name" varchar(255),
	"resend_of_attempt_id" uuid,
	"source" varchar(64) NOT NULL,
	"source_id" varchar(200) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"destination_e164" varchar(16) NOT NULL,
	"registered_display_name" varchar(100) NOT NULL,
	"body" text NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"provider" varchar(16) NOT NULL,
	"sender_messaging_service_id" varchar(128),
	"sender_e164" varchar(16),
	CONSTRAINT "sms_send_attempts_source_check" CHECK (length(btrim("sms_send_attempts"."source")) between 1 and 64),
	CONSTRAINT "sms_send_attempts_source_id_check" CHECK (length(btrim("sms_send_attempts"."source_id")) between 1 and 200),
	CONSTRAINT "sms_send_attempts_idempotency_key_check" CHECK (length(btrim("sms_send_attempts"."idempotency_key")) between 1 and 200),
	CONSTRAINT "sms_send_attempts_destination_check" CHECK ("sms_send_attempts"."destination_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "sms_send_attempts_display_name_check" CHECK (length(btrim("sms_send_attempts"."registered_display_name")) between 1 and 100),
	CONSTRAINT "sms_send_attempts_body_check" CHECK (length("sms_send_attempts"."body") between 1 and 1600),
	CONSTRAINT "sms_send_attempts_body_hash_check" CHECK ("sms_send_attempts"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sms_send_attempts_provider_check" CHECK ("sms_send_attempts"."provider" in ('telnyx', 'twilio', 'console')),
	CONSTRAINT "sms_send_attempts_sender_check" CHECK ("sms_send_attempts"."provider" = 'console'
        or length(btrim(coalesce("sms_send_attempts"."sender_messaging_service_id", ''))) > 0
        or "sms_send_attempts"."sender_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "sms_send_attempts_requester_check" CHECK ((
          "sms_send_attempts"."source" = 'operator_resend'
          and "sms_send_attempts"."requested_by_actor_type" is not null
          and length(btrim(coalesce("sms_send_attempts"."requested_by_identity", ''))) between 1 and 255
          and length(btrim(coalesce("sms_send_attempts"."requested_by_name", ''))) between 1 and 255
          and (
            ("sms_send_attempts"."requested_by_actor_type" = 'clinic_user' and "sms_send_attempts"."requested_by_user_id" is not null)
            or ("sms_send_attempts"."requested_by_actor_type" = 'platform_operator' and "sms_send_attempts"."requested_by_user_id" is null)
          )
        ) or (
          "sms_send_attempts"."source" <> 'operator_resend'
          and (
            (
              "sms_send_attempts"."requested_by_actor_type" is null
              and "sms_send_attempts"."requested_by_user_id" is null
              and "sms_send_attempts"."requested_by_identity" is null
              and "sms_send_attempts"."requested_by_name" is null
            )
            or (
              "sms_send_attempts"."requested_by_actor_type" is not null
              and length(btrim(coalesce("sms_send_attempts"."requested_by_identity", ''))) between 1 and 255
              and length(btrim(coalesce("sms_send_attempts"."requested_by_name", ''))) between 1 and 255
              and (
                ("sms_send_attempts"."requested_by_actor_type" = 'clinic_user' and "sms_send_attempts"."requested_by_user_id" is not null)
                or ("sms_send_attempts"."requested_by_actor_type" = 'platform_operator' and "sms_send_attempts"."requested_by_user_id" is null)
              )
            )
          )
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempts_practice_id_uq" ON "sms_send_attempts" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "communications_practice_id_uq" ON "communications" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "sms_send_attempt_events" ADD CONSTRAINT "sms_send_attempt_events_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempt_events" ADD CONSTRAINT "sms_send_attempt_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempt_events" ADD CONSTRAINT "sms_send_attempt_events_attempt_tenant_fk" FOREIGN KEY ("practice_id","attempt_id") REFERENCES "public"."sms_send_attempts"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempt_events" ADD CONSTRAINT "sms_send_attempt_events_actor_tenant_fk" FOREIGN KEY ("practice_id","actor_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_communication_id_communications_id_fk" FOREIGN KEY ("communication_id") REFERENCES "public"."communications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_resend_tenant_fk" FOREIGN KEY ("practice_id","resend_of_attempt_id") REFERENCES "public"."sms_send_attempts"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_client_tenant_fk" FOREIGN KEY ("practice_id","client_id") REFERENCES "public"."clients"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_location_tenant_fk" FOREIGN KEY ("practice_id","location_id") REFERENCES "public"."locations"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_communication_tenant_fk" FOREIGN KEY ("practice_id","communication_id") REFERENCES "public"."communications"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_requester_tenant_fk" FOREIGN KEY ("practice_id","requested_by_user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempt_events_practice_event_key_uq" ON "sms_send_attempt_events" USING btree ("practice_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempt_events_provider_result_uq" ON "sms_send_attempt_events" USING btree ("practice_id","attempt_id") WHERE "sms_send_attempt_events"."kind" = 'provider_result';--> statement-breakpoint
CREATE INDEX "sms_send_attempt_events_attempt_history_idx" ON "sms_send_attempt_events" USING btree ("practice_id","attempt_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempt_events_provider_message_uq" ON "sms_send_attempt_events" USING btree ("practice_id","provider_message_id") WHERE "sms_send_attempt_events"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempts_practice_idempotency_uq" ON "sms_send_attempts" USING btree ("practice_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_send_attempts_resend_of_uq" ON "sms_send_attempts" USING btree ("practice_id","resend_of_attempt_id") WHERE "sms_send_attempts"."resend_of_attempt_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_send_attempts_client_history_idx" ON "sms_send_attempts" USING btree ("practice_id","client_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sms_send_attempts_communication_idx" ON "sms_send_attempts" USING btree ("practice_id","communication_id");--> statement-breakpoint
CREATE INDEX "sms_send_attempts_source_history_idx" ON "sms_send_attempts" USING btree ("practice_id","source","source_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_send_attempts_destination_history_idx" ON "sms_send_attempts" USING btree ("practice_id","destination_e164","created_at","id");--> statement-breakpoint
CREATE FUNCTION reject_sms_send_ledger_mutation()
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
		MESSAGE = 'SMS send ledger rows are append-only and cannot be updated or deleted.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER sms_send_attempts_immutable
	BEFORE UPDATE OR DELETE ON sms_send_attempts
	FOR EACH ROW EXECUTE FUNCTION reject_sms_send_ledger_mutation();--> statement-breakpoint
CREATE TRIGGER sms_send_attempt_events_immutable
	BEFORE UPDATE OR DELETE ON sms_send_attempt_events
	FOR EACH ROW EXECUTE FUNCTION reject_sms_send_ledger_mutation();--> statement-breakpoint
ALTER TABLE sms_send_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sms_send_attempts
	USING (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	)
	WITH CHECK (
		coalesce(current_setting('app.rls_bypass', true), '') = 'on'
		OR practice_id = nullif(current_setting('app.current_practice_id', true), '')::uuid
	);--> statement-breakpoint
ALTER TABLE sms_send_attempt_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sms_send_attempt_events
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
		REVOKE ALL ON sms_send_attempts, sms_send_attempt_events FROM openpims_app;
		GRANT SELECT, INSERT ON sms_send_attempts, sms_send_attempt_events TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON sms_send_attempts, sms_send_attempt_events FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON sms_send_attempts, sms_send_attempt_events FROM authenticated;
	END IF;
END
$$;
