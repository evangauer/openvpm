CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_version" integer NOT NULL,
	"purpose" varchar(24) NOT NULL,
	"action" varchar(96),
	"challenge_hash" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_session_version_check" CHECK ("webauthn_challenges"."session_version" > 0),
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" in ('registration', 'login', 'privileged_action')),
	CONSTRAINT "webauthn_challenges_action_shape_check" CHECK (("webauthn_challenges"."purpose" = 'privileged_action'
          and "webauthn_challenges"."action" ~ '^(admin|billing|subscription|settings|data|apiKeys|webhooks|passkeys)[.][A-Za-z][A-Za-z0-9]+$')
        or ("webauthn_challenges"."purpose" <> 'privileged_action' and "webauthn_challenges"."action" is null)),
	CONSTRAINT "webauthn_challenges_hash_check" CHECK ("webauthn_challenges"."challenge_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webauthn_challenges_ttl_check" CHECK ("webauthn_challenges"."expires_at" = "webauthn_challenges"."issued_at" + interval '5 minutes'),
	CONSTRAINT "webauthn_challenges_consumption_time_check" CHECK ("webauthn_challenges"."consumed_at" is null or ("webauthn_challenges"."consumed_at" >= "webauthn_challenges"."issued_at" and "webauthn_challenges"."consumed_at" <= "webauthn_challenges"."expires_at"))
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" varchar(1024) NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" varchar(16) NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" jsonb NOT NULL,
	"aaguid" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_shape_check" CHECK (length("webauthn_credentials"."credential_id") between 16 and 1024
		and "webauthn_credentials"."credential_id" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "webauthn_credentials_public_key_size_check" CHECK (octet_length("webauthn_credentials"."public_key") between 32 and 4096),
	CONSTRAINT "webauthn_credentials_counter_check" CHECK ("webauthn_credentials"."counter" >= 0),
	CONSTRAINT "webauthn_credentials_device_type_check" CHECK ("webauthn_credentials"."device_type" in ('singleDevice', 'multiDevice')),
	CONSTRAINT "webauthn_credentials_transports_check" CHECK (jsonb_typeof("webauthn_credentials"."transports") = 'array'
        and jsonb_array_length("webauthn_credentials"."transports") <= 7
        and "webauthn_credentials"."transports" <@ '["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]'::jsonb),
	CONSTRAINT "webauthn_credentials_name_check" CHECK (length(btrim("webauthn_credentials"."name")) between 1 and 80),
	CONSTRAINT "webauthn_credentials_use_time_check" CHECK ("webauthn_credentials"."last_used_at" is null or "webauthn_credentials"."last_used_at" >= "webauthn_credentials"."created_at"),
	CONSTRAINT "webauthn_credentials_deletion_time_check" CHECK ("webauthn_credentials"."deleted_at" is null or "webauthn_credentials"."deleted_at" >= "webauthn_credentials"."created_at")
);
--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" DROP CONSTRAINT "privileged_action_proofs_action_shape_check";--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" DROP CONSTRAINT "privileged_action_proofs_factor_type_check";--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_hash_uq" ON "webauthn_challenges" USING btree ("challenge_hash");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_active_user_idx" ON "webauthn_challenges" USING btree ("practice_id","user_id","session_version","purpose","consumed_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_uq" ON "webauthn_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_active_user_idx" ON "webauthn_credentials" USING btree ("practice_id","user_id","deleted_at");--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" ADD CONSTRAINT "privileged_action_proofs_action_shape_check" CHECK ("privileged_action_proofs"."action" ~ '^(admin|billing|subscription|settings|data|apiKeys|webhooks|passkeys)[.][A-Za-z][A-Za-z0-9]+$');--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" ADD CONSTRAINT "privileged_action_proofs_factor_type_check" CHECK ("privileged_action_proofs"."factor_type" in ('passkey', 'totp', 'recovery'));
--> statement-breakpoint

-- Install tenant isolation and least privilege atomically with the WebAuthn
-- tables. Challenge and credential identity fields are immutable; challenges
-- can be consumed once and authenticators can only move forward in lifecycle.
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON webauthn_challenges
  USING (app_rls_bypass() OR practice_id = app_current_practice_id())
  WITH CHECK (app_rls_bypass() OR practice_id = app_current_practice_id());--> statement-breakpoint
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON webauthn_credentials
  USING (app_rls_bypass() OR practice_id = app_current_practice_id())
  WITH CHECK (app_rls_bypass() OR practice_id = app_current_practice_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_webauthn_challenge_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.session_version IS DISTINCT FROM OLD.session_version
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.challenge_hash IS DISTINCT FROM OLD.challenge_hash
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'WebAuthn challenge identity is immutable and may be consumed once';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER protect_webauthn_challenge_update
  BEFORE UPDATE ON webauthn_challenges
  FOR EACH ROW EXECUTE FUNCTION protect_webauthn_challenge_update();--> statement-breakpoint
REVOKE ALL ON FUNCTION protect_webauthn_challenge_update() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_webauthn_credential_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.public_key IS DISTINCT FROM OLD.public_key
    OR NEW.device_type IS DISTINCT FROM OLD.device_type
    OR NEW.transports IS DISTINCT FROM OLD.transports
    OR NEW.aaguid IS DISTINCT FROM OLD.aaguid
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.counter < OLD.counter
    OR (OLD.backed_up AND NOT NEW.backed_up)
    OR (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at < OLD.last_used_at))
    OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
  THEN
    RAISE EXCEPTION 'WebAuthn credential identity and monotone lifecycle are protected';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER protect_webauthn_credential_update
  BEFORE UPDATE ON webauthn_credentials
  FOR EACH ROW EXECUTE FUNCTION protect_webauthn_credential_update();--> statement-breakpoint
REVOKE ALL ON FUNCTION protect_webauthn_credential_update() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION purge_expired_webauthn_challenges()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE deleted_count bigint;
BEGIN
  DELETE FROM public.webauthn_challenges
  WHERE expires_at < statement_timestamp() - interval '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_expired_webauthn_challenges() FROM PUBLIC;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON webauthn_challenges, webauthn_credentials FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON webauthn_challenges, webauthn_credentials TO openpims_app;
    REVOKE ALL ON FUNCTION protect_webauthn_challenge_update() FROM openpims_app;
    REVOKE ALL ON FUNCTION protect_webauthn_credential_update() FROM openpims_app;
    GRANT EXECUTE ON FUNCTION purge_expired_webauthn_challenges() TO openpims_app;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON webauthn_challenges, webauthn_credentials FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION protect_webauthn_challenge_update() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION protect_webauthn_credential_update() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION purge_expired_webauthn_challenges() FROM %I', r);
    END IF;
  END LOOP;
END $$;
