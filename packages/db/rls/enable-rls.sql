-- OpenVPM — Postgres Row-Level Security (defense-in-depth multi-tenant isolation)
-- ============================================================================
-- These policies are a SECOND guard behind the app-layer practiceId filters.
-- They key off the `app.current_practice_id` GUC the app sets per request
-- (see apps/web/lib/tenant-db.ts: withTenant / withSystem).
--
-- The table OWNER bypasses RLS (we do NOT use FORCE), so:
--   • Migrations + dev/self-host on the owner connection are unaffected.
--   • Enforcement activates when the app connects as the least-privilege role
--     `openpims_app`, which you point the hosted DATABASE_URL at.
--
-- Apply with: pnpm db:rls   (idempotent — safe to re-run after schema changes)
--
-- ROLE CREATION: this file contains NO credentials. The `openpims_app` role is
-- created/managed by the apply script (packages/db/apply-rls.ts) using the
-- OPENPIMS_APP_DB_PASSWORD env var, or you create the role yourself beforehand.
-- The grants below assume the role already exists.
-- ============================================================================

-- 1) Grants for the least-privilege application role (must already exist).
GRANT USAGE ON SCHEMA public TO openpims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openpims_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO openpims_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openpims_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO openpims_app;

-- 2) Context helpers (NULL/false when the GUC is unset → deny by default).
CREATE OR REPLACE FUNCTION app_current_practice_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT nullif(current_setting('app.current_practice_id', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = ''
  AS
$fn$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $fn$;

-- 3) The practices root table is keyed on its own id.
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON practices;
CREATE POLICY tenant_isolation ON practices
  USING (app_rls_bypass() OR id = app_current_practice_id())
  WITH CHECK (app_rls_bypass() OR id = app_current_practice_id());

-- 4) Every practice_id-scoped table gets the same policy.
DO $$
DECLARE
  t text;
  tbls text[] := array[
    'api_keys','appointment_types','appointment_waitlist','appointments','audit_log','booking_pages',
    'capture_sessions','cases','clients','clinical_notes','communications','consent_forms','consent_requests','controlled_substance_log','email_suppressions',
    'files','insurance_claims','insurance_policies','invoices','lab_results','location_messaging','messaging_registrations','migration_runs',
    'locations','patients','practice_payment_accounts','prescriptions','problem_list','procedures','products','purchase_orders',
    'recurring_series','rooms','services','sms_suppressions','soap_notes','staff_schedules','suppliers',
    'treatment_plans','treatment_templates','usage_records','users','vaccination_records',
    'vital_signs','webhooks','wellness_enrollments','wellness_plans'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (app_rls_bypass() OR practice_id = app_current_practice_id()) '
      'WITH CHECK (app_rls_bypass() OR practice_id = app_current_practice_id())',
      t
    );
  END LOOP;
END$$;

-- 5) Child tables without their own practice_id are isolated by joining to the
--    parent row, which carries practice_id and its own tenant RLS.
DO $$
DECLARE
  i int;
  child_tbls text[][] := array[
    ['patient_allergies','patient_id','patients'],
    ['patient_weights','patient_id','patients'],
    ['case_entries','case_id','cases'],
    ['treatment_plan_items','plan_id','treatment_plans'],
    ['treatment_template_items','template_id','treatment_templates'],
    ['invoice_items','invoice_id','invoices'],
    ['invoice_adjustments','invoice_id','invoices'],
    ['payments','invoice_id','invoices']
  ];
BEGIN
  FOR i IN 1 .. array_length(child_tbls, 1) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', child_tbls[i][1]);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', child_tbls[i][1]);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %1$I '
      'USING (app_rls_bypass() OR EXISTS (SELECT 1 FROM %3$I p WHERE p.id = %1$I.%2$I AND p.practice_id = app_current_practice_id())) '
      'WITH CHECK (app_rls_bypass() OR EXISTS (SELECT 1 FROM %3$I p WHERE p.id = %1$I.%2$I AND p.practice_id = app_current_practice_id()))',
      child_tbls[i][1], child_tbls[i][2], child_tbls[i][3]
    );
  END LOOP;
END$$;

-- 6) Global reference data (no tenant): readable by every app role, writable
--    only by the owner / system bypass.
ALTER TABLE drug_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reference_read ON drug_interactions;
CREATE POLICY reference_read ON drug_interactions FOR SELECT USING (true);
DROP POLICY IF EXISTS reference_insert ON drug_interactions;
CREATE POLICY reference_insert ON drug_interactions FOR INSERT WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS reference_update ON drug_interactions;
CREATE POLICY reference_update ON drug_interactions FOR UPDATE USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS reference_delete ON drug_interactions;
CREATE POLICY reference_delete ON drug_interactions FOR DELETE USING (app_rls_bypass());

-- Stripe webhook event de-duplication is global/system state. Only system
-- context may read or write it; ordinary tenant context should see nothing.
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON stripe_events;
CREATE POLICY system_only ON stripe_events
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

-- Durable rate-limit buckets are also global/system state.
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON rate_limit_buckets;
CREATE POLICY system_only ON rate_limit_buckets
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

-- Demo lead capture is global pre-tenant state. Only the email-gate route,
-- running in explicit system context, may read or write it.
ALTER TABLE demo_accesses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON demo_accesses;
CREATE POLICY system_only ON demo_accesses
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

-- Product-funnel events are global operational telemetry. Browser writes go
-- through the bounded ingestion route; tenant sessions never query it.
ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON funnel_events;
CREATE POLICY system_only ON funnel_events
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

-- 7) Auth-infra tables are NOT tenant-scoped (tokens are used pre-login; the
--    NextAuth session/verification tables are unused under the JWT strategy). We
--    don't put tenant RLS on them; instead we revoke the Supabase data-API roles
--    so they're unreachable that way. The app connects via a direct Postgres
--    role, never anon/authenticated.
--    Guarded so the migration stays portable: anon/authenticated only exist on
--    Supabase, so on vanilla Postgres (local / CI) this is a no-op.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON auth_tokens, demo_accesses, funnel_events, sessions, verification_tokens FROM %I', r
      );
    END IF;
  END LOOP;
END $$;
