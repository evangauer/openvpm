SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

CREATE TABLE "consent_receipt_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"consent_request_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"file_checksum_sha256" varchar(64) NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"max_claims" integer DEFAULT 3 NOT NULL,
	"last_claimed_at" timestamp with time zone,
	CONSTRAINT "consent_receipt_capabilities_token_hash_check" CHECK ("consent_receipt_capabilities"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consent_receipt_capabilities_checksum_check" CHECK ("consent_receipt_capabilities"."file_checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "consent_receipt_capabilities_file_size_check" CHECK ("consent_receipt_capabilities"."file_size_bytes" > 0),
	CONSTRAINT "consent_receipt_capabilities_expiry_check" CHECK ("consent_receipt_capabilities"."expires_at" > "consent_receipt_capabilities"."created_at" and "consent_receipt_capabilities"."expires_at" <= "consent_receipt_capabilities"."created_at" + interval '15 minutes'),
	CONSTRAINT "consent_receipt_capabilities_claims_check" CHECK ("consent_receipt_capabilities"."max_claims" between 1 and 3 and "consent_receipt_capabilities"."claim_count" between 0 and "consent_receipt_capabilities"."max_claims"),
	CONSTRAINT "consent_receipt_capabilities_claim_evidence_check" CHECK (("consent_receipt_capabilities"."claim_count" = 0 and "consent_receipt_capabilities"."last_claimed_at" is null) or ("consent_receipt_capabilities"."claim_count" > 0 and "consent_receipt_capabilities"."last_claimed_at" is not null))
);
--> statement-breakpoint
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
ALTER TABLE "consent_requests" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signature_method" varchar(16);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signer_attestation_version" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "document_render_version" varchar(32);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "storage_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "storage_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signed_file_key" varchar(512);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signed_file_checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signed_file_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signed_file_object_etag" varchar(255);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signed_file_object_version_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_practice_id_uq" ON "consent_requests" USING btree ("practice_id","id");--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_consent_request_id_consent_requests_id_fk" FOREIGN KEY ("consent_request_id") REFERENCES "public"."consent_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_consent_tenant_fk" FOREIGN KEY ("practice_id","consent_request_id") REFERENCES "public"."consent_requests"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_file_tenant_fk" FOREIGN KEY ("practice_id","file_id") REFERENCES "public"."files"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_revision_tenant_fk" FOREIGN KEY ("practice_id","revision_id","plan_id") REFERENCES "public"."visit_treatment_plan_revisions"("practice_id","id","plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_plan_tenant_fk" FOREIGN KEY ("practice_id","plan_id") REFERENCES "public"."visit_treatment_plans"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_creator_tenant_fk" FOREIGN KEY ("practice_id","created_by") REFERENCES "public"."users"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_treatment_plan_presentations" ADD CONSTRAINT "visit_treatment_plan_presentations_consent_tenant_fk" FOREIGN KEY ("practice_id","consent_request_id") REFERENCES "public"."consent_requests"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_receipt_capabilities_token_hash_uq" ON "consent_receipt_capabilities" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_receipt_capabilities_consent_uq" ON "consent_receipt_capabilities" USING btree ("practice_id","consent_request_id");--> statement-breakpoint
CREATE INDEX "consent_receipt_capabilities_practice_expiry_idx" ON "consent_receipt_capabilities" USING btree ("practice_id","expires_at") WHERE "consent_receipt_capabilities"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_token_hash_uq" ON "visit_treatment_plan_presentations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_response_uq" ON "visit_treatment_plan_presentations" USING btree ("response_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_treatment_plan_presentations_consent_uq" ON "visit_treatment_plan_presentations" USING btree ("consent_request_id");--> statement-breakpoint
CREATE INDEX "visit_treatment_plan_presentations_revision_status_idx" ON "visit_treatment_plan_presentations" USING btree ("practice_id","revision_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_token_hash_uq" ON "consent_requests" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_credential_storage_check" CHECK (("consent_requests"."token" is not null and "consent_requests"."token_hash" is null) or ("consent_requests"."token" is null and "consent_requests"."token_hash" is not null));--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_token_hash_format_check" CHECK ("consent_requests"."token_hash" is null or "consent_requests"."token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_document_render_version_check" CHECK ("consent_requests"."document_render_version" is null or "consent_requests"."document_render_version" in ('consent-pdf-v1', 'consent-pdf-v2'));--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_storage_lease_pair_check" CHECK (("consent_requests"."storage_lease_token" is null and "consent_requests"."storage_lease_expires_at" is null) or ("consent_requests"."storage_lease_token" is not null and "consent_requests"."storage_lease_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_storage_lease_state_check" CHECK ("consent_requests"."storage_lease_token" is null or "consent_requests"."status" = 'signing');--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_signature_method_check" CHECK ("consent_requests"."signature_method" is null or "consent_requests"."signature_method" in ('drawn', 'typed'));--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_signed_file_binding_check" CHECK (("consent_requests"."signed_file_key" is null and "consent_requests"."signed_file_checksum_sha256" is null and "consent_requests"."signed_file_size_bytes" is null and "consent_requests"."signed_file_object_etag" is null and "consent_requests"."signed_file_object_version_id" is null) or ("consent_requests"."file_id" is not null and "consent_requests"."signed_file_key" is not null and "consent_requests"."signed_file_checksum_sha256" ~ '^[0-9a-f]{64}$' and "consent_requests"."signed_file_size_bytes" > 0));--> statement-breakpoint

-- Every signature created before the keyboard path was drawn. This is a
-- deterministic evidence classification, unlike guessing a PDF renderer.
UPDATE public.consent_requests
SET signature_method = 'drawn'
WHERE status = 'signing'
  AND signature_method IS NULL
  AND signature_png_bytes IS NOT NULL
  AND signature_sha256 IS NOT NULL;--> statement-breakpoint

-- Snapshot exact existing signed-file generations where the managed manifest
-- is complete. Rows whose legacy manifest is incomplete remain all-null and
-- are protected in place; a later signed row must always supply the full set.
UPDATE public.consent_requests AS consent
SET signed_file_key = file.file_key,
    signed_file_checksum_sha256 = file.checksum_sha256,
    signed_file_size_bytes = file.file_size_bytes,
    signed_file_object_etag = file.object_etag,
    signed_file_object_version_id = file.object_version_id
FROM public.files AS file
WHERE consent.status = 'signed'
  AND consent.file_id = file.id
  AND consent.practice_id = file.practice_id
  AND consent.signed_file_key IS NULL
  AND consent.signed_file_checksum_sha256 IS NULL
  AND consent.signed_file_size_bytes IS NULL
  AND consent.signed_file_object_etag IS NULL
  AND consent.signed_file_object_version_id IS NULL
  AND file.category = 'consents'
  AND file.source = 'consent_signature'
  AND file.mime_type = 'application/pdf'
  AND file.idempotency_key = consent.id
  AND file.patient_id = consent.patient_id
  AND file.storage_status = 'available'
  AND file.deleted_at IS NULL
  AND file.file_key IS NOT NULL
  AND file.checksum_sha256 ~ '^[0-9a-f]{64}$'
  AND file.file_size_bytes > 0;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_consent_request_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  changed_steps integer := 0;
  owner_name text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
  INTO owner_name
  FROM pg_catalog.pg_class AS class
  WHERE class.oid = 'public.consent_requests'::pg_catalog.regclass;

  -- A database owner can already disable triggers. Keep owner-only migrations
  -- and deterministic fixtures possible without creating an application-role
  -- escape hatch. app.rls_bypass is deliberately ignored here.
  IF current_user = owner_name THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.deleted_at IS NOT NULL
       OR NEW.signer_name IS NOT NULL
       OR NEW.signed_at IS NOT NULL
       OR NEW.signature_png_bytes IS NOT NULL
       OR NEW.signature_sha256 IS NOT NULL
       OR NEW.signature_method IS NOT NULL
       OR NEW.signer_attestation_version IS NOT NULL
       OR NEW.document_render_version IS NOT NULL
       OR NEW.file_id IS NOT NULL
       OR NEW.storage_lease_token IS NOT NULL
       OR NEW.storage_lease_expires_at IS NOT NULL
       OR NEW.signed_file_key IS NOT NULL
       OR NEW.signed_file_checksum_sha256 IS NOT NULL
       OR NEW.signed_file_size_bytes IS NOT NULL
       OR NEW.signed_file_object_etag IS NOT NULL
       OR NEW.signed_file_object_version_id IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent requests must begin pending without signer evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Consent requests cannot be deleted';
  END IF;

  IF ROW(NEW.id, NEW.created_at, NEW.practice_id, NEW.patient_id,
         NEW.created_by, NEW.appointment_id, NEW.form_id, NEW.token,
         NEW.token_hash, NEW.expires_at, NEW.title, NEW.body_text)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.created_at, OLD.practice_id, OLD.patient_id,
         OLD.created_by, OLD.appointment_id, OLD.form_id, OLD.token,
         OLD.token_hash, OLD.expires_at, OLD.title, OLD.body_text)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent request identity and content are immutable';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent requests cannot be soft-deleted';
  END IF;

  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent evidence is terminal';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF ROW(NEW.signer_name, NEW.signed_at, NEW.signature_png_bytes,
           NEW.signature_sha256, NEW.signature_method,
           NEW.signer_attestation_version, NEW.document_render_version,
           NEW.file_id, NEW.storage_lease_token,
           NEW.storage_lease_expires_at, NEW.signed_file_key,
           NEW.signed_file_checksum_sha256, NEW.signed_file_size_bytes,
           NEW.signed_file_object_etag, NEW.signed_file_object_version_id)
       IS DISTINCT FROM
       ROW(OLD.signer_name, OLD.signed_at, OLD.signature_png_bytes,
           OLD.signature_sha256, OLD.signature_method,
           OLD.signer_attestation_version, OLD.document_render_version,
           OLD.file_id, OLD.storage_lease_token,
           OLD.storage_lease_expires_at, OLD.signed_file_key,
           OLD.signed_file_checksum_sha256, OLD.signed_file_size_bytes,
           OLD.signed_file_object_etag, OLD.signed_file_object_version_id)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Pending consent evidence cannot be edited';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'signing' THEN
    IF NEW.signer_name IS NULL
       OR pg_catalog.length(pg_catalog.btrim(NEW.signer_name)) NOT BETWEEN 1 AND 120
       OR NEW.signed_at IS NULL
       OR NEW.signature_png_bytes IS NULL
       OR NEW.signature_sha256 IS NULL
       OR NEW.signature_method NOT IN ('drawn', 'typed')
       OR NEW.signer_attestation_version <> 'owner-authority-v1'
       OR NEW.document_render_version <> 'consent-pdf-v2'
       OR NEW.file_id IS NOT NULL
       OR NEW.storage_lease_token IS NOT NULL
       OR NEW.storage_lease_expires_at IS NOT NULL
       OR NEW.signed_file_key IS NOT NULL
       OR NEW.signed_file_checksum_sha256 IS NOT NULL
       OR NEW.signed_file_size_bytes IS NOT NULL
       OR NEW.signed_file_object_etag IS NOT NULL
       OR NEW.signed_file_object_version_id IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Signing claim requires complete immutable evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'signing' AND NEW.status = 'signing' THEN
    IF ROW(NEW.signer_name, NEW.signed_at, NEW.signature_png_bytes,
           NEW.signature_sha256, NEW.signature_method)
       IS DISTINCT FROM
       ROW(OLD.signer_name, OLD.signed_at, OLD.signature_png_bytes,
           OLD.signature_sha256, OLD.signature_method)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Signer evidence is immutable after signing begins';
    END IF;
    IF ROW(NEW.signed_file_key, NEW.signed_file_checksum_sha256,
           NEW.signed_file_size_bytes, NEW.signed_file_object_etag,
           NEW.signed_file_object_version_id)
       IS DISTINCT FROM
       ROW(OLD.signed_file_key, OLD.signed_file_checksum_sha256,
           OLD.signed_file_size_bytes, OLD.signed_file_object_etag,
           OLD.signed_file_object_version_id)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Final signed-file evidence is set only at finalization';
    END IF;

    IF NEW.signer_attestation_version IS DISTINCT FROM OLD.signer_attestation_version THEN
      changed_steps := changed_steps + 1;
      IF OLD.signer_attestation_version IS NOT NULL
         OR NEW.signer_attestation_version <> 'owner-authority-v1'
         OR OLD.expires_at <= pg_catalog.clock_timestamp()
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Legacy signer authority may be acknowledged only once on a live link';
      END IF;
    END IF;

    IF NEW.document_render_version IS DISTINCT FROM OLD.document_render_version THEN
      changed_steps := changed_steps + 1;
      -- Direct application-role renderer recovery is forbidden. The narrowly
      -- scoped resolver below compares both frozen generations to the durable
      -- reservation and performs the one-time CAS as its owner.
      IF OLD.document_render_version IS NOT NULL
         OR NEW.document_render_version NOT IN ('consent-pdf-v1', 'consent-pdf-v2')
         OR current_user = session_user
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Legacy consent renderer requires deterministic recovery';
      END IF;
    END IF;

    IF NEW.file_id IS DISTINCT FROM OLD.file_id THEN
      changed_steps := changed_steps + 1;
      IF OLD.file_id IS NOT NULL OR NEW.file_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.files AS file
        WHERE file.id = NEW.file_id
          AND file.practice_id = OLD.practice_id
          AND file.idempotency_key = OLD.id
          AND file.category = 'consents'
          AND file.source = 'consent_signature'
          AND file.mime_type = 'application/pdf'
          AND file.patient_id = OLD.patient_id
          AND file.storage_status = 'pending_upload'
          AND file.deleted_at IS NULL
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Consent file binding must target its exact reservation';
      END IF;
    END IF;

    IF ROW(NEW.storage_lease_token, NEW.storage_lease_expires_at)
       IS DISTINCT FROM
       ROW(OLD.storage_lease_token, OLD.storage_lease_expires_at)
    THEN
      changed_steps := changed_steps + 1;
      IF NEW.storage_lease_token IS NULL THEN
        IF OLD.storage_lease_token IS NULL
           OR NEW.storage_lease_expires_at IS NOT NULL
           OR current_user = session_user
        THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'Consent render lease release requires its exact fenced function';
        END IF;
      ELSE
        IF NEW.storage_lease_expires_at IS NULL
           OR NEW.storage_lease_expires_at <= pg_catalog.clock_timestamp()
           OR NEW.storage_lease_expires_at > pg_catalog.clock_timestamp() + interval '5 minutes'
           OR (OLD.storage_lease_token IS NOT NULL
               AND OLD.storage_lease_expires_at > pg_catalog.clock_timestamp())
        THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'Consent render lease acquisition requires an absent or stale fence';
        END IF;
      END IF;
    END IF;

    IF changed_steps > 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent signing recovery transitions must be isolated';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'signing' AND NEW.status = 'signed' THEN
    IF ROW(NEW.signer_name, NEW.signed_at, NEW.signature_png_bytes,
           NEW.signature_sha256, NEW.signature_method,
           NEW.signer_attestation_version, NEW.document_render_version,
           NEW.file_id)
       IS DISTINCT FROM
       ROW(OLD.signer_name, OLD.signed_at, OLD.signature_png_bytes,
           OLD.signature_sha256, OLD.signature_method,
           OLD.signer_attestation_version, OLD.document_render_version,
           OLD.file_id)
       OR OLD.file_id IS NULL
       OR OLD.storage_lease_token IS NULL
       OR NEW.storage_lease_token IS NOT NULL
       OR NEW.storage_lease_expires_at IS NOT NULL
       OR NEW.signature_method NOT IN ('drawn', 'typed')
       OR NEW.signer_attestation_version <> 'owner-authority-v1'
       OR NEW.document_render_version NOT IN ('consent-pdf-v1', 'consent-pdf-v2')
       OR current_user = session_user
       OR NEW.signed_file_key IS NULL
       OR NEW.signed_file_checksum_sha256 !~ '^[0-9a-f]{64}$'
       OR NEW.signed_file_size_bytes IS NULL
       OR NEW.signed_file_size_bytes <= 0
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent finalization requires unchanged signer and exact file evidence';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Invalid consent request state transition';
END
$fn$;--> statement-breakpoint

CREATE TRIGGER consent_requests_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.consent_requests
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_request_evidence();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_consent_signature_file()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  owner_name text;
  linked_status text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
  INTO owner_name
  FROM pg_catalog.pg_class AS class
  WHERE class.oid = 'public.files'::pg_catalog.regclass;
  IF current_user = owner_name THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.category <> 'consents' OR NEW.source <> 'consent_signature' THEN
      RETURN NEW;
    END IF;
    IF NEW.storage_status <> 'pending_upload'
       OR NEW.mime_type <> 'application/pdf'
       OR NEW.file_size_bytes IS NULL
       OR NEW.file_size_bytes <= 0
       OR NEW.checksum_sha256 !~ '^[0-9a-f]{64}$'
       OR NEW.idempotency_key IS NULL
       OR NEW.patient_id IS NULL
       OR NEW.entity_type <> 'patient'
       OR NEW.entity_id IS DISTINCT FROM NEW.patient_id
       OR NEW.deleted_at IS NOT NULL
       OR NEW.storage_verified_at IS NOT NULL
       OR NEW.object_etag IS NOT NULL
       OR NEW.object_version_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.consent_requests AS consent
         WHERE consent.id = NEW.idempotency_key
           AND consent.practice_id = NEW.practice_id
           AND consent.patient_id = NEW.patient_id
           AND consent.created_by = NEW.uploaded_by
           AND consent.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
           AND consent.status = 'signing'
           AND consent.deleted_at IS NULL
           AND (
             consent.file_id IS NULL
             OR EXISTS (
               -- reserveManagedUpload begins an idempotent retry with an
               -- INSERT .. ON CONFLICT before selecting the durable row. Its
               -- random candidate ID may reach this BEFORE trigger, so admit
               -- it only when the already-bound reservation proves that the
               -- attempted manifest is byte-for-byte and identity-equivalent;
               -- the unique idempotency index then prevents the candidate row.
               SELECT 1
               FROM public.files AS reserved
               WHERE reserved.id = consent.file_id
                 AND reserved.practice_id = consent.practice_id
                 AND reserved.idempotency_key = consent.id
                 AND reserved.uploaded_by = NEW.uploaded_by
                 AND reserved.file_name = NEW.file_name
                 AND reserved.mime_type = NEW.mime_type
                 AND reserved.file_size_bytes = NEW.file_size_bytes
                 AND reserved.checksum_sha256 = NEW.checksum_sha256
                 AND reserved.category = NEW.category
                 AND reserved.source = NEW.source
                 AND reserved.entity_type IS NOT DISTINCT FROM NEW.entity_type
                 AND reserved.entity_id IS NOT DISTINCT FROM NEW.entity_id
                 AND reserved.patient_id IS NOT DISTINCT FROM NEW.patient_id
                 AND reserved.appointment_id IS NOT DISTINCT FROM NEW.appointment_id
                 AND reserved.deleted_at IS NULL
             )
           )
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent signature reservation must match an active signing request';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.category <> 'consents' OR OLD.source <> 'consent_signature')
     AND (NEW.category = 'consents' AND NEW.source = 'consent_signature')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Existing files cannot become consent signature evidence';
  END IF;
  IF OLD.category <> 'consents' OR OLD.source <> 'consent_signature' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Consent signature files cannot be deleted';
  END IF;

  SELECT consent.status
  INTO linked_status
  FROM public.consent_requests AS consent
  WHERE consent.practice_id = OLD.practice_id
    AND consent.file_id = OLD.id
  LIMIT 1;

  IF ROW(NEW.id, NEW.created_at, NEW.practice_id, NEW.uploaded_by,
         NEW.file_name, NEW.mime_type, NEW.file_size_bytes,
         NEW.checksum_sha256, NEW.category, NEW.source, NEW.idempotency_key,
         NEW.entity_type, NEW.entity_id, NEW.patient_id, NEW.appointment_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.created_at, OLD.practice_id, OLD.uploaded_by,
         OLD.file_name, OLD.mime_type, OLD.file_size_bytes,
         OLD.checksum_sha256, OLD.category, OLD.source, OLD.idempotency_key,
         OLD.entity_type, OLD.entity_id, OLD.patient_id, OLD.appointment_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent signature file identity and bytes are immutable';
  END IF;

  -- The normal completion transaction marks the request signed before this
  -- pending manifest becomes available. The deferred constraint below checks
  -- their exact final state at commit.
  IF OLD.storage_status = 'pending_upload' AND NEW.storage_status IN ('available', 'corrupt') THEN
    IF NEW.file_key IS DISTINCT FROM OLD.file_key
       OR NEW.file_url IS DISTINCT FROM OLD.file_url
       OR (NEW.storage_status = 'available' AND NEW.storage_verified_at IS NULL)
       OR (NEW.storage_status = 'corrupt' AND NEW.storage_verified_at IS NOT NULL)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Invalid consent upload finalization';
    END IF;
    RETURN NEW;
  END IF;

  IF linked_status = 'signed' THEN
    IF current_user = session_user THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Signed consent file changes require the recovery transition function';
    END IF;
    IF NEW.file_key IS DISTINCT FROM OLD.file_key
       OR NEW.file_url IS DISTINCT FROM OLD.file_url
       OR NEW.storage_status = 'cleanup_pending'
       OR NOT (
         (OLD.storage_status = 'available' AND NEW.storage_status IN ('missing', 'corrupt', 'unverified'))
         OR (OLD.storage_status IN ('missing', 'corrupt', 'unverified') AND NEW.storage_status = 'available')
       )
       OR (NEW.storage_status = 'available' AND NEW.storage_verified_at IS NULL)
       OR (NEW.storage_status <> 'available' AND NEW.storage_verified_at IS NOT NULL)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Invalid signed consent storage recovery transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.storage_status = 'corrupt' AND NEW.storage_status = 'pending_upload' THEN
    IF linked_status IS DISTINCT FROM 'signing'
       OR NEW.file_key IS NOT DISTINCT FROM OLD.file_key
       OR NEW.file_url IS NOT DISTINCT FROM OLD.file_url
       OR NEW.storage_verified_at IS NOT NULL
       OR NEW.object_etag IS NOT NULL
       OR NEW.object_version_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM public.consent_requests AS consent
         WHERE consent.practice_id = OLD.practice_id
           AND consent.file_id = OLD.id
           AND consent.storage_lease_token IS NOT NULL
           AND consent.storage_lease_expires_at > pg_catalog.clock_timestamp()
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Corrupt consent reservation requires fenced key rotation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.storage_status IN ('missing', 'unverified')
     AND NEW.storage_status = 'pending_upload'
  THEN
    IF linked_status IS DISTINCT FROM 'signing'
       OR NEW.file_key IS DISTINCT FROM OLD.file_key
       OR NEW.file_url IS DISTINCT FROM OLD.file_url
       OR NEW.storage_verified_at IS NOT NULL
       OR NEW.object_etag IS NOT NULL
       OR NEW.object_version_id IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM public.consent_requests AS consent
         WHERE consent.practice_id = OLD.practice_id
           AND consent.file_id = OLD.id
           AND consent.storage_lease_token IS NOT NULL
           AND consent.storage_lease_expires_at > pg_catalog.clock_timestamp()
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Legacy consent reservation recovery requires an unfenced signing row';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Invalid consent signature file transition';
END
$fn$;--> statement-breakpoint

CREATE TRIGGER consent_signature_files_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.files
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_signature_file();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.validate_signed_consent_file_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  consent_record record;
BEGIN
  IF TG_TABLE_NAME = 'consent_requests' THEN
    IF NEW.status <> 'signed' THEN RETURN NULL; END IF;
    consent_record := NEW;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.storage_status <> 'available' THEN
      -- A separately authorized recovery transition may accurately mark the
      -- immutable generation unavailable. The BEFORE guard has already
      -- proved that its key/checksum/size and request binding did not move.
      RETURN NULL;
    END IF;
    SELECT consent.*
    INTO consent_record
    FROM public.consent_requests AS consent
    WHERE consent.practice_id = COALESCE(NEW.practice_id, OLD.practice_id)
      AND consent.file_id = COALESCE(NEW.id, OLD.id)
      AND consent.status = 'signed'
    LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.files AS file
    WHERE file.id = consent_record.file_id
      AND file.practice_id = consent_record.practice_id
      AND file.idempotency_key = consent_record.id
      AND file.category = 'consents'
      AND file.source = 'consent_signature'
      AND file.mime_type = 'application/pdf'
      AND file.patient_id = consent_record.patient_id
      AND file.storage_status = 'available'
      AND file.deleted_at IS NULL
      AND file.file_key = consent_record.signed_file_key
      AND file.checksum_sha256 = consent_record.signed_file_checksum_sha256
      AND file.file_size_bytes = consent_record.signed_file_size_bytes
      AND (
        TG_TABLE_NAME <> 'consent_requests'
        OR (
          file.object_etag IS NOT DISTINCT FROM consent_record.signed_file_object_etag
          AND file.object_version_id IS NOT DISTINCT FROM consent_record.signed_file_object_version_id
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signed consent must reference its exact available PDF generation';
  END IF;
  RETURN NULL;
END
$fn$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER consent_requests_signed_file_binding_guard
AFTER INSERT OR UPDATE ON public.consent_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_signed_consent_file_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER consent_files_signed_binding_guard
AFTER INSERT OR UPDATE OR DELETE ON public.files
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_signed_consent_file_binding();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.resolve_consent_document_render_version(
  p_practice_id uuid,
  p_consent_request_id uuid,
  p_original_file_id uuid,
  p_original_attestation_version text,
  p_v1_checksum text,
  p_v1_size integer,
  p_v2_checksum text,
  p_v2_size integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  consent_record record;
  selected_version text;
  file_checksum text;
  file_size integer;
  v1_matches boolean;
  v2_matches boolean;
BEGIN
  IF public.app_current_practice_id() IS DISTINCT FROM p_practice_id THEN
    RETURN NULL;
  END IF;
  SELECT consent.*
  INTO consent_record
  FROM public.consent_requests AS consent
  WHERE consent.id = p_consent_request_id
    AND consent.practice_id = p_practice_id
    AND consent.status = 'signing'
    AND consent.document_render_version IS NULL
    AND consent.signer_attestation_version IS NOT DISTINCT FROM p_original_attestation_version
    AND consent.file_id IS NOT DISTINCT FROM p_original_file_id
    AND consent.signed_at > pg_catalog.clock_timestamp() - interval '15 minutes'
    AND consent.expires_at > pg_catalog.clock_timestamp()
    AND consent.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF p_original_file_id IS NULL THEN
    IF p_v1_checksum IS NOT NULL OR p_v1_size IS NOT NULL
       OR p_v2_checksum IS NOT NULL OR p_v2_size IS NOT NULL
    THEN RETURN NULL; END IF;
    selected_version := CASE
      WHEN p_original_attestation_version = 'owner-authority-v1' THEN 'consent-pdf-v2'
      WHEN p_original_attestation_version IS NULL THEN 'consent-pdf-v1'
      ELSE NULL
    END;
  ELSE
    SELECT file.checksum_sha256, file.file_size_bytes
    INTO file_checksum, file_size
    FROM public.files AS file
    WHERE file.id = p_original_file_id
      AND file.practice_id = p_practice_id
      AND file.idempotency_key = p_consent_request_id
      AND file.category = 'consents'
      AND file.source = 'consent_signature'
      AND file.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND OR file_checksum IS NULL OR file_size IS NULL THEN RETURN NULL; END IF;
    v1_matches := file_checksum = p_v1_checksum AND file_size = p_v1_size;
    v2_matches := file_checksum = p_v2_checksum AND file_size = p_v2_size;
    IF v1_matches = v2_matches THEN RETURN NULL; END IF;
    selected_version := CASE WHEN v1_matches THEN 'consent-pdf-v1' ELSE 'consent-pdf-v2' END;
  END IF;
  IF selected_version IS NULL THEN RETURN NULL; END IF;

  UPDATE public.consent_requests
  SET document_render_version = selected_version,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_consent_request_id
    AND practice_id = p_practice_id
    AND status = 'signing'
    AND document_render_version IS NULL
    AND signer_attestation_version IS NOT DISTINCT FROM p_original_attestation_version
    AND file_id IS NOT DISTINCT FROM p_original_file_id
    AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN selected_version;
END
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.release_consent_storage_lease(
  p_practice_id uuid,
  p_consent_request_id uuid,
  p_file_id uuid,
  p_expected_lease_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF public.app_current_practice_id() IS DISTINCT FROM p_practice_id
     OR p_expected_lease_token IS NULL
  THEN RETURN false; END IF;
  UPDATE public.consent_requests
  SET storage_lease_token = NULL,
      storage_lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_consent_request_id
    AND practice_id = p_practice_id
    AND status = 'signing'
    AND file_id = p_file_id
    AND storage_lease_token = p_expected_lease_token
    AND deleted_at IS NULL;
  RETURN FOUND;
END
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.finalize_consent_request(
  p_practice_id uuid,
  p_consent_request_id uuid,
  p_file_id uuid,
  p_expected_lease_token uuid,
  p_file_key text,
  p_checksum text,
  p_file_size integer,
  p_object_etag text,
  p_object_version_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF public.app_current_practice_id() IS DISTINCT FROM p_practice_id
     OR p_expected_lease_token IS NULL
     OR p_file_key IS NULL
     OR p_checksum !~ '^[0-9a-f]{64}$'
     OR p_file_size <= 0
  THEN RETURN false; END IF;

  UPDATE public.consent_requests AS consent
  SET status = 'signed',
      storage_lease_token = NULL,
      storage_lease_expires_at = NULL,
      signed_file_key = p_file_key,
      signed_file_checksum_sha256 = p_checksum,
      signed_file_size_bytes = p_file_size,
      signed_file_object_etag = p_object_etag,
      signed_file_object_version_id = p_object_version_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE consent.id = p_consent_request_id
    AND consent.practice_id = p_practice_id
    AND consent.status = 'signing'
    AND consent.file_id = p_file_id
    AND consent.storage_lease_token = p_expected_lease_token
    AND consent.signed_at > pg_catalog.clock_timestamp() - interval '15 minutes'
    AND consent.deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.files AS file
      WHERE file.id = p_file_id
        AND file.practice_id = p_practice_id
        AND file.idempotency_key = p_consent_request_id
        AND file.category = 'consents'
        AND file.source = 'consent_signature'
        AND file.mime_type = 'application/pdf'
        AND file.patient_id = consent.patient_id
        AND file.file_key = p_file_key
        AND file.checksum_sha256 = p_checksum
        AND file.file_size_bytes = p_file_size
        AND file.storage_status IN ('pending_upload', 'available')
        AND file.deleted_at IS NULL
    );
  RETURN FOUND;
END
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.transition_signed_consent_file_storage(
  p_practice_id uuid,
  p_file_id uuid,
  p_expected_file_key text,
  p_expected_checksum text,
  p_expected_size integer,
  p_expected_status public.file_storage_status,
  p_next_status public.file_storage_status,
  p_storage_verified_at timestamptz,
  p_object_etag text,
  p_object_version_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT public.app_rls_bypass() THEN RETURN false; END IF;
  IF NOT (
    (p_expected_status = 'available' AND p_next_status IN ('missing', 'corrupt', 'unverified'))
    OR (p_expected_status IN ('missing', 'corrupt', 'unverified') AND p_next_status = 'available')
  ) THEN RETURN false; END IF;
  IF (p_next_status = 'available' AND p_storage_verified_at IS NULL)
     OR (p_next_status <> 'available' AND p_storage_verified_at IS NOT NULL)
  THEN RETURN false; END IF;

  UPDATE public.files AS file
  SET storage_status = p_next_status,
      storage_verified_at = p_storage_verified_at,
      object_etag = CASE WHEN p_next_status = 'available' THEN p_object_etag ELSE file.object_etag END,
      object_version_id = CASE WHEN p_next_status = 'available' THEN p_object_version_id ELSE file.object_version_id END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE file.id = p_file_id
    AND file.practice_id = p_practice_id
    AND file.file_key = p_expected_file_key
    AND file.checksum_sha256 = p_expected_checksum
    AND file.file_size_bytes = p_expected_size
    AND file.storage_status = p_expected_status
    AND file.category = 'consents'
    AND file.source = 'consent_signature'
    AND file.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.consent_requests AS consent
      WHERE consent.practice_id = p_practice_id
        AND consent.file_id = p_file_id
        AND consent.status = 'signed'
        AND consent.signed_file_key = p_expected_file_key
        AND consent.signed_file_checksum_sha256 = p_expected_checksum
        AND consent.signed_file_size_bytes = p_expected_size
    );
  RETURN FOUND;
END
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_consent_receipt_capability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.transaction_timestamp();
    NEW.updated_at := pg_catalog.transaction_timestamp();
    IF NEW.expires_at <= pg_catalog.transaction_timestamp()
       OR NEW.expires_at > pg_catalog.transaction_timestamp() + interval '15 minutes'
       OR NEW.deleted_at IS NOT NULL
       OR NEW.claim_count <> 0
       OR NEW.last_claimed_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.consent_requests AS consent
         JOIN public.files AS file
           ON file.id = consent.file_id
          AND file.practice_id = consent.practice_id
         WHERE consent.id = NEW.consent_request_id
           AND consent.practice_id = NEW.practice_id
           AND consent.status = 'signed'
           AND consent.file_id = NEW.file_id
           AND consent.deleted_at IS NULL
           AND file.id = NEW.file_id
           AND file.checksum_sha256 = NEW.file_checksum_sha256
           AND file.file_size_bytes = NEW.file_size_bytes
           AND file.storage_status = 'available'
           AND file.mime_type = 'application/pdf'
           AND file.category = 'consents'
           AND file.source = 'consent_signature'
           AND file.deleted_at IS NULL
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent receipt capability requires an exact signed file';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.practice_id IS DISTINCT FROM OLD.practice_id
     OR NEW.consent_request_id IS DISTINCT FROM OLD.consent_request_id
     OR NEW.file_id IS DISTINCT FROM OLD.file_id
     OR NEW.file_checksum_sha256 IS DISTINCT FROM OLD.file_checksum_sha256
     OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.max_claims IS DISTINCT FROM OLD.max_claims
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent receipt capability identity is immutable';
  END IF;
  IF NEW.claim_count <> OLD.claim_count + 1
     OR NEW.claim_count > NEW.max_claims
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent receipt claims must advance atomically';
  END IF;
  NEW.last_claimed_at := pg_catalog.clock_timestamp();
  NEW.updated_at := NEW.last_claimed_at;
  RETURN NEW;
END
$fn$;--> statement-breakpoint

CREATE TRIGGER consent_receipt_capabilities_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.consent_receipt_capabilities
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_receipt_capability();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.delete_expired_consent_receipt_capabilities(
  p_before timestamptz,
  p_limit integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  deleted_count integer;
BEGIN
  IF NOT public.app_rls_bypass()
     OR p_before IS NULL
     OR p_before > pg_catalog.clock_timestamp()
     OR p_limit NOT BETWEEN 1 AND 1000
  THEN RETURN 0; END IF;
  WITH doomed AS (
    SELECT capability.id
    FROM public.consent_receipt_capabilities AS capability
    WHERE capability.expires_at <= p_before
    ORDER BY capability.expires_at, capability.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.consent_receipt_capabilities AS capability
  USING doomed
  WHERE capability.id = doomed.id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$fn$;--> statement-breakpoint

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
        FROM pg_catalog.jsonb_array_elements(p_decisions) AS decision(value)
        JOIN public.visit_treatment_plan_revision_lines AS offered
          ON offered.practice_id = p_practice_id
         AND offered.revision_id = p_revision_id
         AND offered.id = (decision.value->>'revisionLineId')::uuid
      ), '[]'::jsonb)
    )::text, 'UTF8')), 'hex')
  FROM public.visit_treatment_plan_revisions AS revision
  WHERE revision.practice_id = p_practice_id
    AND revision.plan_id = p_plan_id AND revision.id = p_revision_id
$fn$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_visit_treatment_plan_presentation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
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
  IF EXISTS (
    SELECT 1 FROM public.visit_treatment_plan_presentations AS presentation
    LEFT JOIN public.consent_requests AS consent
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
  IF OLD.status = 'open' AND NEW.status <> 'open' AND EXISTS (
    SELECT 1 FROM public.visit_treatment_plan_presentations AS presentation
    LEFT JOIN public.consent_requests AS consent
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
FOR EACH ROW EXECUTE FUNCTION public.reject_treatment_plan_close_while_signing();--> statement-breakpoint

REVOKE ALL ON FUNCTION public.protect_consent_request_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_consent_signature_file() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_signed_consent_file_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_consent_receipt_capability() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_visit_treatment_plan_presentation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_revision_while_treatment_plan_signing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_treatment_plan_close_while_signing() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_consent_storage_lease(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_consent_request(uuid,uuid,uuid,uuid,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_signed_consent_file_storage(uuid,uuid,text,text,integer,public.file_storage_status,public.file_storage_status,timestamptz,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.delete_expired_consent_receipt_capabilities(timestamptz,integer) FROM PUBLIC;--> statement-breakpoint

-- Keep the pre-integration SOAP recovery hardening after the migration tail
-- was regenerated against main's canonical 0100/0101 snapshots.
REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON FUNCTION public.protect_consent_request_evidence() FROM openpims_app;
    REVOKE ALL ON FUNCTION public.protect_consent_signature_file() FROM openpims_app;
    REVOKE ALL ON FUNCTION public.validate_signed_consent_file_binding() FROM openpims_app;
    REVOKE ALL ON FUNCTION public.protect_consent_receipt_capability() FROM openpims_app;
    GRANT EXECUTE ON FUNCTION public.resolve_consent_document_render_version(uuid,uuid,uuid,text,text,integer,text,integer) TO openpims_app;
    GRANT EXECUTE ON FUNCTION public.release_consent_storage_lease(uuid,uuid,uuid,uuid) TO openpims_app;
    GRANT EXECUTE ON FUNCTION public.finalize_consent_request(uuid,uuid,uuid,uuid,text,text,integer,text,text) TO openpims_app;
    GRANT EXECUTE ON FUNCTION public.transition_signed_consent_file_storage(uuid,uuid,text,text,integer,public.file_storage_status,public.file_storage_status,timestamptz,text,text) TO openpims_app;
    GRANT EXECUTE ON FUNCTION public.delete_expired_consent_receipt_capabilities(timestamptz,integer) TO openpims_app;
    GRANT EXECUTE ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) TO openpims_app;
    REVOKE DELETE ON TABLE public.consent_requests FROM openpims_app;
  END IF;
END
$$;
