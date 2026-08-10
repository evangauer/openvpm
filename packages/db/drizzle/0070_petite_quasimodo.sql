CREATE TABLE "platform_email_identity" (
	"key_slot" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"identity_key_fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_email_identity_singleton_check" CHECK ("platform_email_identity"."key_slot" = 1),
	CONSTRAINT "platform_email_identity_fingerprint_check" CHECK ("platform_email_identity"."identity_key_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "platform_email_preference_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_hash" varchar(64) NOT NULL,
	"identity_key_fingerprint" varchar(64) NOT NULL,
	"requested_marketing_enabled" boolean NOT NULL,
	"applied" boolean NOT NULL,
	"source" varchar(32) NOT NULL,
	"reason" varchar(32) NOT NULL,
	"updated_by_user_id" uuid,
	"provider_event_key_hash" varchar(64),
	CONSTRAINT "platform_email_preference_events_email_hash_check" CHECK ("platform_email_preference_events"."email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_preference_events_identity_fingerprint_check" CHECK ("platform_email_preference_events"."identity_key_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_preference_events_provider_event_key_hash_check" CHECK ("platform_email_preference_events"."provider_event_key_hash" IS NULL OR "platform_email_preference_events"."provider_event_key_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_preference_events_source_check" CHECK ("platform_email_preference_events"."source" in ('settings', 'unsubscribe_link', 'resend_webhook')),
	CONSTRAINT "platform_email_preference_events_reason_check" CHECK ("platform_email_preference_events"."reason" in ('settings_enabled', 'settings_disabled', 'unsubscribe', 'complaint', 'bounce', 'provider_suppressed')),
	CONSTRAINT "platform_email_preference_events_request_state_check" CHECK (("platform_email_preference_events"."requested_marketing_enabled" AND "platform_email_preference_events"."reason" = 'settings_enabled') OR (NOT "platform_email_preference_events"."requested_marketing_enabled" AND "platform_email_preference_events"."reason" <> 'settings_enabled'))
);
--> statement-breakpoint
CREATE TABLE "platform_email_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"email_hash" varchar(64) NOT NULL,
	"identity_key_fingerprint" varchar(64) NOT NULL,
	"marketing_enabled" boolean NOT NULL,
	"source" varchar(32) NOT NULL,
	"reason" varchar(32) NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "platform_email_preferences_email_hash_check" CHECK ("platform_email_preferences"."email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_preferences_identity_fingerprint_check" CHECK ("platform_email_preferences"."identity_key_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_preferences_source_check" CHECK ("platform_email_preferences"."source" in ('settings', 'unsubscribe_link', 'resend_webhook')),
	CONSTRAINT "platform_email_preferences_reason_check" CHECK ("platform_email_preferences"."reason" in ('settings_enabled', 'settings_disabled', 'unsubscribe', 'complaint', 'bounce', 'provider_suppressed')),
	CONSTRAINT "platform_email_preferences_state_check" CHECK (("platform_email_preferences"."marketing_enabled" AND "platform_email_preferences"."reason" = 'settings_enabled') OR (NOT "platform_email_preferences"."marketing_enabled" AND "platform_email_preferences"."reason" <> 'settings_enabled'))
);
--> statement-breakpoint
CREATE INDEX "platform_email_preference_events_recipient_timeline_idx" ON "platform_email_preference_events" USING btree ("email_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_email_preference_events_provider_event_key_uq" ON "platform_email_preference_events" USING btree ("provider_event_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_email_preferences_email_hash_uq" ON "platform_email_preferences" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "platform_email_preferences_identity_fingerprint_idx" ON "platform_email_preferences" USING btree ("identity_key_fingerprint");
--> statement-breakpoint
-- Install deny-by-default protection in the same migration transaction that
-- creates these global tables. The standalone RLS installer remains the
-- idempotent source of truth for existing/self-hosted databases.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;
--> statement-breakpoint
ALTER TABLE platform_email_identity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_read ON platform_email_identity
  FOR SELECT USING (app_rls_bypass());
--> statement-breakpoint
CREATE POLICY system_insert ON platform_email_identity
  FOR INSERT WITH CHECK (app_rls_bypass());
--> statement-breakpoint
ALTER TABLE platform_email_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_only ON platform_email_preferences
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());
--> statement-breakpoint
ALTER TABLE platform_email_preference_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_read ON platform_email_preference_events
  FOR SELECT USING (app_rls_bypass());
--> statement-breakpoint
CREATE POLICY system_insert ON platform_email_preference_events
  FOR INSERT WITH CHECK (app_rls_bypass());
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON platform_email_identity, platform_email_preferences, platform_email_preference_events FROM openpims_app;
    GRANT SELECT, INSERT ON platform_email_identity TO openpims_app;
    GRANT SELECT, INSERT, UPDATE ON platform_email_preferences TO openpims_app;
    GRANT SELECT, INSERT ON platform_email_preference_events TO openpims_app;
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON platform_email_identity, platform_email_preferences, platform_email_preference_events FROM %I',
        r
      );
    END IF;
  END LOOP;
END $$;
