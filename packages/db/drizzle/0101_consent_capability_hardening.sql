SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- Expand without invalidating existing consent links: legacy rows keep their
-- plaintext token, while new treatment-plan-derived links use token_hash only.
ALTER TABLE "consent_requests" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signer_attestation_version" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "document_render_version" varchar(32);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "storage_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "storage_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_token_hash_uq" ON "consent_requests" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_credential_storage_check" CHECK (("consent_requests"."token" is not null and "consent_requests"."token_hash" is null) or ("consent_requests"."token" is null and "consent_requests"."token_hash" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_token_hash_format_check" CHECK ("consent_requests"."token_hash" is null or "consent_requests"."token_hash" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_document_render_version_check" CHECK ("consent_requests"."document_render_version" is null or "consent_requests"."document_render_version" in ('consent-pdf-v1', 'consent-pdf-v2')) NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_storage_lease_pair_check" CHECK (("consent_requests"."storage_lease_token" is null and "consent_requests"."storage_lease_expires_at" is null) or ("consent_requests"."storage_lease_token" is not null and "consent_requests"."storage_lease_expires_at" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_storage_lease_state_check" CHECK ("consent_requests"."storage_lease_token" is null or "consent_requests"."status" = 'signing') NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_credential_storage_check";--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_token_hash_format_check";--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_document_render_version_check";--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_storage_lease_pair_check";--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_storage_lease_state_check";--> statement-breakpoint

-- Rows already in flight without a reservation used one of two immutable
-- renderers. The authority attestation is sufficient only before file bytes
-- were reserved. Reserved rows are resolved in the application by comparing
-- both renderer outputs to the durable file checksum and size.
UPDATE public.consent_requests
SET document_render_version = CASE
  WHEN signer_attestation_version = 'owner-authority-v1' THEN 'consent-pdf-v2'
  ELSE 'consent-pdf-v1'
END
WHERE status = 'signing'
  AND document_render_version IS NULL
  AND file_id IS NULL;--> statement-breakpoint

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
CREATE TRIGGER consent_requests_document_render_guard
BEFORE UPDATE ON public.consent_requests
FOR EACH ROW EXECUTE FUNCTION public.protect_consent_document_render_version();
