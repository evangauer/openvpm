-- Canonical forward reconciliation for the exact backup/MFA schema that was
-- applied to demo outside main's Drizzle history. This migration is designed
-- to be safe for both a fresh 0099 database and that already-populated shape.
-- It intentionally activates neither MFA authentication nor a backup job.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public;

DO $migration$
DECLARE
  enum_labels text[];
BEGIN
  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO enum_labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE n.nspname = 'public'
     AND t.typname = 'backup_run_status'
   GROUP BY t.oid, t.typtype;

  IF to_regtype('public.backup_run_status') IS NULL THEN
    CREATE TYPE public.backup_run_status AS ENUM ('ok', 'degraded', 'failed');
  ELSIF enum_labels IS DISTINCT FROM ARRAY['ok', 'degraded', 'failed']::text[]
     OR NOT EXISTS (
       SELECT 1
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = 'backup_run_status'
          AND t.typtype = 'e'
     ) THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_run_status has an incompatible shape (expected enum ok,degraded,failed; found %)',
      coalesce(enum_labels::text, '<non-enum>');
  END IF;
END
$migration$;--> statement-breakpoint

DO $migration$
DECLARE
  incompatible_columns text;
  unexpected_constraint text;
  unexpected_index text;
  unexpected_trigger text;
  constraint_row record;
  existing_definition text;
BEGIN
  IF to_regclass('public.backup_runs') IS NULL THEN
    CREATE TABLE public.backup_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      started_at timestamp with time zone NOT NULL,
      completed_at timestamp with time zone NOT NULL,
      run_date_utc date NOT NULL,
      status public.backup_run_status NOT NULL,
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
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'backup_runs'
         AND c.relkind = 'r'
         AND c.relpersistence = 'p'
    ) THEN
      RAISE EXCEPTION
        '0100 reconciliation refused: public.backup_runs is not an ordinary permanent table';
    END IF;

    WITH expected(attnum, attname, atttypid, attnotnull, default_expr) AS (
      VALUES
        (1, 'id', 'uuid'::regtype, true, 'gen_random_uuid()'),
        (2, 'started_at', 'timestamp with time zone'::regtype, true, NULL),
        (3, 'completed_at', 'timestamp with time zone'::regtype, true, NULL),
        (4, 'run_date_utc', 'date'::regtype, true, NULL),
        (5, 'status', 'public.backup_run_status'::regtype, true, NULL),
        (6, 'practices', 'integer'::regtype, true, NULL),
        (7, 'primary_verified', 'integer'::regtype, true, NULL),
        (8, 'primary_failed', 'integer'::regtype, true, NULL),
        (9, 'oversized', 'integer'::regtype, true, NULL),
        (10, 'near_limit', 'integer'::regtype, true, NULL),
        (11, 'max_export_bytes', 'integer'::regtype, true, NULL),
        (12, 'replica_enabled', 'boolean'::regtype, true, NULL),
        (13, 'replica_required', 'boolean'::regtype, true, NULL),
        (14, 'replica_verified', 'integer'::regtype, true, NULL),
        (15, 'replica_failed', 'integer'::regtype, true, NULL)
    ), actual AS (
      SELECT a.attnum,
             a.attname,
             a.atttypid,
             a.attnotnull,
             pg_get_expr(d.adbin, d.adrelid, true) AS default_expr,
             a.attidentity,
             a.attgenerated
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d
          ON d.adrelid = a.attrelid
         AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.backup_runs'::regclass
         AND a.attnum > 0
         AND NOT a.attisdropped
    ), differences AS (
      SELECT coalesce(e.attname, a.attname) AS column_name
        FROM expected e
        FULL JOIN actual a USING (attnum)
       WHERE e.attname IS DISTINCT FROM a.attname
          OR e.atttypid IS DISTINCT FROM a.atttypid
          OR e.attnotnull IS DISTINCT FROM a.attnotnull
          OR e.default_expr IS DISTINCT FROM a.default_expr
          OR coalesce(a.attidentity, '') <> ''
          OR coalesce(a.attgenerated, '') <> ''
    )
    SELECT string_agg(column_name, ', ' ORDER BY column_name)
      INTO incompatible_columns
      FROM differences;

    IF incompatible_columns IS NOT NULL THEN
      RAISE EXCEPTION
        '0100 reconciliation refused: public.backup_runs has incompatible columns: %',
        incompatible_columns;
    END IF;
  END IF;

  LOCK TABLE public.backup_runs IN ACCESS EXCLUSIVE MODE;

  WITH expected(name) AS (
    VALUES
      ('backup_runs_pkey'),
      ('backup_runs_completed_after_started_check'),
      ('backup_runs_nonnegative_counts_check'),
      ('backup_runs_primary_totals_check'),
      ('backup_runs_primary_failure_shape_check'),
      ('backup_runs_replica_execution_check')
  )
  SELECT c.conname
    INTO unexpected_constraint
    FROM pg_constraint c
    LEFT JOIN expected e ON e.name = c.conname
   WHERE c.conrelid = 'public.backup_runs'::regclass
     AND e.name IS NULL
   ORDER BY c.conname
   LIMIT 1;

  IF unexpected_constraint IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_runs has unexpected constraint %',
      unexpected_constraint;
  END IF;

  SELECT index_class.relname
    INTO unexpected_index
    FROM pg_index i
    JOIN pg_class index_class ON index_class.oid = i.indexrelid
   WHERE i.indrelid = 'public.backup_runs'::regclass
     AND index_class.relname NOT IN (
       'backup_runs_pkey',
       'backup_runs_completed_idx'
     )
   ORDER BY index_class.relname
   LIMIT 1;

  IF unexpected_index IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_runs has unexpected index %',
      unexpected_index;
  END IF;

  SELECT t.tgname
    INTO unexpected_trigger
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.backup_runs'::regclass
     AND NOT t.tgisinternal
   ORDER BY t.tgname
   LIMIT 1;

  IF unexpected_trigger IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_runs has unexpected trigger %',
      unexpected_trigger;
  END IF;

  FOR constraint_row IN
    SELECT *
      FROM (VALUES
        ('backup_runs_pkey', 'PRIMARY KEY (id)',
          'ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_pkey PRIMARY KEY (id)'),
        ('backup_runs_completed_after_started_check',
          'CHECK (completed_at >= started_at)',
          'ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_completed_after_started_check CHECK (completed_at >= started_at)'),
        ('backup_runs_nonnegative_counts_check',
          'CHECK (practices >= 0 AND primary_verified >= 0 AND primary_failed >= 0 AND oversized >= 0 AND near_limit >= 0 AND max_export_bytes >= 0 AND replica_verified >= 0 AND replica_failed >= 0)',
          'ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_nonnegative_counts_check CHECK (practices >= 0 AND primary_verified >= 0 AND primary_failed >= 0 AND oversized >= 0 AND near_limit >= 0 AND max_export_bytes >= 0 AND replica_verified >= 0 AND replica_failed >= 0)'),
        ('backup_runs_primary_totals_check',
          'CHECK ((primary_verified + primary_failed) = practices)',
          'ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_primary_totals_check CHECK (primary_verified + primary_failed = practices)'),
        ('backup_runs_primary_failure_shape_check',
          $$CHECK (status = 'ok'::backup_run_status AND primary_failed = 0 AND replica_failed = 0 OR status = 'degraded'::backup_run_status AND (primary_failed > 0 OR replica_failed > 0) OR status = 'failed'::backup_run_status AND practices = 0 AND primary_verified = 0)$$,
          $$ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_primary_failure_shape_check CHECK ((status = 'ok' AND primary_failed = 0 AND replica_failed = 0) OR (status = 'degraded' AND (primary_failed > 0 OR replica_failed > 0)) OR (status = 'failed' AND practices = 0 AND primary_verified = 0))$$),
        ('backup_runs_replica_execution_check',
          'CHECK (replica_enabled OR replica_verified = 0 AND replica_failed = 0)',
          'ALTER TABLE public.backup_runs ADD CONSTRAINT backup_runs_replica_execution_check CHECK (replica_enabled OR (replica_verified = 0 AND replica_failed = 0))')
      ) AS definitions(name, expected_definition, add_sql)
  LOOP
    SELECT pg_get_constraintdef(c.oid, true)
      INTO existing_definition
      FROM pg_constraint c
     WHERE c.conrelid = 'public.backup_runs'::regclass
       AND c.conname = constraint_row.name;

    IF existing_definition IS NULL THEN
      EXECUTE constraint_row.add_sql;
    ELSIF existing_definition <> constraint_row.expected_definition THEN
      RAISE EXCEPTION
        '0100 reconciliation refused: constraint public.backup_runs.% is incompatible (found %)',
        constraint_row.name,
        existing_definition;
    ELSIF NOT (
      SELECT c.convalidated
        FROM pg_constraint c
       WHERE c.conrelid = 'public.backup_runs'::regclass
         AND c.conname = constraint_row.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.backup_runs VALIDATE CONSTRAINT %I',
        constraint_row.name
      );
    END IF;
  END LOOP;

  IF to_regclass('public.backup_runs_completed_idx') IS NULL THEN
    CREATE INDEX backup_runs_completed_idx
      ON public.backup_runs USING btree (completed_at, id);
  ELSIF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indexrelid = 'public.backup_runs_completed_idx'::regclass
       AND i.indisvalid
       AND i.indisready
       AND pg_get_indexdef(i.indexrelid, 0, true) =
         'CREATE INDEX backup_runs_completed_idx ON backup_runs USING btree (completed_at, id)'
  ) THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_runs_completed_idx is incompatible';
  END IF;
END
$migration$;--> statement-breakpoint

DO $migration$
DECLARE
  incompatible_column text;
  unexpected_constraint text;
  constraint_row record;
  existing_definition text;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: prerequisite public.users table is missing';
  END IF;

  LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE;

  WITH expected(attname, atttypid) AS (
    VALUES
      ('mfa_secret_encrypted', 'text'::regtype),
      ('mfa_enabled_at', 'timestamp with time zone'::regtype),
      ('mfa_last_used_totp_counter', 'integer'::regtype),
      ('mfa_recovery_code_hashes', 'jsonb'::regtype),
      ('mfa_pending_secret_encrypted', 'text'::regtype),
      ('mfa_pending_expires_at', 'timestamp with time zone'::regtype)
  )
  SELECT a.attname
    INTO incompatible_column
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
    LEFT JOIN expected e ON e.attname = a.attname
   WHERE a.attrelid = 'public.users'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attname LIKE 'mfa\_%' ESCAPE '\'
     AND (
       e.attname IS NULL
       OR a.atttypid <> e.atttypid
       OR a.attnotnull
       OR d.adbin IS NOT NULL
       OR a.attidentity <> ''
       OR a.attgenerated <> ''
     )
   ORDER BY a.attname
   LIMIT 1;

  IF incompatible_column IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.users.% has an incompatible shape',
      incompatible_column;
  END IF;

  ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text,
    ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS mfa_last_used_totp_counter integer,
    ADD COLUMN IF NOT EXISTS mfa_recovery_code_hashes jsonb,
    ADD COLUMN IF NOT EXISTS mfa_pending_secret_encrypted text,
    ADD COLUMN IF NOT EXISTS mfa_pending_expires_at timestamp with time zone;

  WITH expected(name) AS (
    VALUES
      ('users_mfa_active_shape_check'),
      ('users_mfa_pending_shape_check'),
      ('users_mfa_totp_counter_check')
  )
  SELECT c.conname
    INTO unexpected_constraint
    FROM pg_constraint c
    LEFT JOIN expected e ON e.name = c.conname
   WHERE c.conrelid = 'public.users'::regclass
     AND c.conname LIKE 'users_mfa\_%' ESCAPE '\'
     AND e.name IS NULL
   ORDER BY c.conname
   LIMIT 1;

  IF unexpected_constraint IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.users has unexpected MFA constraint %',
      unexpected_constraint;
  END IF;

  FOR constraint_row IN
    SELECT *
      FROM (VALUES
        ('users_mfa_active_shape_check',
          $$CHECK (mfa_enabled_at IS NULL AND mfa_secret_encrypted IS NULL AND mfa_last_used_totp_counter IS NULL AND mfa_recovery_code_hashes IS NULL OR mfa_enabled_at IS NOT NULL AND length(mfa_secret_encrypted) >= 40 AND length(mfa_secret_encrypted) <= 1024 AND jsonb_typeof(mfa_recovery_code_hashes) = 'array'::text AND jsonb_array_length(mfa_recovery_code_hashes) <= 20)$$,
          $$ALTER TABLE public.users ADD CONSTRAINT users_mfa_active_shape_check CHECK ((mfa_enabled_at IS NULL AND mfa_secret_encrypted IS NULL AND mfa_last_used_totp_counter IS NULL AND mfa_recovery_code_hashes IS NULL) OR (mfa_enabled_at IS NOT NULL AND length(mfa_secret_encrypted) BETWEEN 40 AND 1024 AND jsonb_typeof(mfa_recovery_code_hashes) = 'array' AND jsonb_array_length(mfa_recovery_code_hashes) <= 20))$$),
        ('users_mfa_pending_shape_check',
          'CHECK (mfa_pending_secret_encrypted IS NULL AND mfa_pending_expires_at IS NULL OR mfa_enabled_at IS NULL AND length(mfa_pending_secret_encrypted) >= 40 AND length(mfa_pending_secret_encrypted) <= 1024 AND mfa_pending_expires_at IS NOT NULL)',
          $$ALTER TABLE public.users ADD CONSTRAINT users_mfa_pending_shape_check CHECK ((mfa_pending_secret_encrypted IS NULL AND mfa_pending_expires_at IS NULL) OR (mfa_enabled_at IS NULL AND length(mfa_pending_secret_encrypted) BETWEEN 40 AND 1024 AND mfa_pending_expires_at IS NOT NULL))$$),
        ('users_mfa_totp_counter_check',
          'CHECK (mfa_last_used_totp_counter IS NULL OR mfa_last_used_totp_counter >= 0)',
          'ALTER TABLE public.users ADD CONSTRAINT users_mfa_totp_counter_check CHECK (mfa_last_used_totp_counter IS NULL OR mfa_last_used_totp_counter >= 0)')
      ) AS definitions(name, expected_definition, add_sql)
  LOOP
    SELECT pg_get_constraintdef(c.oid, true)
      INTO existing_definition
      FROM pg_constraint c
     WHERE c.conrelid = 'public.users'::regclass
       AND c.conname = constraint_row.name;

    IF existing_definition IS NULL THEN
      EXECUTE constraint_row.add_sql;
    ELSIF existing_definition <> constraint_row.expected_definition THEN
      RAISE EXCEPTION
        '0100 reconciliation refused: constraint public.users.% is incompatible (found %)',
        constraint_row.name,
        existing_definition;
    ELSIF NOT (
      SELECT c.convalidated
        FROM pg_constraint c
       WHERE c.conrelid = 'public.users'::regclass
         AND c.conname = constraint_row.name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.users VALIDATE CONSTRAINT %I',
        constraint_row.name
      );
    END IF;
  END LOOP;
END
$migration$;--> statement-breakpoint

-- Backup evidence is cross-tenant operational metadata. Install the boundary
-- in this same migration transaction so no newly-created table is fail-open.
CREATE OR REPLACE FUNCTION public.app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;--> statement-breakpoint

DO $migration$
DECLARE
  incompatible_policy text;
  role_name text;
BEGIN
  SELECT p.polname
    INTO incompatible_policy
    FROM pg_policy p
   WHERE p.polrelid = 'public.backup_runs'::regclass
     AND (
       p.polname <> 'system_only'
       OR p.polcmd <> '*'
       OR NOT p.polpermissive
       OR p.polroles <> ARRAY[0::oid]
       OR pg_get_expr(p.polqual, p.polrelid, true) <> 'app_rls_bypass()'
       OR pg_get_expr(p.polwithcheck, p.polrelid, true) <> 'app_rls_bypass()'
     )
   ORDER BY p.polname
   LIMIT 1;

  IF incompatible_policy IS NOT NULL THEN
    RAISE EXCEPTION
      '0100 reconciliation refused: public.backup_runs has incompatible policy %',
      incompatible_policy;
  END IF;

  ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy p
     WHERE p.polrelid = 'public.backup_runs'::regclass
       AND p.polname = 'system_only'
  ) THEN
    CREATE POLICY system_only ON public.backup_runs
      USING (public.app_rls_bypass())
      WITH CHECK (public.app_rls_bypass());
  END IF;

  REVOKE ALL ON TABLE public.backup_runs FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
    GRANT USAGE ON SCHEMA public TO openpims_app;
    REVOKE ALL ON TABLE public.backup_runs FROM openpims_app;
    GRANT SELECT, INSERT ON TABLE public.backup_runs TO openpims_app;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.backup_runs FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$migration$;

COMMENT ON TABLE public.backup_runs IS
  'Dormant aggregate-only backup evidence; no scheduler or backup job is activated by this schema.';
COMMENT ON COLUMN public.users.mfa_secret_encrypted IS
  'Dormant compatibility storage; MFA authentication is not activated by this migration.';
