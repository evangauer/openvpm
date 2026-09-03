-- Test-only reconstruction of the exact non-main 0099-0101 object shape that
-- already exists in demo. The three synthetic rows exercise all enum states.
CREATE TYPE public.backup_run_status AS ENUM('ok', 'degraded', 'failed');

CREATE TABLE public.backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone NOT NULL,
  run_date_utc date NOT NULL,
  status backup_run_status NOT NULL,
  practices integer NOT NULL,
  primary_verified integer NOT NULL,
  primary_failed integer NOT NULL,
  oversized integer NOT NULL,
  near_limit integer NOT NULL,
  max_export_bytes integer NOT NULL,
  replica_enabled boolean NOT NULL,
  replica_required boolean NOT NULL,
  replica_verified integer NOT NULL,
  replica_failed integer NOT NULL,
  CONSTRAINT backup_runs_completed_after_started_check
    CHECK (completed_at >= started_at),
  CONSTRAINT backup_runs_nonnegative_counts_check
    CHECK (practices >= 0
      AND primary_verified >= 0
      AND primary_failed >= 0
      AND oversized >= 0
      AND near_limit >= 0
      AND max_export_bytes >= 0
      AND replica_verified >= 0
      AND replica_failed >= 0),
  CONSTRAINT backup_runs_primary_totals_check
    CHECK (primary_verified + primary_failed = practices),
  CONSTRAINT backup_runs_primary_failure_shape_check
    CHECK ((status = 'ok' AND primary_failed = 0 AND replica_failed = 0)
      OR (status = 'degraded' AND (primary_failed > 0 OR replica_failed > 0))
      OR (status = 'failed' AND practices = 0 AND primary_verified = 0)),
  CONSTRAINT backup_runs_replica_execution_check
    CHECK (replica_enabled OR (replica_verified = 0 AND replica_failed = 0))
);

CREATE INDEX backup_runs_completed_idx
  ON public.backup_runs USING btree (completed_at, id);

CREATE OR REPLACE FUNCTION public.app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_only ON public.backup_runs
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

DO $$
DECLARE role_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    REVOKE ALL ON public.backup_runs FROM openpims_app;
    GRANT SELECT, INSERT ON public.backup_runs TO openpims_app;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON public.backup_runs FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.users ADD COLUMN mfa_secret_encrypted text;
ALTER TABLE public.users ADD COLUMN mfa_enabled_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN mfa_last_used_totp_counter integer;
ALTER TABLE public.users ADD COLUMN mfa_recovery_code_hashes jsonb;
ALTER TABLE public.users ADD COLUMN mfa_pending_secret_encrypted text;
ALTER TABLE public.users ADD COLUMN mfa_pending_expires_at timestamp with time zone;

ALTER TABLE public.users ADD CONSTRAINT users_mfa_active_shape_check
  CHECK ((mfa_enabled_at IS NULL
      AND mfa_secret_encrypted IS NULL
      AND mfa_last_used_totp_counter IS NULL
      AND mfa_recovery_code_hashes IS NULL)
    OR (mfa_enabled_at IS NOT NULL
      AND length(mfa_secret_encrypted) BETWEEN 40 AND 1024
      AND jsonb_typeof(mfa_recovery_code_hashes) = 'array'
      AND jsonb_array_length(mfa_recovery_code_hashes) <= 20));
ALTER TABLE public.users ADD CONSTRAINT users_mfa_pending_shape_check
  CHECK ((mfa_pending_secret_encrypted IS NULL AND mfa_pending_expires_at IS NULL)
    OR (mfa_enabled_at IS NULL
      AND length(mfa_pending_secret_encrypted) BETWEEN 40 AND 1024
      AND mfa_pending_expires_at IS NOT NULL));
ALTER TABLE public.users ADD CONSTRAINT users_mfa_totp_counter_check
  CHECK (mfa_last_used_totp_counter IS NULL OR mfa_last_used_totp_counter >= 0);

INSERT INTO public.backup_runs (
  id, started_at, completed_at, run_date_utc, status, practices,
  primary_verified, primary_failed, oversized, near_limit, max_export_bytes,
  replica_enabled, replica_required, replica_verified, replica_failed
) VALUES
  ('10000000-0000-4000-8000-000000000001', '2026-08-31 01:00:00+00', '2026-08-31 01:02:00+00', '2026-08-31', 'ok', 3, 3, 0, 0, 1, 1048576, true, false, 3, 0),
  ('10000000-0000-4000-8000-000000000002', '2026-09-01 01:00:00+00', '2026-09-01 01:03:00+00', '2026-09-01', 'degraded', 3, 2, 1, 1, 0, 2097152, true, true, 2, 1),
  ('10000000-0000-4000-8000-000000000003', '2026-09-02 01:00:00+00', '2026-09-02 01:01:00+00', '2026-09-02', 'failed', 0, 0, 0, 0, 0, 0, false, false, 0, 0);

-- Synthetic placeholder values prove byte/value preservation; they are not
-- real authenticators, recovery codes, keys, or production identifiers.
UPDATE public.users
   SET mfa_secret_encrypted = repeat('a', 48),
       mfa_enabled_at = '2026-08-31 12:00:00+00',
       mfa_last_used_totp_counter = 4242,
       mfa_recovery_code_hashes = '["test-hash-1", "test-hash-2"]'::jsonb
 WHERE email = 'reconciliation-active@example.test';

UPDATE public.users
   SET mfa_pending_secret_encrypted = repeat('b', 48),
       mfa_pending_expires_at = '2026-09-04 12:00:00+00'
 WHERE email = 'reconciliation-pending@example.test';
