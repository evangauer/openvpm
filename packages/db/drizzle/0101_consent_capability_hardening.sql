SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint

-- Expand without invalidating existing consent links: legacy rows keep their
-- plaintext token, while new treatment-plan-derived links use token_hash only.
ALTER TABLE "consent_requests" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "consent_requests" ADD COLUMN "signer_attestation_version" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "consent_requests_token_hash_uq" ON "consent_requests" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_credential_storage_check" CHECK (("consent_requests"."token" is not null and "consent_requests"."token_hash" is null) or ("consent_requests"."token" is null and "consent_requests"."token_hash" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" ADD CONSTRAINT "consent_requests_token_hash_format_check" CHECK ("consent_requests"."token_hash" is null or "consent_requests"."token_hash" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_credential_storage_check";--> statement-breakpoint
ALTER TABLE "consent_requests" VALIDATE CONSTRAINT "consent_requests_token_hash_format_check";
