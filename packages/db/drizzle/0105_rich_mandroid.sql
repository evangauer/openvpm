ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_purpose_check";--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD COLUMN "recovery_case_id" uuid;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_recovery_case_tenant_fk" FOREIGN KEY ("practice_id","user_id","recovery_case_id") REFERENCES "public"."auth_recovery_cases"("practice_id","user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_recovery_case_shape_check" CHECK (("webauthn_challenges"."purpose" = 'recovery_registration'
          and "webauthn_challenges"."recovery_case_id" is not null)
        or ("webauthn_challenges"."purpose" <> 'recovery_registration'
          and "webauthn_challenges"."recovery_case_id" is null));--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" in ('registration', 'login', 'privileged_action', 'recovery_registration'));
--> statement-breakpoint

-- Recovery-registration challenges are system-only even though ordinary
-- enrollment/login challenges remain visible inside their tenant context.
DROP POLICY tenant_isolation ON webauthn_challenges;--> statement-breakpoint
CREATE POLICY tenant_isolation ON webauthn_challenges
  USING (app_rls_bypass() OR (
    practice_id = app_current_practice_id()
    AND purpose <> 'recovery_registration'
  ))
  WITH CHECK (app_rls_bypass() OR (
    practice_id = app_current_practice_id()
    AND purpose <> 'recovery_registration'
  ));--> statement-breakpoint

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
    OR NEW.recovery_case_id IS DISTINCT FROM OLD.recovery_case_id
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

-- A recovery grant is not consumed until a recovery-bound, user-verified
-- ceremony has produced an active replacement passkey in the same transaction.
CREATE FUNCTION require_auth_recovery_passkey_on_consume()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'consumed' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.webauthn_challenges challenge
      WHERE challenge.recovery_case_id = NEW.id
        AND challenge.practice_id = NEW.practice_id
        AND challenge.user_id = NEW.user_id
        AND challenge.session_version = NEW.revoked_session_version
        AND challenge.purpose = 'recovery_registration'
        AND challenge.consumed_at IS NOT NULL
        AND challenge.consumed_at >= NEW.approved_at
        AND challenge.consumed_at <= NEW.consumed_at
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.webauthn_credentials credential
      WHERE credential.practice_id = NEW.practice_id
        AND credential.user_id = NEW.user_id
        AND credential.deleted_at IS NULL
        AND credential.created_at >= NEW.approved_at
        AND credential.created_at <= NEW.consumed_at
    ) THEN
      RAISE EXCEPTION 'auth recovery grant consumption requires a recovery-bound replacement passkey';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER auth_recovery_cases_require_passkey
BEFORE UPDATE ON auth_recovery_cases
FOR EACH ROW EXECUTE FUNCTION require_auth_recovery_passkey_on_consume();--> statement-breakpoint
REVOKE ALL ON FUNCTION require_auth_recovery_passkey_on_consume()
  FROM PUBLIC;--> statement-breakpoint
