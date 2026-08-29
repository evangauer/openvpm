CREATE TYPE "public"."backup_run_status" AS ENUM('ok', 'degraded', 'failed');--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"run_date_utc" date NOT NULL,
	"status" "backup_run_status" NOT NULL,
	"practices" integer NOT NULL,
	"primary_verified" integer NOT NULL,
	"primary_failed" integer NOT NULL,
	"oversized" integer NOT NULL,
	"near_limit" integer NOT NULL,
	"max_export_bytes" integer NOT NULL,
	"replica_enabled" boolean NOT NULL,
	"replica_required" boolean NOT NULL,
	"replica_verified" integer NOT NULL,
	"replica_failed" integer NOT NULL,
	CONSTRAINT "backup_runs_completed_after_started_check" CHECK ("backup_runs"."completed_at" >= "backup_runs"."started_at"),
	CONSTRAINT "backup_runs_nonnegative_counts_check" CHECK ("backup_runs"."practices" >= 0
        and "backup_runs"."primary_verified" >= 0
        and "backup_runs"."primary_failed" >= 0
        and "backup_runs"."oversized" >= 0
        and "backup_runs"."near_limit" >= 0
        and "backup_runs"."max_export_bytes" >= 0
        and "backup_runs"."replica_verified" >= 0
        and "backup_runs"."replica_failed" >= 0),
	CONSTRAINT "backup_runs_primary_totals_check" CHECK ("backup_runs"."primary_verified" + "backup_runs"."primary_failed" = "backup_runs"."practices"),
	CONSTRAINT "backup_runs_primary_failure_shape_check" CHECK (("backup_runs"."status" = 'ok' and "backup_runs"."primary_failed" = 0 and "backup_runs"."replica_failed" = 0)
        or ("backup_runs"."status" = 'degraded' and ("backup_runs"."primary_failed" > 0 or "backup_runs"."replica_failed" > 0))
        or ("backup_runs"."status" = 'failed' and "backup_runs"."practices" = 0 and "backup_runs"."primary_verified" = 0)),
	CONSTRAINT "backup_runs_replica_execution_check" CHECK ("backup_runs"."replica_enabled" or ("backup_runs"."replica_verified" = 0 and "backup_runs"."replica_failed" = 0))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_completed_idx" ON "backup_runs" USING btree ("completed_at","id");--> statement-breakpoint

-- Backup run evidence is cross-tenant operational metadata. Install its
-- system-only boundary atomically with the table so there is no fail-open
-- interval before a later blanket RLS pass.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;--> statement-breakpoint
ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_only ON backup_runs
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON backup_runs FROM openpims_app;
    GRANT SELECT, INSERT ON backup_runs TO openpims_app;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON backup_runs FROM %I', r);
    END IF;
  END LOOP;
END $$;
