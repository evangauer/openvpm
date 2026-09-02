SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
CREATE TABLE "visit_treatment_plan_presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"decisions" jsonb,
	"response_sha256" varchar(64),
	"consent_request_id" uuid,
	CONSTRAINT "visit_treatment_plan_presentations_status_check" CHECK ("visit_treatment_plan_presentations"."status" in ('pending', 'awaiting_signature', 'completed', 'superseded')),
	CONSTRAINT "visit_treatment_plan_presentations_token_hash_check" CHECK ("visit_treatment_plan_presentations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_presentations_response_hash_check" CHECK ("visit_treatment_plan_presentations"."response_sha256" is null or "visit_treatment_plan_presentations"."response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_presentations_state_check" CHECK (("visit_treatment_plan_presentations"."status" in ('pending', 'superseded') and "visit_treatment_plan_presentations"."decisions" is null and "visit_treatment_plan_presentations"."response_sha256" is null and "visit_treatment_plan_presentations"."consent_request_id" is null) or ("visit_treatment_plan_presentations"."status" in ('awaiting_signature', 'completed') and "visit_treatment_plan_presentations"."decisions" is not null and "visit_treatment_plan_presentations"."response_sha256" is not null and "visit_treatment_plan_presentations"."consent_request_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_practice_id_uq" ON "consent_requests" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_revision_tenant_fk" FOREIGN KEY ("practice_id","revision_id","plan_id") REFERENCES "public"."visit_treatment_plan_revisions"("practice_id","id","plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_plan_tenant_fk" FOREIGN KEY ("practice_id","plan_id") REFERENCES "public"."visit_treatment_plans"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_consent_tenant_fk" FOREIGN KEY ("practice_id","consent_request_id") REFERENCES "public"."consent_requests"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_token_hash_uq" ON "visit_treatment_plan_presentations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_response_uq" ON "visit_treatment_plan_presentations" USING btree ("response_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_consent_uq" ON "visit_treatment_plan_presentations" USING btree ("consent_request_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_presentations_revision_status_idx" ON "visit_treatment_plan_presentations" USING btree ("practice_id","revision_id","status","expires_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compute_visit_treatment_plan_response_sha256_from_decisions(
  p_practice_id uuid, p_plan_id uuid, p_revision_id uuid,
  p_response_id uuid, p_decisions jsonb
) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'version', 1, 'practiceId', p_practice_id::text,
      'planId', p_plan_id::text, 'revisionId', p_revision_id::text,
      'revisionSha256', revision.content_sha256,
      'responseId', p_response_id::text,
      'decisions', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'revisionLineId', offered.id::text,
          'decision', decision.value->>'decision',
          'acceptedQuantity', (decision.value->>'acceptedQuantity')::numeric(12,3),
          'declineReason', decision.value->'declineReason'
        ) ORDER BY offered.sort_order, offered.id)
        FROM pg_catalog.jsonb_array_elements(p_decisions) decision(value)
        JOIN public.visit_treatment_plan_revision_lines offered
          ON offered.practice_id = p_practice_id
         AND offered.revision_id = p_revision_id
         AND offered.id = (decision.value->>'revisionLineId')::uuid
      ), '[]'::jsonb)
    )::text, 'UTF8')), 'hex')
  FROM public.visit_treatment_plan_revisions revision
  WHERE revision.practice_id = p_practice_id
    AND revision.plan_id = p_plan_id AND revision.id = p_revision_id
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_presentation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan presentations cannot be deleted';
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('awaiting_signature', 'superseded') THEN
    IF ROW(NEW.practice_id, NEW.plan_id, NEW.revision_id, NEW.response_id,
           NEW.created_by, NEW.token_hash, NEW.expires_at)
       IS DISTINCT FROM
       ROW(OLD.practice_id, OLD.plan_id, OLD.revision_id, OLD.response_id,
           OLD.created_by, OLD.token_hash, OLD.expires_at)
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan presentation identity is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'awaiting_signature' AND NEW.status = 'completed' THEN
    IF ROW(NEW.practice_id, NEW.plan_id, NEW.revision_id, NEW.response_id,
           NEW.created_by, NEW.token_hash, NEW.expires_at, NEW.decisions,
           NEW.response_sha256, NEW.consent_request_id)
       IS DISTINCT FROM
       ROW(OLD.practice_id, OLD.plan_id, OLD.revision_id, OLD.response_id,
           OLD.created_by, OLD.token_hash, OLD.expires_at, OLD.decisions,
           OLD.response_sha256, OLD.consent_request_id)
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan presentation evidence is immutable'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid treatment plan presentation transition';
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_presentation_guard
BEFORE UPDATE OR DELETE ON public.visit_treatment_plan_presentations
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_presentation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_revision_while_treatment_plan_signing()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM public.visit_treatment_plan_presentations presentation
    LEFT JOIN public.consent_requests consent
      ON consent.practice_id = presentation.practice_id
     AND consent.id = presentation.consent_request_id
    WHERE presentation.practice_id = NEW.practice_id
      AND presentation.plan_id = NEW.plan_id
      AND presentation.status = 'awaiting_signature'
      AND (presentation.expires_at > pg_catalog.clock_timestamp()
           OR consent.status IN ('signing', 'signed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan is awaiting a client signature';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_revision_signing_guard
BEFORE INSERT ON public.visit_treatment_plan_revisions
FOR EACH ROW EXECUTE FUNCTION public.reject_revision_while_treatment_plan_signing();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_treatment_plan_close_while_signing()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN NEW; END IF;
  IF OLD.status = 'open' AND NEW.status <> 'open' AND EXISTS (
    SELECT 1 FROM public.visit_treatment_plan_presentations presentation
    LEFT JOIN public.consent_requests consent
      ON consent.practice_id = presentation.practice_id
     AND consent.id = presentation.consent_request_id
    WHERE presentation.practice_id = OLD.practice_id
      AND presentation.plan_id = OLD.id
      AND presentation.status = 'awaiting_signature'
      AND (presentation.expires_at > pg_catalog.clock_timestamp()
           OR consent.status IN ('signing', 'signed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan is awaiting a client signature';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_close_signing_guard
BEFORE UPDATE ON public.visit_treatment_plans
FOR EACH ROW EXECUTE FUNCTION public.reject_treatment_plan_close_while_signing();
