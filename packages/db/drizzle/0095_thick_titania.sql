CREATE TYPE "public"."visit_treatment_plan_decision" AS ENUM('accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."visit_treatment_plan_item_type" AS ENUM('service', 'product');--> statement-breakpoint
CREATE TYPE "public"."visit_treatment_plan_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "visit_treatment_plan_response_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"revision_line_id" uuid NOT NULL,
	"decision" "visit_treatment_plan_decision" NOT NULL,
	"accepted_quantity" numeric(12, 3) NOT NULL,
	"decline_reason" text,
	CONSTRAINT "visit_treatment_plan_response_lines_decision_quantity_check" CHECK (("visit_treatment_plan_response_lines"."decision" = 'accepted' and "visit_treatment_plan_response_lines"."accepted_quantity" > 0) or ("visit_treatment_plan_response_lines"."decision" = 'declined' and "visit_treatment_plan_response_lines"."accepted_quantity" = 0)),
	CONSTRAINT "visit_treatment_plan_response_lines_decline_reason_check" CHECK ("visit_treatment_plan_response_lines"."decline_reason" is null or length(btrim("visit_treatment_plan_response_lines"."decline_reason")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "visit_treatment_plan_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"consent_request_id" uuid NOT NULL,
	"signed_file_id" uuid NOT NULL,
	"signature_sha256" varchar(64) NOT NULL,
	"signed_document_sha256" varchar(64) NOT NULL,
	"signer_name" varchar(120) NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	"response_sha256" varchar(64) NOT NULL,
	CONSTRAINT "visit_treatment_plan_responses_signer_name_check" CHECK (length(btrim("visit_treatment_plan_responses"."signer_name")) between 1 and 120),
	CONSTRAINT "visit_treatment_plan_responses_operation_payload_hash_check" CHECK ("visit_treatment_plan_responses"."operation_payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_responses_response_hash_check" CHECK ("visit_treatment_plan_responses"."response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_responses_signature_hash_check" CHECK ("visit_treatment_plan_responses"."signature_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_responses_document_hash_check" CHECK ("visit_treatment_plan_responses"."signed_document_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "visit_treatment_plan_revision_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"description" varchar(500) NOT NULL,
	"offered_quantity" numeric(12, 3) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"line_subtotal" numeric(12, 2) NOT NULL,
	"tax_amount" numeric(12, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"taxable" boolean NOT NULL,
	"item_type" "visit_treatment_plan_item_type" NOT NULL,
	"service_id" uuid,
	"product_id" uuid,
	CONSTRAINT "visit_treatment_plan_revision_lines_sort_order_check" CHECK ("visit_treatment_plan_revision_lines"."sort_order" >= 0),
	CONSTRAINT "visit_treatment_plan_revision_lines_description_check" CHECK (length(btrim("visit_treatment_plan_revision_lines"."description")) between 1 and 500),
	CONSTRAINT "visit_treatment_plan_revision_lines_money_check" CHECK ("visit_treatment_plan_revision_lines"."offered_quantity" > 0 and "visit_treatment_plan_revision_lines"."unit_price" >= 0 and "visit_treatment_plan_revision_lines"."line_subtotal" = round("visit_treatment_plan_revision_lines"."offered_quantity" * "visit_treatment_plan_revision_lines"."unit_price", 2) and "visit_treatment_plan_revision_lines"."tax_amount" >= 0 and "visit_treatment_plan_revision_lines"."line_total" = "visit_treatment_plan_revision_lines"."line_subtotal" + "visit_treatment_plan_revision_lines"."tax_amount"),
	CONSTRAINT "visit_treatment_plan_revision_lines_catalog_target_check" CHECK (("visit_treatment_plan_revision_lines"."item_type" = 'service' and "visit_treatment_plan_revision_lines"."service_id" is not null and "visit_treatment_plan_revision_lines"."product_id" is null) or ("visit_treatment_plan_revision_lines"."item_type" = 'product' and "visit_treatment_plan_revision_lines"."product_id" is not null and "visit_treatment_plan_revision_lines"."service_id" is null))
);
--> statement-breakpoint
CREATE TABLE "visit_treatment_plan_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"tax" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"authored_by" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	CONSTRAINT "visit_treatment_plan_revisions_number_check" CHECK ("visit_treatment_plan_revisions"."revision_number" >= 1),
	CONSTRAINT "visit_treatment_plan_revisions_currency_check" CHECK ("visit_treatment_plan_revisions"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "visit_treatment_plan_revisions_totals_check" CHECK ("visit_treatment_plan_revisions"."subtotal" >= 0 and "visit_treatment_plan_revisions"."tax" >= 0 and "visit_treatment_plan_revisions"."total" = "visit_treatment_plan_revisions"."subtotal" + "visit_treatment_plan_revisions"."tax"),
	CONSTRAINT "visit_treatment_plan_revisions_operation_payload_hash_check" CHECK ("visit_treatment_plan_revisions"."operation_payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "visit_treatment_plan_revisions_content_hash_check" CHECK ("visit_treatment_plan_revisions"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "visit_treatment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"created_by" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" "visit_treatment_plan_status" DEFAULT 'open' NOT NULL,
	"operation_id" uuid NOT NULL,
	"operation_payload_hash" varchar(64) NOT NULL,
	CONSTRAINT "visit_treatment_plans_title_check" CHECK (length(btrim("visit_treatment_plans"."title")) between 1 and 255),
	CONSTRAINT "visit_treatment_plans_operation_payload_hash_check" CHECK ("visit_treatment_plans"."operation_payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- Composite tenant targets must exist before their foreign keys are added.
CREATE UNIQUE INDEX "patients_practice_client_id_uq" ON "patients" USING btree ("practice_id","id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_practice_patient_client_id_uq" ON "appointments" USING btree ("practice_id","id","patient_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_practice_id_uq" ON "services" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plans_practice_id_uq" ON "visit_treatment_plans" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_revisions_practice_plan_id_uq" ON "visit_treatment_plan_revisions" USING btree ("practice_id","id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_revision_lines_practice_revision_id_uq" ON "visit_treatment_plan_revision_lines" USING btree ("practice_id","id","revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_responses_practice_revision_id_uq" ON "visit_treatment_plan_responses" USING btree ("practice_id","id","revision_id");--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_response_lines" ADD CONSTRAINT "visit_treatment_plan_response_lines_response_tenant_fk" FOREIGN KEY ("practice_id","response_id","revision_id") REFERENCES "public"."visit_treatment_plan_responses"("practice_id","id","revision_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_response_lines" ADD CONSTRAINT "visit_treatment_plan_response_lines_revision_line_tenant_fk" FOREIGN KEY ("practice_id","revision_line_id","revision_id") REFERENCES "public"."visit_treatment_plan_revision_lines"("practice_id","id","revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_responses" ADD CONSTRAINT "visit_treatment_plan_responses_revision_tenant_fk" FOREIGN KEY ("practice_id","revision_id","plan_id") REFERENCES "public"."visit_treatment_plan_revisions"("practice_id","id","plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_responses" ADD CONSTRAINT "visit_treatment_plan_responses_signed_file_tenant_fk" FOREIGN KEY ("practice_id","signed_file_id") REFERENCES "public"."files"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revision_lines" ADD CONSTRAINT "visit_treatment_plan_revision_lines_revision_tenant_fk" FOREIGN KEY ("practice_id","revision_id","plan_id") REFERENCES "public"."visit_treatment_plan_revisions"("practice_id","id","plan_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revision_lines" ADD CONSTRAINT "visit_treatment_plan_revision_lines_plan_tenant_fk" FOREIGN KEY ("practice_id","plan_id") REFERENCES "public"."visit_treatment_plans"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revision_lines" ADD CONSTRAINT "visit_treatment_plan_revision_lines_service_tenant_fk" FOREIGN KEY ("practice_id","service_id") REFERENCES "public"."services"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revision_lines" ADD CONSTRAINT "visit_treatment_plan_revision_lines_product_tenant_fk" FOREIGN KEY ("practice_id","product_id") REFERENCES "public"."products"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revisions" ADD CONSTRAINT "visit_treatment_plan_revisions_plan_tenant_fk" FOREIGN KEY ("practice_id","plan_id") REFERENCES "public"."visit_treatment_plans"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_revisions" ADD CONSTRAINT "visit_treatment_plan_revisions_author_tenant_fk" FOREIGN KEY ("practice_id","authored_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plans" ADD CONSTRAINT "visit_treatment_plans_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plans" ADD CONSTRAINT "visit_treatment_plans_patient_client_tenant_fk" FOREIGN KEY ("practice_id","patient_id","client_id") REFERENCES "public"."patients"("practice_id","id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plans" ADD CONSTRAINT "visit_treatment_plans_appointment_tenant_fk" FOREIGN KEY ("practice_id","appointment_id","patient_id","client_id") REFERENCES "public"."appointments"("practice_id","id","patient_id","client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plans" ADD CONSTRAINT "visit_treatment_plans_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_response_lines_response_line_uq" ON "visit_treatment_plan_response_lines" USING btree ("response_id","revision_line_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_response_lines_response_idx" ON "visit_treatment_plan_response_lines" USING btree ("practice_id","response_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_responses_revision_uq" ON "visit_treatment_plan_responses" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_responses_consent_uq" ON "visit_treatment_plan_responses" USING btree ("consent_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_responses_practice_operation_uq" ON "visit_treatment_plan_responses" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_responses_plan_history_idx" ON "visit_treatment_plan_responses" USING btree ("practice_id","plan_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_revision_lines_revision_order_uq" ON "visit_treatment_plan_revision_lines" USING btree ("revision_id","sort_order");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_revision_lines_revision_order_idx" ON "visit_treatment_plan_revision_lines" USING btree ("practice_id","revision_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_revisions_plan_revision_uq" ON "visit_treatment_plan_revisions" USING btree ("plan_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_revisions_practice_operation_uq" ON "visit_treatment_plan_revisions" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_revisions_plan_history_idx" ON "visit_treatment_plan_revisions" USING btree ("practice_id","plan_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plans_practice_operation_uq" ON "visit_treatment_plans" USING btree ("practice_id","operation_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plans_patient_history_idx" ON "visit_treatment_plans" USING btree ("practice_id","patient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plans_appointment_idx" ON "visit_treatment_plans" USING btree ("practice_id","appointment_id","created_at");--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compute_visit_treatment_plan_revision_sha256(
  p_practice_id uuid, p_plan_id uuid, p_revision_id uuid,
  p_revision_number integer, p_currency text,
  p_subtotal numeric, p_tax numeric, p_total numeric
) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'version', 1, 'practiceId', p_practice_id::text,
      'planId', p_plan_id::text, 'revisionId', p_revision_id::text,
      'revisionNumber', p_revision_number, 'currency', p_currency,
      'subtotal', pg_catalog.round(p_subtotal, 2),
      'tax', pg_catalog.round(p_tax, 2),
      'total', pg_catalog.round(p_total, 2),
      'lines', coalesce((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', line.id::text, 'sortOrder', line.sort_order,
          'description', line.description,
          'offeredQuantity', line.offered_quantity,
          'unitPrice', line.unit_price, 'lineSubtotal', line.line_subtotal,
          'taxAmount', line.tax_amount, 'lineTotal', line.line_total,
          'taxable', line.taxable, 'itemType', line.item_type::text,
          'serviceId', line.service_id::text, 'productId', line.product_id::text
        ) ORDER BY line.sort_order, line.id)
        FROM public.visit_treatment_plan_revision_lines line
        WHERE line.practice_id = p_practice_id
          AND line.plan_id = p_plan_id AND line.revision_id = p_revision_id
      ), '[]'::jsonb)
    )::text, 'UTF8')), 'hex')
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.compute_visit_treatment_plan_response_sha256(
  p_practice_id uuid, p_plan_id uuid, p_revision_id uuid, p_response_id uuid
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
          'revisionLineId', decision.revision_line_id::text,
          'decision', decision.decision::text,
          'acceptedQuantity', decision.accepted_quantity,
          'declineReason', decision.decline_reason
        ) ORDER BY offered.sort_order, offered.id)
        FROM public.visit_treatment_plan_response_lines decision
        JOIN public.visit_treatment_plan_revision_lines offered
          ON offered.practice_id = decision.practice_id
         AND offered.id = decision.revision_line_id
         AND offered.revision_id = decision.revision_id
        WHERE decision.practice_id = p_practice_id
          AND decision.revision_id = p_revision_id
          AND decision.response_id = p_response_id
      ), '[]'::jsonb)
    )::text, 'UTF8')), 'hex')
  FROM public.visit_treatment_plan_revisions revision
  WHERE revision.practice_id = p_practice_id
    AND revision.plan_id = p_plan_id AND revision.id = p_revision_id
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_visit_treatment_plan_revision_seal()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  expected_revision integer;
  line_count integer;
  stored_subtotal numeric;
  stored_tax numeric;
  stored_total numeric;
  expected_hash text;
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.visit_treatment_plans plan
    WHERE plan.practice_id = NEW.practice_id AND plan.id = NEW.plan_id
      AND plan.status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Treatment plan is missing, closed, or outside the active practice'; END IF;
  SELECT coalesce(max(revision_number), 0) + 1 INTO expected_revision
    FROM public.visit_treatment_plan_revisions
    WHERE practice_id = NEW.practice_id AND plan_id = NEW.plan_id;
  IF NEW.revision_number <> expected_revision THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan revision number is stale or non-sequential'; END IF;
  SELECT count(*)::integer, coalesce(sum(line_subtotal), 0),
         coalesce(sum(tax_amount), 0), coalesce(sum(line_total), 0)
    INTO line_count, stored_subtotal, stored_tax, stored_total
    FROM public.visit_treatment_plan_revision_lines
    WHERE practice_id = NEW.practice_id AND plan_id = NEW.plan_id
      AND revision_id = NEW.id;
  IF line_count = 0 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan revision must contain at least one offered line'; END IF;
  IF stored_subtotal <> NEW.subtotal OR stored_tax <> NEW.tax OR stored_total <> NEW.total THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan revision totals do not match its offered lines'; END IF;
  expected_hash := public.compute_visit_treatment_plan_revision_sha256(
    NEW.practice_id, NEW.plan_id, NEW.id, NEW.revision_number,
    NEW.currency, NEW.subtotal, NEW.tax, NEW.total);
  IF NEW.content_sha256 <> expected_hash THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan revision content hash does not match its stored snapshot'; END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_revision_seal BEFORE INSERT ON public.visit_treatment_plan_revisions
FOR EACH ROW EXECUTE FUNCTION public.validate_visit_treatment_plan_revision_seal();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sealed treatment plan revisions are immutable';
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_revision_immutable BEFORE UPDATE OR DELETE ON public.visit_treatment_plan_revisions
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_revision();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_revision_line()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE old_sealed boolean := false; new_sealed boolean := false;
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM public.visit_treatment_plan_revisions revision
      WHERE revision.practice_id = OLD.practice_id AND revision.id = OLD.revision_id
        AND revision.plan_id = OLD.plan_id) INTO old_sealed;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM public.visit_treatment_plan_revisions revision
      WHERE revision.practice_id = NEW.practice_id AND revision.id = NEW.revision_id
        AND revision.plan_id = NEW.plan_id) INTO new_sealed;
  END IF;
  IF old_sealed OR new_sealed THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sealed treatment plan revision lines are immutable'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_revision_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.visit_treatment_plan_revision_lines
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_revision_line();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_visit_treatment_plan_response_seal()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  revision_row record;
  offered_count integer;
  decision_count integer;
  invalid_quantity_count integer;
  evidence_matches boolean;
  expected_hash text;
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN NEW; END IF;
  SELECT revision.content_sha256, plan.patient_id, plan.appointment_id
    INTO revision_row
    FROM public.visit_treatment_plan_revisions revision
    JOIN public.visit_treatment_plans plan
      ON plan.practice_id = revision.practice_id AND plan.id = revision.plan_id
    WHERE revision.practice_id = NEW.practice_id
      AND revision.plan_id = NEW.plan_id AND revision.id = NEW.revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Treatment plan revision is missing or outside the active practice'; END IF;
  SELECT count(*)::integer INTO offered_count
    FROM public.visit_treatment_plan_revision_lines
    WHERE practice_id = NEW.practice_id AND revision_id = NEW.revision_id;
  SELECT count(*)::integer,
         count(*) FILTER (WHERE decision.accepted_quantity > offered.offered_quantity)::integer
    INTO decision_count, invalid_quantity_count
    FROM public.visit_treatment_plan_response_lines decision
    JOIN public.visit_treatment_plan_revision_lines offered
      ON offered.practice_id = decision.practice_id
     AND offered.id = decision.revision_line_id
     AND offered.revision_id = decision.revision_id
    WHERE decision.practice_id = NEW.practice_id
      AND decision.revision_id = NEW.revision_id AND decision.response_id = NEW.id;
  IF offered_count = 0 OR decision_count <> offered_count THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan response must decide every offered line exactly once'; END IF;
  IF invalid_quantity_count > 0 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan response cannot accept more than the offered quantity'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.consent_requests request_row
    JOIN public.files signed_file
      ON signed_file.practice_id = request_row.practice_id AND signed_file.id = request_row.file_id
    WHERE request_row.practice_id = NEW.practice_id AND request_row.id = NEW.consent_request_id
      AND request_row.patient_id = revision_row.patient_id
      AND (revision_row.appointment_id IS NULL OR request_row.appointment_id = revision_row.appointment_id)
      AND request_row.status = 'signed' AND request_row.signer_name = NEW.signer_name
      AND request_row.signed_at = NEW.decided_at AND request_row.file_id = NEW.signed_file_id
      AND request_row.signature_sha256 = NEW.signature_sha256
      AND signed_file.checksum_sha256 = NEW.signed_document_sha256
      AND signed_file.storage_status = 'available' AND signed_file.deleted_at IS NULL
      AND pg_catalog.strpos(request_row.body_text, 'Treatment plan response SHA-256: ' || NEW.response_sha256) > 0
      AND request_row.deleted_at IS NULL
  ) INTO evidence_matches;
  IF NOT evidence_matches THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Signed consent does not bind this exact treatment plan response'; END IF;
  expected_hash := public.compute_visit_treatment_plan_response_sha256(NEW.practice_id, NEW.plan_id, NEW.revision_id, NEW.id);
  IF NEW.response_sha256 <> expected_hash THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan response hash does not match its stored decisions'; END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_response_seal BEFORE INSERT ON public.visit_treatment_plan_responses
FOR EACH ROW EXECUTE FUNCTION public.validate_visit_treatment_plan_response_seal();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_response()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sealed treatment plan responses are immutable';
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_response_immutable BEFORE UPDATE OR DELETE ON public.visit_treatment_plan_responses
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_response();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_response_line()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE old_sealed boolean := false; new_sealed boolean := false;
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM public.visit_treatment_plan_responses response
      WHERE response.practice_id = OLD.practice_id AND response.id = OLD.response_id
        AND response.revision_id = OLD.revision_id) INTO old_sealed;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM public.visit_treatment_plan_responses response
      WHERE response.practice_id = NEW.practice_id AND response.id = NEW.response_id
        AND response.revision_id = NEW.revision_id) INTO new_sealed;
  END IF;
  IF old_sealed OR new_sealed THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sealed treatment plan response lines are immutable'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_response_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.visit_treatment_plan_response_lines
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_response_line();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF coalesce(pg_catalog.current_setting('app.rls_bypass', true), '') = 'on' THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan identities cannot be deleted'; END IF;
  IF OLD.status <> 'open' AND NEW.status <> OLD.status THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Completed or cancelled treatment plans cannot be reopened'; END IF;
  IF EXISTS (SELECT 1 FROM public.visit_treatment_plan_revisions WHERE practice_id = OLD.practice_id AND plan_id = OLD.id)
     AND ROW(NEW.practice_id, NEW.client_id, NEW.patient_id, NEW.appointment_id,
             NEW.created_by, NEW.title, NEW.operation_id, NEW.operation_payload_hash)
         IS DISTINCT FROM
         ROW(OLD.practice_id, OLD.client_id, OLD.patient_id, OLD.appointment_id,
             OLD.created_by, OLD.title, OLD.operation_id, OLD.operation_payload_hash)
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Treatment plan identity cannot change after its first revision'; END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER visit_treatment_plan_identity_guard BEFORE UPDATE OR DELETE ON public.visit_treatment_plans
FOR EACH ROW EXECUTE FUNCTION public.protect_visit_treatment_plan_identity();
