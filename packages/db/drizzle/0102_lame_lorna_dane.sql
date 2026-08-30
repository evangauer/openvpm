CREATE TABLE "privileged_action_proofs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_version" integer NOT NULL,
	"action" varchar(96) NOT NULL,
	"nonce_hash" varchar(64) NOT NULL,
	"factor_type" varchar(16) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "privileged_action_proofs_session_version_check" CHECK ("privileged_action_proofs"."session_version" > 0),
	CONSTRAINT "privileged_action_proofs_action_shape_check" CHECK ("privileged_action_proofs"."action" ~ '^(admin|billing|subscription|settings|data|apiKeys|webhooks)[.][A-Za-z][A-Za-z0-9]+$'),
	CONSTRAINT "privileged_action_proofs_nonce_hash_check" CHECK ("privileged_action_proofs"."nonce_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "privileged_action_proofs_factor_type_check" CHECK ("privileged_action_proofs"."factor_type" in ('totp', 'recovery')),
	CONSTRAINT "privileged_action_proofs_ttl_check" CHECK ("privileged_action_proofs"."expires_at" = "privileged_action_proofs"."issued_at" + interval '5 minutes'),
	CONSTRAINT "privileged_action_proofs_consumption_time_check" CHECK ("privileged_action_proofs"."consumed_at" is null or ("privileged_action_proofs"."consumed_at" >= "privileged_action_proofs"."issued_at" and "privileged_action_proofs"."consumed_at" <= "privileged_action_proofs"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" ADD CONSTRAINT "privileged_action_proofs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privileged_action_proofs" ADD CONSTRAINT "privileged_action_proofs_user_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "privileged_action_proofs_nonce_hash_uq" ON "privileged_action_proofs" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "privileged_action_proofs_active_idx" ON "privileged_action_proofs" USING btree ("practice_id","user_id","session_version","action","consumed_at","expires_at");--> statement-breakpoint

-- Install the tenant boundary atomically with the proof table. The row stores
-- only an opaque nonce digest and may transition from unconsumed to consumed
-- once; signed identity, action, factor, session, and time fields are immutable.
ALTER TABLE privileged_action_proofs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON privileged_action_proofs
  USING (app_rls_bypass() OR practice_id = app_current_practice_id())
  WITH CHECK (app_rls_bypass() OR practice_id = app_current_practice_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_privileged_action_proof_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.session_version IS DISTINCT FROM OLD.session_version
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
    OR NEW.factor_type IS DISTINCT FROM OLD.factor_type
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'Privileged action proof identity is immutable and may be consumed once';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER protect_privileged_action_proof_update
  BEFORE UPDATE ON privileged_action_proofs
  FOR EACH ROW EXECUTE FUNCTION protect_privileged_action_proof_update();--> statement-breakpoint
REVOKE ALL ON FUNCTION protect_privileged_action_proof_update() FROM PUBLIC;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON privileged_action_proofs FROM openpims_app;
    GRANT SELECT, INSERT, UPDATE ON privileged_action_proofs TO openpims_app;
    REVOKE ALL ON FUNCTION protect_privileged_action_proof_update() FROM openpims_app;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON privileged_action_proofs FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION protect_privileged_action_proof_update() FROM %I', r);
    END IF;
  END LOOP;
END $$;
