CREATE TYPE "public"."lifecycle_email_attempt_outcome" AS ENUM('accepted', 'definite_failure', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_email_job_kind" AS ENUM('subscription_confirmed', 'subscription_canceled');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_email_job_state" AS ENUM('pending', 'retry', 'delivering', 'blocked_recovery', 'delivered', 'suppressed_stale', 'failed', 'outcome_unknown');--> statement-breakpoint
CREATE TABLE "lifecycle_email_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"resolved_at" timestamp with time zone,
	"practice_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"provider" varchar(16) NOT NULL,
	"request_fingerprint_sha256" varchar(64) NOT NULL,
	"outcome" "lifecycle_email_attempt_outcome",
	"provider_message_id" varchar(128),
	"failure_code" varchar(64),
	"failure_detail" text,
	CONSTRAINT "lifecycle_email_attempts_identity_check" CHECK ("lifecycle_email_attempts"."attempt_number" >= 1
        and "lifecycle_email_attempts"."provider" in ('resend', 'console')
        and "lifecycle_email_attempts"."request_fingerprint_sha256" ~ '^[0-9a-f]{64}$'
        and ("lifecycle_email_attempts"."failure_code" is null or (
          length(btrim("lifecycle_email_attempts"."failure_code")) between 1 and 64
          and "lifecycle_email_attempts"."failure_code" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("lifecycle_email_attempts"."failure_detail" is null or length("lifecycle_email_attempts"."failure_detail") <= 2000)),
	CONSTRAINT "lifecycle_email_attempts_outcome_check" CHECK ((
          "lifecycle_email_attempts"."resolved_at" is null
          and "lifecycle_email_attempts"."outcome" is null
          and "lifecycle_email_attempts"."provider_message_id" is null
          and "lifecycle_email_attempts"."failure_code" is null
          and "lifecycle_email_attempts"."failure_detail" is null
        ) or (
          "lifecycle_email_attempts"."resolved_at" is not null
          and "lifecycle_email_attempts"."outcome" = 'accepted'
          and "lifecycle_email_attempts"."provider_message_id" is not null
          and "lifecycle_email_attempts"."failure_code" is null
          and "lifecycle_email_attempts"."failure_detail" is null
        ) or (
          "lifecycle_email_attempts"."resolved_at" is not null
          and "lifecycle_email_attempts"."outcome" in ('definite_failure', 'outcome_unknown')
          and "lifecycle_email_attempts"."provider_message_id" is null
          and "lifecycle_email_attempts"."failure_code" is not null
        ))
);
--> statement-breakpoint
CREATE TABLE "lifecycle_email_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"practice_id" uuid NOT NULL,
	"communication_id" uuid NOT NULL,
	"kind" "lifecycle_email_job_kind" NOT NULL,
	"state" "lifecycle_email_job_state" DEFAULT 'pending' NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"provider_idempotency_key" varchar(200) NOT NULL,
	"recipient_hash_sha256" varchar(64) NOT NULL,
	"practice_name" varchar(255) NOT NULL,
	"subscription_id" varchar(64) NOT NULL,
	"subscription_generation" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp(),
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"request_fingerprint_sha256" varchar(64),
	"provider_message_id" varchar(128),
	"completed_at" timestamp with time zone,
	"last_outcome" "lifecycle_email_attempt_outcome",
	"last_error_code" varchar(64),
	"last_error_detail" text,
	CONSTRAINT "lifecycle_email_jobs_identity_check" CHECK (length(btrim("lifecycle_email_jobs"."dedupe_key")) between 1 and 160
        and length(btrim("lifecycle_email_jobs"."provider_idempotency_key")) between 1 and 200
        and "lifecycle_email_jobs"."recipient_hash_sha256" ~ '^[0-9a-f]{64}$'
        and length(btrim("lifecycle_email_jobs"."practice_name")) between 1 and 255
        and length(btrim("lifecycle_email_jobs"."subscription_id")) between 1 and 64
        and "lifecycle_email_jobs"."subscription_generation" >= 0
        and ("lifecycle_email_jobs"."request_fingerprint_sha256" is null or "lifecycle_email_jobs"."request_fingerprint_sha256" ~ '^[0-9a-f]{64}$')
        and ("lifecycle_email_jobs"."last_error_code" is null or (
          length(btrim("lifecycle_email_jobs"."last_error_code")) between 1 and 64
          and "lifecycle_email_jobs"."last_error_code" ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and ("lifecycle_email_jobs"."last_error_detail" is null or length("lifecycle_email_jobs"."last_error_detail") <= 2000)),
	CONSTRAINT "lifecycle_email_jobs_state_check" CHECK ("lifecycle_email_jobs"."attempt_count" >= 0 and (
        (
          "lifecycle_email_jobs"."state" in ('pending', 'blocked_recovery')
          and "lifecycle_email_jobs"."next_attempt_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."completed_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
        ) or (
          "lifecycle_email_jobs"."state" = 'retry'
          and "lifecycle_email_jobs"."attempt_count" >= 1
          and "lifecycle_email_jobs"."next_attempt_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."completed_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
          and "lifecycle_email_jobs"."last_outcome" in ('definite_failure', 'outcome_unknown')
        ) or (
          "lifecycle_email_jobs"."state" = 'delivering'
          and "lifecycle_email_jobs"."next_attempt_at" is null
          and "lifecycle_email_jobs"."lease_token" is not null
          and "lifecycle_email_jobs"."lease_expires_at" is not null
          and "lifecycle_email_jobs"."completed_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
        ) or (
          "lifecycle_email_jobs"."state" = 'delivered'
          and "lifecycle_email_jobs"."next_attempt_at" is null
          and "lifecycle_email_jobs"."completed_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is not null
          and "lifecycle_email_jobs"."last_outcome" = 'accepted'
        ) or (
          "lifecycle_email_jobs"."state" = 'suppressed_stale'
          and "lifecycle_email_jobs"."next_attempt_at" is null
          and "lifecycle_email_jobs"."completed_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
        ) or (
          "lifecycle_email_jobs"."state" = 'failed'
          and "lifecycle_email_jobs"."next_attempt_at" is null
          and "lifecycle_email_jobs"."completed_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
          and "lifecycle_email_jobs"."last_outcome" = 'definite_failure'
        ) or (
          "lifecycle_email_jobs"."state" = 'outcome_unknown'
          and "lifecycle_email_jobs"."next_attempt_at" is null
          and "lifecycle_email_jobs"."completed_at" is not null
          and "lifecycle_email_jobs"."lease_token" is null
          and "lifecycle_email_jobs"."lease_expires_at" is null
          and "lifecycle_email_jobs"."provider_message_id" is null
          and "lifecycle_email_jobs"."last_outcome" = 'outcome_unknown'
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "practices" ADD COLUMN "subscription_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_email_attempts" ADD CONSTRAINT "lifecycle_email_attempts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_email_attempts" ADD CONSTRAINT "lifecycle_email_attempts_job_tenant_fk" FOREIGN KEY ("practice_id","job_id") REFERENCES "public"."lifecycle_email_jobs"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_email_jobs" ADD CONSTRAINT "lifecycle_email_jobs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_email_jobs" ADD CONSTRAINT "lifecycle_email_jobs_communication_tenant_fk" FOREIGN KEY ("practice_id","communication_id") REFERENCES "public"."communications"("practice_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_attempts_job_attempt_uq" ON "lifecycle_email_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "lifecycle_email_attempts_job_history_idx" ON "lifecycle_email_attempts" USING btree ("practice_id","job_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_attempts_provider_message_uq" ON "lifecycle_email_attempts" USING btree ("provider","provider_message_id") WHERE "lifecycle_email_attempts"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_jobs_practice_id_uq" ON "lifecycle_email_jobs" USING btree ("practice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_jobs_communication_uq" ON "lifecycle_email_jobs" USING btree ("practice_id","communication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_email_jobs_dedupe_key_uq" ON "lifecycle_email_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "lifecycle_email_jobs_due_idx" ON "lifecycle_email_jobs" USING btree ("next_attempt_at","created_at","id") WHERE "lifecycle_email_jobs"."state" in ('pending', 'retry', 'blocked_recovery');--> statement-breakpoint
CREATE INDEX "lifecycle_email_jobs_lease_idx" ON "lifecycle_email_jobs" USING btree ("lease_expires_at","created_at","id") WHERE "lifecycle_email_jobs"."state" = 'delivering';--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_subscription_generation_check" CHECK ("practices"."subscription_generation" >= 0);--> statement-breakpoint

-- Provider dispatch evidence is operational system state, never tenant-visible.
ALTER TABLE public.lifecycle_email_jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON public.lifecycle_email_jobs
  USING (public.app_rls_bypass())
  WITH CHECK (public.app_rls_bypass());--> statement-breakpoint
ALTER TABLE public.lifecycle_email_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON public.lifecycle_email_attempts
  USING (public.app_rls_bypass())
  WITH CHECK (public.app_rls_bypass());--> statement-breakpoint
REVOKE ALL ON public.lifecycle_email_jobs, public.lifecycle_email_attempts FROM PUBLIC;--> statement-breakpoint
DO $body$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'openpims_app']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON public.lifecycle_email_jobs, public.lifecycle_email_attempts FROM %I',
        role_name
      );
      IF role_name = 'openpims_app' THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.lifecycle_email_jobs, public.lifecycle_email_attempts TO openpims_app';
      END IF;
    END IF;
  END LOOP;
END
$body$;
