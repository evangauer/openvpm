SET LOCAL search_path = public, pg_catalog;--> statement-breakpoint
CREATE TABLE "platform_email_identity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_identity_key_fingerprint" varchar(64) NOT NULL,
	"current_email_hash" varchar(64) NOT NULL,
	"previous_identity_key_fingerprint" varchar(64) NOT NULL,
	"previous_email_hash" varchar(64) NOT NULL,
	CONSTRAINT "platform_email_identity_aliases_current_fingerprint_check" CHECK ("platform_email_identity_aliases"."current_identity_key_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_identity_aliases_current_hash_check" CHECK ("platform_email_identity_aliases"."current_email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_identity_aliases_previous_fingerprint_check" CHECK ("platform_email_identity_aliases"."previous_identity_key_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_identity_aliases_previous_hash_check" CHECK ("platform_email_identity_aliases"."previous_email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "platform_email_identity_aliases_distinct_fingerprints_check" CHECK ("platform_email_identity_aliases"."current_identity_key_fingerprint" <> "platform_email_identity_aliases"."previous_identity_key_fingerprint"),
	CONSTRAINT "platform_email_identity_aliases_distinct_hashes_check" CHECK ("platform_email_identity_aliases"."current_email_hash" <> "platform_email_identity_aliases"."previous_email_hash")
);
--> statement-breakpoint
ALTER TABLE "platform_email_identity" ADD COLUMN "previous_identity_key_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "platform_email_identity" ADD COLUMN "rotation_started_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_email_identity_aliases_current_uq" ON "platform_email_identity_aliases" USING btree ("current_identity_key_fingerprint","current_email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_email_identity_aliases_previous_uq" ON "platform_email_identity_aliases" USING btree ("previous_identity_key_fingerprint","previous_email_hash");--> statement-breakpoint
ALTER TABLE "platform_email_identity" ADD CONSTRAINT "platform_email_identity_previous_fingerprint_check" CHECK ("platform_email_identity"."previous_identity_key_fingerprint" IS NULL OR "platform_email_identity"."previous_identity_key_fingerprint" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "platform_email_identity" ADD CONSTRAINT "platform_email_identity_distinct_fingerprints_check" CHECK ("platform_email_identity"."previous_identity_key_fingerprint" IS NULL OR "platform_email_identity"."previous_identity_key_fingerprint" <> "platform_email_identity"."identity_key_fingerprint");--> statement-breakpoint
ALTER TABLE "platform_email_identity" ADD CONSTRAINT "platform_email_identity_rotation_state_check" CHECK (("platform_email_identity"."previous_identity_key_fingerprint" IS NULL) = ("platform_email_identity"."rotation_started_at" IS NULL));
--> statement-breakpoint
ALTER TABLE platform_email_identity_aliases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY system_read ON platform_email_identity_aliases
  FOR SELECT USING (app_rls_bypass());
--> statement-breakpoint
CREATE POLICY system_insert ON platform_email_identity_aliases
  FOR INSERT WITH CHECK (app_rls_bypass());
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON platform_email_identity_aliases FROM openpims_app;
    GRANT SELECT, INSERT ON platform_email_identity_aliases TO openpims_app;
  END IF;

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON platform_email_identity_aliases FROM %I',
        r
      );
    END IF;
  END LOOP;
END $$;
