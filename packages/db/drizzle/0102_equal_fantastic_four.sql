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
ALTER TABLE "consent_requests" ADD COLUMN "signature_method" varchar(16);--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_consent_request_id_consent_requests_id_fk" FOREIGN KEY ("consent_request_id") REFERENCES "public"."consent_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_consent_tenant_fk" FOREIGN KEY ("practice_id","consent_request_id") REFERENCES "public"."consent_requests"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_receipt_capabilities" ADD CONSTRAINT "consent_receipt_capabilities_file_tenant_fk" FOREIGN KEY ("practice_id","file_id") REFERENCES "public"."files"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_receipt_capabilities_token_hash_uq" ON "consent_receipt_capabilities" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_receipt_capabilities_consent_uq" ON "consent_receipt_capabilities" USING btree ("practice_id","consent_request_id");--> statement-breakpoint
CREATE INDEX "consent_receipt_capabilities_practice_expiry_idx" ON "consent_receipt_capabilities" USING btree ("practice_id","expires_at") WHERE "consent_receipt_capabilities"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_signature_method_check" CHECK ("consent_requests"."signature_method" is null or "consent_requests"."signature_method" in ('drawn', 'typed'));--> statement-breakpoint

-- Some branch/database environments may already have applied the original
-- 0101 renderer guard. Replace it here too so one-time, evidence-derived
-- persistence remains available without relaxing renderer immutability.
CREATE OR REPLACE FUNCTION public.protect_consent_document_render_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF OLD.status <> 'pending'
     AND NEW.document_render_version IS DISTINCT FROM OLD.document_render_version
     AND NOT (
       OLD.status = 'signing'
       AND OLD.document_render_version IS NULL
       AND (
         (OLD.file_id IS NULL AND NEW.document_render_version = CASE
           WHEN OLD.signer_attestation_version = 'owner-authority-v1'
             THEN 'consent-pdf-v2'
           ELSE 'consent-pdf-v1'
         END)
         OR OLD.file_id IS NOT NULL
       )
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent document renderer is immutable after signing begins';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'signing'
     AND NEW.document_render_version IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'New signing claims require an explicit document renderer';
  END IF;
  IF NEW.status = 'pending' AND NEW.document_render_version IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Pending consent cannot preselect a document renderer';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint

-- All existing signature images predate the keyboard path and are drawn.
UPDATE public.consent_requests
SET signature_method = 'drawn'
WHERE status = 'signing' AND signature_method IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_consent_signature_method()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF OLD.status <> 'pending'
     AND NEW.signature_method IS DISTINCT FROM OLD.signature_method
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent signature method is immutable after signing begins';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'signing'
     AND NEW.signature_method IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'New signing claims require an explicit signature method';
  END IF;
  IF NEW.status = 'pending' AND NEW.signature_method IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Pending consent cannot preselect a signature method';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER consent_requests_signature_method_guard
BEFORE UPDATE ON public.consent_requests
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_signature_method();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.protect_consent_receipt_capability()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL
       OR NEW.claim_count <> 0
       OR NEW.last_claimed_at IS NOT NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.consent_requests cr
         JOIN public.files f
           ON f.id = cr.file_id
          AND f.practice_id = cr.practice_id
         WHERE cr.id = NEW.consent_request_id
           AND cr.practice_id = NEW.practice_id
           AND cr.status = 'signed'
           AND cr.file_id = NEW.file_id
           AND cr.deleted_at IS NULL
           AND f.id = NEW.file_id
           AND f.checksum_sha256 = NEW.file_checksum_sha256
           AND f.file_size_bytes = NEW.file_size_bytes
           AND f.storage_status = 'available'
           AND f.mime_type = 'application/pdf'
           AND f.category = 'consents'
           AND f.deleted_at IS NULL
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Consent receipt capability requires an exact signed file';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.rls_bypass', true), '') <> 'on' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Consent receipt capabilities require system cleanup';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.practice_id IS DISTINCT FROM OLD.practice_id
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
     OR NEW.last_claimed_at IS NULL
     OR NEW.updated_at < OLD.updated_at
     OR (OLD.last_claimed_at IS NOT NULL AND NEW.last_claimed_at < OLD.last_claimed_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Consent receipt claims must advance atomically';
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint
CREATE TRIGGER consent_receipt_capabilities_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.consent_receipt_capabilities
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_receipt_capability();
