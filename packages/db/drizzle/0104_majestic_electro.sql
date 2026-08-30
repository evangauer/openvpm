CREATE TABLE "auth_recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"approver_user_id" uuid,
	"cancelled_by_user_id" uuid,
	"target_session_version" integer NOT NULL,
	"revoked_session_version" integer,
	"status" varchar(16) NOT NULL,
	"reason_code" varchar(32) NOT NULL,
	"identity_proof_reference_hash" varchar(64) NOT NULL,
	"recovery_grant_hash" varchar(64),
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"grant_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_recovery_cases_tenant_id_uq" UNIQUE("practice_id","user_id","id"),
	CONSTRAINT "auth_recovery_cases_target_session_check" CHECK ("auth_recovery_cases"."target_session_version" > 0
        and ("auth_recovery_cases"."revoked_session_version" is null
          or "auth_recovery_cases"."revoked_session_version" = "auth_recovery_cases"."target_session_version" + 1)),
	CONSTRAINT "auth_recovery_cases_distinct_approver_check" CHECK ("auth_recovery_cases"."approver_user_id" is null
        or "auth_recovery_cases"."approver_user_id" <> "auth_recovery_cases"."requester_user_id"),
	CONSTRAINT "auth_recovery_cases_reason_check" CHECK ("auth_recovery_cases"."reason_code" = 'lost_all_passkeys'),
	CONSTRAINT "auth_recovery_cases_proof_hash_check" CHECK ("auth_recovery_cases"."identity_proof_reference_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_recovery_cases_grant_hash_check" CHECK ("auth_recovery_cases"."recovery_grant_hash" is null
        or "auth_recovery_cases"."recovery_grant_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_recovery_cases_request_ttl_check" CHECK ("auth_recovery_cases"."expires_at" = "auth_recovery_cases"."requested_at" + interval '24 hours'),
	CONSTRAINT "auth_recovery_cases_state_check" CHECK ((
          "auth_recovery_cases"."status" = 'pending'
          and "auth_recovery_cases"."approver_user_id" is null
          and "auth_recovery_cases"."cancelled_by_user_id" is null
          and "auth_recovery_cases"."revoked_session_version" is null
          and "auth_recovery_cases"."recovery_grant_hash" is null
          and "auth_recovery_cases"."approved_at" is null
          and "auth_recovery_cases"."grant_expires_at" is null
          and "auth_recovery_cases"."consumed_at" is null
          and "auth_recovery_cases"."cancelled_at" is null
          and "auth_recovery_cases"."expired_at" is null
        ) or (
          "auth_recovery_cases"."status" = 'approved'
          and "auth_recovery_cases"."approver_user_id" is not null
          and "auth_recovery_cases"."cancelled_by_user_id" is null
          and "auth_recovery_cases"."revoked_session_version" = "auth_recovery_cases"."target_session_version" + 1
          and "auth_recovery_cases"."recovery_grant_hash" is not null
          and "auth_recovery_cases"."approved_at" >= "auth_recovery_cases"."requested_at"
          and "auth_recovery_cases"."approved_at" <= "auth_recovery_cases"."expires_at"
          and "auth_recovery_cases"."grant_expires_at" = "auth_recovery_cases"."approved_at" + interval '15 minutes'
          and "auth_recovery_cases"."consumed_at" is null
          and "auth_recovery_cases"."cancelled_at" is null
          and "auth_recovery_cases"."expired_at" is null
        ) or (
          "auth_recovery_cases"."status" = 'consumed'
          and "auth_recovery_cases"."approver_user_id" is not null
          and "auth_recovery_cases"."cancelled_by_user_id" is null
          and "auth_recovery_cases"."revoked_session_version" = "auth_recovery_cases"."target_session_version" + 1
          and "auth_recovery_cases"."recovery_grant_hash" is not null
          and "auth_recovery_cases"."approved_at" >= "auth_recovery_cases"."requested_at"
          and "auth_recovery_cases"."approved_at" <= "auth_recovery_cases"."expires_at"
          and "auth_recovery_cases"."grant_expires_at" = "auth_recovery_cases"."approved_at" + interval '15 minutes'
          and "auth_recovery_cases"."consumed_at" >= "auth_recovery_cases"."approved_at"
          and "auth_recovery_cases"."consumed_at" <= "auth_recovery_cases"."grant_expires_at"
          and "auth_recovery_cases"."cancelled_at" is null
          and "auth_recovery_cases"."expired_at" is null
        ) or (
          "auth_recovery_cases"."status" = 'cancelled'
          and "auth_recovery_cases"."approver_user_id" is null
          and "auth_recovery_cases"."cancelled_by_user_id" is not null
          and "auth_recovery_cases"."revoked_session_version" is null
          and "auth_recovery_cases"."recovery_grant_hash" is null
          and "auth_recovery_cases"."approved_at" is null
          and "auth_recovery_cases"."grant_expires_at" is null
          and "auth_recovery_cases"."consumed_at" is null
          and "auth_recovery_cases"."cancelled_at" >= "auth_recovery_cases"."requested_at"
          and "auth_recovery_cases"."cancelled_at" <= "auth_recovery_cases"."expires_at"
          and "auth_recovery_cases"."expired_at" is null
        ) or (
          "auth_recovery_cases"."status" = 'expired'
          and "auth_recovery_cases"."cancelled_by_user_id" is null
          and "auth_recovery_cases"."consumed_at" is null
          and "auth_recovery_cases"."cancelled_at" is null
          and "auth_recovery_cases"."expired_at" is not null
          and (("auth_recovery_cases"."approver_user_id" is null
            and "auth_recovery_cases"."revoked_session_version" is null
            and "auth_recovery_cases"."recovery_grant_hash" is null
            and "auth_recovery_cases"."approved_at" is null
            and "auth_recovery_cases"."grant_expires_at" is null
            and "auth_recovery_cases"."expired_at" >= "auth_recovery_cases"."expires_at")
          or ("auth_recovery_cases"."approver_user_id" is not null
            and "auth_recovery_cases"."revoked_session_version" = "auth_recovery_cases"."target_session_version" + 1
            and "auth_recovery_cases"."recovery_grant_hash" is not null
            and "auth_recovery_cases"."approved_at" >= "auth_recovery_cases"."requested_at"
            and "auth_recovery_cases"."approved_at" <= "auth_recovery_cases"."expires_at"
            and "auth_recovery_cases"."grant_expires_at" = "auth_recovery_cases"."approved_at" + interval '15 minutes'
            and "auth_recovery_cases"."expired_at" >= "auth_recovery_cases"."grant_expires_at"))
        ))
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"event_type" varchar(24) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_recovery_events_type_check" CHECK ("auth_recovery_events"."event_type" in ('requested', 'approved', 'grant_consumed', 'cancelled', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "auth_recovery_cases" ADD CONSTRAINT "auth_recovery_cases_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_cases" ADD CONSTRAINT "auth_recovery_cases_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_cases" ADD CONSTRAINT "auth_recovery_cases_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_cases" ADD CONSTRAINT "auth_recovery_cases_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_cases" ADD CONSTRAINT "auth_recovery_cases_target_tenant_fk" FOREIGN KEY ("practice_id","user_id") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_events" ADD CONSTRAINT "auth_recovery_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_events" ADD CONSTRAINT "auth_recovery_events_case_tenant_fk" FOREIGN KEY ("practice_id","user_id","case_id") REFERENCES "public"."auth_recovery_cases"("practice_id","user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_recovery_cases_active_target_uq" ON "auth_recovery_cases" USING btree ("practice_id","user_id") WHERE "auth_recovery_cases"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "auth_recovery_cases_grant_hash_uq" ON "auth_recovery_cases" USING btree ("recovery_grant_hash") WHERE "auth_recovery_cases"."recovery_grant_hash" is not null;--> statement-breakpoint
CREATE INDEX "auth_recovery_cases_queue_idx" ON "auth_recovery_cases" USING btree ("status","expires_at","requested_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_recovery_events_case_event_uq" ON "auth_recovery_events" USING btree ("case_id","event_type");--> statement-breakpoint
CREATE INDEX "auth_recovery_events_case_timeline_idx" ON "auth_recovery_events" USING btree ("case_id","occurred_at","id");
--> statement-breakpoint
CREATE FUNCTION protect_auth_recovery_case_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  target_account public.users%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.updated_at <> NEW.requested_at THEN
      RAISE EXCEPTION 'auth recovery cases must begin pending at request time';
    END IF;
    IF NEW.requested_at < statement_timestamp() - interval '1 minute'
      OR NEW.requested_at > statement_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'auth recovery request time is not current';
    END IF;

    SELECT * INTO target_account
    FROM public.users
    WHERE id = NEW.user_id AND practice_id = NEW.practice_id
    FOR UPDATE;
    IF NOT FOUND
      OR target_account.deleted_at IS NOT NULL
      OR target_account.session_version <> NEW.target_session_version THEN
      RAISE EXCEPTION 'auth recovery request target is inactive or has a stale session generation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users requester
      WHERE requester.id = NEW.requester_user_id
        AND requester.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'auth recovery requester must be an active user';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
    OR NEW.target_session_version IS DISTINCT FROM OLD.target_session_version
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.identity_proof_reference_hash IS DISTINCT FROM OLD.identity_proof_reference_hash
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'auth recovery case identity and request evidence are immutable';
  END IF;

  IF OLD.status = 'approved' AND (
    NEW.approver_user_id IS DISTINCT FROM OLD.approver_user_id
    OR NEW.revoked_session_version IS DISTINCT FROM OLD.revoked_session_version
    OR NEW.recovery_grant_hash IS DISTINCT FROM OLD.recovery_grant_hash
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at
  ) THEN
    RAISE EXCEPTION 'auth recovery approval evidence is immutable';
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'cancelled', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid auth recovery case transition';
  END IF;

  IF (NEW.status = 'approved' AND NEW.updated_at <> NEW.approved_at)
    OR (NEW.status = 'consumed' AND NEW.updated_at <> NEW.consumed_at)
    OR (NEW.status = 'cancelled' AND NEW.updated_at <> NEW.cancelled_at)
    OR (NEW.status = 'expired' AND NEW.updated_at <> NEW.expired_at) THEN
    RAISE EXCEPTION 'auth recovery transition time must match updated_at';
  END IF;

  IF NEW.status = 'approved' THEN
    IF statement_timestamp() > OLD.expires_at THEN
      RAISE EXCEPTION 'expired auth recovery requests cannot be approved';
    END IF;
    IF NEW.approved_at < statement_timestamp() - interval '1 minute'
      OR NEW.approved_at > statement_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'auth recovery approval time is not current';
    END IF;
    SELECT * INTO target_account
    FROM public.users
    WHERE id = NEW.user_id AND practice_id = NEW.practice_id
    FOR UPDATE;
    IF NOT FOUND
      OR target_account.deleted_at IS NOT NULL
      OR target_account.session_version <> NEW.revoked_session_version THEN
      RAISE EXCEPTION 'auth recovery approval requires the target session generation to be revoked';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users approver
      WHERE approver.id = NEW.approver_user_id
        AND approver.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'auth recovery approver must be an active user';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.webauthn_credentials credential
      WHERE credential.practice_id = NEW.practice_id
        AND credential.user_id = NEW.user_id
        AND credential.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM public.webauthn_challenges challenge
      WHERE challenge.practice_id = NEW.practice_id
        AND challenge.user_id = NEW.user_id
        AND challenge.consumed_at IS NULL
        AND challenge.expires_at > NEW.approved_at
    ) OR EXISTS (
      SELECT 1 FROM public.privileged_action_proofs proof
      WHERE proof.practice_id = NEW.practice_id
        AND proof.user_id = NEW.user_id
        AND proof.consumed_at IS NULL
        AND proof.expires_at > NEW.approved_at
    ) THEN
      RAISE EXCEPTION 'auth recovery approval requires every active factor challenge and proof to be retired';
    END IF;
  ELSIF NEW.status = 'consumed' THEN
    IF OLD.grant_expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'expired auth recovery grants cannot be consumed';
    END IF;
    IF NEW.consumed_at < statement_timestamp() - interval '1 minute'
      OR NEW.consumed_at > statement_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'auth recovery grant consumption time is not current';
    END IF;
  ELSIF NEW.status = 'cancelled' THEN
    IF statement_timestamp() > OLD.expires_at THEN
      RAISE EXCEPTION 'expired auth recovery requests must use the expiry transition';
    END IF;
    IF NEW.cancelled_at < statement_timestamp() - interval '1 minute'
      OR NEW.cancelled_at > statement_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'auth recovery cancellation time is not current';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.users canceller
      WHERE canceller.id = NEW.cancelled_by_user_id
        AND canceller.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'auth recovery canceller must be an active user';
    END IF;
  ELSIF NEW.status = 'expired' THEN
    IF (OLD.status = 'pending' AND statement_timestamp() < OLD.expires_at)
      OR (OLD.status = 'approved' AND statement_timestamp() < OLD.grant_expires_at) THEN
      RAISE EXCEPTION 'auth recovery case cannot expire before its deadline';
    END IF;
    IF NEW.expired_at < statement_timestamp() - interval '1 minute'
      OR NEW.expired_at > statement_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION 'auth recovery expiry time is not current';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_recovery_cases_protect_transition
BEFORE INSERT OR UPDATE ON auth_recovery_cases
FOR EACH ROW EXECUTE FUNCTION protect_auth_recovery_case_transition();
--> statement-breakpoint
CREATE FUNCTION protect_auth_recovery_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recovery_case public.auth_recovery_cases%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'auth recovery events are immutable';
  END IF;

  SELECT * INTO recovery_case
  FROM public.auth_recovery_cases
  WHERE id = NEW.case_id
    AND practice_id = NEW.practice_id
    AND user_id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth recovery event case is missing';
  END IF;

  IF (NEW.event_type = 'requested' AND (
      NEW.actor_user_id IS DISTINCT FROM recovery_case.requester_user_id
      OR NEW.occurred_at <> recovery_case.requested_at))
    OR (NEW.event_type = 'approved' AND (
      recovery_case.status <> 'approved'
      OR NEW.actor_user_id IS DISTINCT FROM recovery_case.approver_user_id
      OR NEW.occurred_at IS DISTINCT FROM recovery_case.approved_at))
    OR (NEW.event_type = 'grant_consumed' AND (
      recovery_case.status <> 'consumed'
      OR NEW.actor_user_id IS DISTINCT FROM recovery_case.user_id
      OR NEW.occurred_at IS DISTINCT FROM recovery_case.consumed_at))
    OR (NEW.event_type = 'cancelled' AND (
      recovery_case.status <> 'cancelled'
      OR NEW.actor_user_id IS DISTINCT FROM recovery_case.cancelled_by_user_id
      OR NEW.occurred_at IS DISTINCT FROM recovery_case.cancelled_at))
    OR (NEW.event_type = 'expired' AND (
      recovery_case.status <> 'expired'
      OR NEW.actor_user_id IS NOT NULL
      OR NEW.occurred_at IS DISTINCT FROM recovery_case.expired_at)) THEN
    RAISE EXCEPTION 'auth recovery event does not match its case transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_recovery_events_protect
BEFORE INSERT OR UPDATE OR DELETE ON auth_recovery_events
FOR EACH ROW EXECUTE FUNCTION protect_auth_recovery_event();
--> statement-breakpoint
CREATE FUNCTION require_auth_recovery_transition_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE expected_event varchar(24);
BEGIN
  expected_event := CASE NEW.status
    WHEN 'pending' THEN 'requested'
    WHEN 'approved' THEN 'approved'
    WHEN 'consumed' THEN 'grant_consumed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'expired' THEN 'expired'
    ELSE NULL
  END;
  IF expected_event IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.auth_recovery_events event
    WHERE event.case_id = NEW.id AND event.event_type = expected_event
  ) THEN
    RAISE EXCEPTION 'auth recovery transition requires immutable event evidence';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER auth_recovery_cases_require_event
AFTER INSERT OR UPDATE ON auth_recovery_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_auth_recovery_transition_event();
--> statement-breakpoint
CREATE FUNCTION expire_due_auth_recovery_cases(batch_size integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  expiry_at timestamptz := statement_timestamp();
  expired_count integer := 0;
  recovery_case record;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 1000 THEN
    RAISE EXCEPTION 'auth recovery expiry batch size must be between 1 and 1000';
  END IF;

  FOR recovery_case IN
    SELECT recovery.id, recovery.practice_id, recovery.user_id
    FROM public.auth_recovery_cases recovery
    WHERE (recovery.status = 'pending' AND recovery.expires_at <= expiry_at)
      OR (recovery.status = 'approved'
        AND recovery.grant_expires_at <= expiry_at)
    ORDER BY CASE
        WHEN recovery.status = 'pending' THEN recovery.expires_at
        ELSE recovery.grant_expires_at
      END,
      recovery.id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_size
  LOOP
    UPDATE public.auth_recovery_cases
    SET status = 'expired', expired_at = expiry_at, updated_at = expiry_at
    WHERE id = recovery_case.id;

    INSERT INTO public.auth_recovery_events
      (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
    VALUES
      (recovery_case.id, recovery_case.practice_id, recovery_case.user_id,
        NULL, 'expired', expiry_at);
    expired_count := expired_count + 1;
  END LOOP;

  RETURN expired_count;
END;
$$;
