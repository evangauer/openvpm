CREATE TYPE "public"."auth_email_attempt_outcome" AS ENUM('reserved', 'accepted', 'definite_failure', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."auth_email_delivery_attribution" AS ENUM('attempt_tag', 'provider_message_id', 'unmatched', 'identity_conflict');--> statement-breakpoint
CREATE TYPE "public"."auth_email_delivery_classification" AS ENUM('sent', 'delivered', 'delayed', 'failed', 'complained', 'opened', 'clicked', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."auth_email_source" AS ENUM('registration', 'authenticated_resend');--> statement-breakpoint
CREATE TABLE "auth_email_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "auth_email_source" NOT NULL,
	"provider" varchar(16) DEFAULT 'resend' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"provider_message_id" varchar(128),
	"outcome" "auth_email_attempt_outcome" DEFAULT 'reserved' NOT NULL,
	"failure_code" varchar(64),
	CONSTRAINT "auth_email_attempts_provider_check" CHECK ("auth_email_attempts"."provider" in ('resend', 'console')),
	CONSTRAINT "auth_email_attempts_outcome_shape_check" CHECK ((
        "auth_email_attempts"."outcome" = 'reserved'
        and "auth_email_attempts"."resolved_at" is null
        and "auth_email_attempts"."provider_message_id" is null
        and "auth_email_attempts"."failure_code" is null
      ) or (
        "auth_email_attempts"."outcome" = 'accepted'
        and "auth_email_attempts"."resolved_at" is not null
        and length(btrim(coalesce("auth_email_attempts"."provider_message_id", ''))) > 0
        and "auth_email_attempts"."failure_code" is null
      ) or (
        "auth_email_attempts"."outcome" in ('definite_failure', 'outcome_unknown')
        and "auth_email_attempts"."resolved_at" is not null
        and "auth_email_attempts"."provider_message_id" is null
        and length(btrim(coalesce("auth_email_attempts"."failure_code", ''))) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "auth_email_provider_identity_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider" varchar(16) DEFAULT 'resend' NOT NULL,
	"source" "auth_email_source" NOT NULL,
	"durable_provider_message_id" varchar(128) NOT NULL,
	"conflicting_provider_message_id" varchar(128) NOT NULL,
	CONSTRAINT "auth_email_provider_identity_conflicts_provider_check" CHECK ("auth_email_provider_identity_conflicts"."provider" = 'resend'),
	CONSTRAINT "auth_email_provider_identity_conflicts_distinct_id_check" CHECK ("auth_email_provider_identity_conflicts"."durable_provider_message_id" <> "auth_email_provider_identity_conflicts"."conflicting_provider_message_id"),
	CONSTRAINT "auth_email_provider_identity_conflicts_id_shape_check" CHECK (length(btrim("auth_email_provider_identity_conflicts"."durable_provider_message_id")) > 0 and length(btrim("auth_email_provider_identity_conflicts"."conflicting_provider_message_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "auth_email_delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_id" varchar(128) NOT NULL,
	"raw_body_fingerprint" varchar(64) NOT NULL,
	"provider" varchar(16) DEFAULT 'resend' NOT NULL,
	"provider_message_id" varchar(128) NOT NULL,
	"attempt_id" uuid,
	"event_type" varchar(64) NOT NULL,
	"classification" "auth_email_delivery_classification" NOT NULL,
	"attribution" "auth_email_delivery_attribution" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_email_delivery_events_provider_check" CHECK ("auth_email_delivery_events"."provider" = 'resend'),
	CONSTRAINT "auth_email_delivery_events_event_type_check" CHECK ("auth_email_delivery_events"."event_type" ~ '^email\.'),
	CONSTRAINT "auth_email_delivery_events_raw_body_fingerprint_check" CHECK ("auth_email_delivery_events"."raw_body_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_email_delivery_events_attribution_shape_check" CHECK ((
        "auth_email_delivery_events"."attribution" in ('attempt_tag', 'provider_message_id')
        and "auth_email_delivery_events"."attempt_id" is not null
      ) or (
        "auth_email_delivery_events"."attribution" in ('unmatched', 'identity_conflict')
        and "auth_email_delivery_events"."attempt_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "auth_email_webhook_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"original_webhook_id" varchar(128) NOT NULL,
	"incoming_raw_body_fingerprint" varchar(64) NOT NULL,
	"provider" varchar(16) DEFAULT 'resend' NOT NULL,
	"incoming_provider_message_id" varchar(128) NOT NULL,
	"incoming_event_type" varchar(64) NOT NULL,
	CONSTRAINT "auth_email_webhook_conflicts_provider_check" CHECK ("auth_email_webhook_conflicts"."provider" = 'resend'),
	CONSTRAINT "auth_email_webhook_conflicts_event_type_check" CHECK ("auth_email_webhook_conflicts"."incoming_event_type" ~ '^email\.'),
	CONSTRAINT "auth_email_webhook_conflicts_raw_body_fingerprint_check" CHECK ("auth_email_webhook_conflicts"."incoming_raw_body_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "auth_email_attempts" ADD CONSTRAINT "auth_email_attempts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_attempts" ADD CONSTRAINT "auth_email_attempts_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_provider_identity_conflicts" ADD CONSTRAINT "auth_email_provider_identity_conflicts_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."auth_email_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_delivery_events" ADD CONSTRAINT "auth_email_delivery_events_attempt_id_auth_email_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."auth_email_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_attempts_idempotency_uq" ON "auth_email_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_attempts_provider_message_uq" ON "auth_email_attempts" USING btree ("provider","provider_message_id") WHERE "auth_email_attempts"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "auth_email_attempts_recovery_idx" ON "auth_email_attempts" USING btree ("outcome","created_at","id");--> statement-breakpoint
CREATE INDEX "auth_email_attempts_practice_created_idx" ON "auth_email_attempts" USING btree ("practice_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_provider_identity_conflicts_identity_uq" ON "auth_email_provider_identity_conflicts" USING btree ("attempt_id","provider","durable_provider_message_id","conflicting_provider_message_id");--> statement-breakpoint
CREATE INDEX "auth_email_provider_identity_conflicts_recovery_idx" ON "auth_email_provider_identity_conflicts" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_delivery_events_webhook_uq" ON "auth_email_delivery_events" USING btree ("webhook_id");--> statement-breakpoint
ALTER TABLE "auth_email_webhook_conflicts" ADD CONSTRAINT "auth_email_webhook_conflicts_webhook_fk" FOREIGN KEY ("original_webhook_id") REFERENCES "public"."auth_email_delivery_events"("webhook_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_email_delivery_events_attempt_timeline_idx" ON "auth_email_delivery_events" USING btree ("attempt_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "auth_email_delivery_events_provider_timeline_idx" ON "auth_email_delivery_events" USING btree ("provider","provider_message_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "auth_email_delivery_events_attribution_queue_idx" ON "auth_email_delivery_events" USING btree ("attribution","received_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_webhook_conflicts_identity_uq" ON "auth_email_webhook_conflicts" USING btree ("original_webhook_id","incoming_raw_body_fingerprint");--> statement-breakpoint
CREATE INDEX "auth_email_webhook_conflicts_recovery_idx" ON "auth_email_webhook_conflicts" USING btree ("received_at","id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_auth_email_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
	is_owner boolean;
BEGIN
	is_owner := current_user = (
		SELECT pg_catalog.pg_get_userbyid(class.relowner)
		FROM pg_catalog.pg_class class
		JOIN pg_catalog.pg_namespace namespace
			ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = TG_TABLE_SCHEMA
			AND class.relname = TG_TABLE_NAME
	);

	IF TG_OP = 'DELETE' THEN
		IF is_owner
			AND coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
		THEN
			RETURN OLD;
		END IF;
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'Auth email attempts may only be deleted during owner maintenance.';
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
		OR NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.source IS DISTINCT FROM OLD.source
		OR NEW.provider IS DISTINCT FROM OLD.provider
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'Auth email attempt identity is immutable.';
	END IF;

	IF NOT (
		(OLD.outcome = 'reserved' AND NEW.outcome <> 'reserved')
		OR (
			OLD.outcome = 'outcome_unknown'
			AND NEW.outcome = 'accepted'
			AND OLD.provider = 'resend'
			AND OLD.provider_message_id IS NULL
		)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = 'Auth email attempt state transition is not permitted.';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER auth_email_attempts_state_guard
	BEFORE UPDATE OR DELETE ON auth_email_attempts
	FOR EACH ROW EXECUTE FUNCTION guard_auth_email_attempt_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_auth_email_delivery_event_mutation()
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
		MESSAGE = 'Auth email delivery evidence is immutable.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER auth_email_delivery_events_immutable
	BEFORE UPDATE OR DELETE ON auth_email_delivery_events
	FOR EACH ROW EXECUTE FUNCTION reject_auth_email_delivery_event_mutation();--> statement-breakpoint
CREATE TRIGGER auth_email_webhook_conflicts_immutable
	BEFORE UPDATE OR DELETE ON auth_email_webhook_conflicts
	FOR EACH ROW EXECUTE FUNCTION reject_auth_email_delivery_event_mutation();--> statement-breakpoint
CREATE TRIGGER auth_email_provider_identity_conflicts_immutable
	BEFORE UPDATE OR DELETE ON auth_email_provider_identity_conflicts
	FOR EACH ROW EXECUTE FUNCTION reject_auth_email_delivery_event_mutation();--> statement-breakpoint
ALTER TABLE auth_email_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON auth_email_attempts
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
ALTER TABLE auth_email_delivery_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON auth_email_delivery_events
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
ALTER TABLE auth_email_webhook_conflicts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON auth_email_webhook_conflicts
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
ALTER TABLE auth_email_provider_identity_conflicts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON auth_email_provider_identity_conflicts
	USING (coalesce(current_setting('app.rls_bypass', true), '') = 'on')
	WITH CHECK (coalesce(current_setting('app.rls_bypass', true), '') = 'on');--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts FROM openpims_app;
		GRANT SELECT, INSERT, UPDATE ON auth_email_attempts TO openpims_app;
		GRANT SELECT, INSERT ON auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts TO openpims_app;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts FROM authenticated;
	END IF;
END
$$;
