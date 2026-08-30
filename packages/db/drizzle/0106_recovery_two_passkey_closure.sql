ALTER TABLE "auth_recovery_events" DROP CONSTRAINT "auth_recovery_events_type_check";--> statement-breakpoint
ALTER TABLE "auth_recovery_events" ADD CONSTRAINT "auth_recovery_events_type_check" CHECK ("auth_recovery_events"."event_type" in ('requested', 'approved', 'reenrollment_started', 'grant_consumed', 'cancelled', 'expired'));--> statement-breakpoint

-- Reenrollment is evidence-bearing even though the case intentionally remains
-- approved (and ordinary login remains closed) after the first passkey.
CREATE FUNCTION validate_auth_recovery_reenrollment_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE recovery_case public.auth_recovery_cases%ROWTYPE;
BEGIN
  IF NEW.event_type <> 'reenrollment_started' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO recovery_case
  FROM public.auth_recovery_cases
  WHERE id = NEW.case_id
    AND practice_id = NEW.practice_id
    AND user_id = NEW.user_id;
  IF NOT FOUND
    OR recovery_case.status <> 'approved'
    OR NEW.actor_user_id IS DISTINCT FROM recovery_case.user_id
    OR NEW.occurred_at < recovery_case.approved_at
    OR NEW.occurred_at > recovery_case.grant_expires_at
    OR NEW.occurred_at < statement_timestamp() - interval '1 minute'
    OR NEW.occurred_at > statement_timestamp() + interval '5 seconds'
    OR NOT EXISTS (
      SELECT 1
      FROM public.webauthn_credentials credential
      WHERE credential.practice_id = recovery_case.practice_id
        AND credential.user_id = recovery_case.user_id
        AND credential.deleted_at IS NULL
        AND credential.created_at >= recovery_case.approved_at
        AND credential.created_at <= NEW.occurred_at
    ) THEN
    RAISE EXCEPTION 'auth recovery reenrollment event is invalid';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER auth_recovery_events_validate_reenrollment
BEFORE INSERT ON auth_recovery_events
FOR EACH ROW EXECUTE FUNCTION validate_auth_recovery_reenrollment_event();--> statement-breakpoint
REVOKE ALL ON FUNCTION validate_auth_recovery_reenrollment_event()
  FROM PUBLIC;--> statement-breakpoint

-- Partial recovery must fail locked. Expiring an approved case retires every
-- replacement credential created during its grant window before the case can
-- become visible as expired.
CREATE FUNCTION retire_auth_recovery_partial_passkeys_on_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'expired' THEN
    UPDATE public.webauthn_credentials
    SET deleted_at = NEW.expired_at, updated_at = NEW.expired_at
    WHERE practice_id = NEW.practice_id
      AND user_id = NEW.user_id
      AND deleted_at IS NULL
      AND created_at >= OLD.approved_at;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER auth_recovery_cases_retire_partial_passkeys
BEFORE UPDATE ON auth_recovery_cases
FOR EACH ROW EXECUTE FUNCTION retire_auth_recovery_partial_passkeys_on_expiry();--> statement-breakpoint
REVOKE ALL ON FUNCTION retire_auth_recovery_partial_passkeys_on_expiry()
  FROM PUBLIC;--> statement-breakpoint

-- Closure requires two distinct credentials and two consumed recovery
-- challenges. At least one challenge must have been issued only after the
-- first credential existed, proving the second ceremony excluded the first.
CREATE OR REPLACE FUNCTION require_auth_recovery_passkey_on_consume()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  replacement_count integer;
  consumed_challenge_count integer;
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'consumed' THEN
    SELECT count(*)::integer INTO replacement_count
    FROM public.webauthn_credentials credential
    WHERE credential.practice_id = NEW.practice_id
      AND credential.user_id = NEW.user_id
      AND credential.deleted_at IS NULL
      AND credential.created_at >= NEW.approved_at
      AND credential.created_at <= NEW.consumed_at;

    SELECT count(*)::integer INTO consumed_challenge_count
    FROM public.webauthn_challenges challenge
    WHERE challenge.recovery_case_id = NEW.id
      AND challenge.practice_id = NEW.practice_id
      AND challenge.user_id = NEW.user_id
      AND challenge.session_version = NEW.revoked_session_version
      AND challenge.purpose = 'recovery_registration'
      AND challenge.consumed_at IS NOT NULL
      AND challenge.consumed_at >= NEW.approved_at
      AND challenge.consumed_at <= NEW.consumed_at;

    IF replacement_count <> 2
      OR consumed_challenge_count <> 2
      OR NOT EXISTS (
        SELECT 1
        FROM public.webauthn_credentials first_credential
        JOIN public.webauthn_challenges second_challenge
          ON second_challenge.recovery_case_id = NEW.id
         AND second_challenge.practice_id = first_credential.practice_id
         AND second_challenge.user_id = first_credential.user_id
        WHERE first_credential.practice_id = NEW.practice_id
          AND first_credential.user_id = NEW.user_id
          AND first_credential.deleted_at IS NULL
          AND first_credential.created_at >= NEW.approved_at
          AND first_credential.created_at <= NEW.consumed_at
          AND second_challenge.session_version = NEW.revoked_session_version
          AND second_challenge.purpose = 'recovery_registration'
          AND second_challenge.issued_at > first_credential.created_at
          AND second_challenge.consumed_at IS NOT NULL
          AND second_challenge.consumed_at <= NEW.consumed_at
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.auth_recovery_events event
        WHERE event.case_id = NEW.id
          AND event.event_type = 'reenrollment_started'
      ) THEN
      RAISE EXCEPTION 'auth recovery closure requires two sequential replacement passkeys';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION require_auth_recovery_passkey_on_consume()
  FROM PUBLIC;
