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

-- Backup-run evidence is cross-tenant, aggregate-only operational metadata.
-- It is intentionally not part of the tenant-table loop: only explicit
-- system context may read or append rows, and no app role may rewrite them.
ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON backup_runs;
CREATE POLICY system_only ON backup_runs
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());
REVOKE ALL ON backup_runs FROM PUBLIC;
REVOKE ALL ON backup_runs FROM openpims_app;
GRANT SELECT, INSERT ON backup_runs TO openpims_app;

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
    'capture_sessions','care_reminders','cases','client_contacts','clients','clinical_notes','clinical_record_corrections','communications','consent_forms','consent_requests','controlled_substance_log','dispense_charge_queue','email_suppressions',
    'external_lab_observations','external_lab_reports','external_prescription_fills','external_prescriptions','files','financial_closes','historical_appointments','historical_documents','insurance_claims','insurance_policies','invoices','lab_result_events','lab_result_replacements','lab_results','legacy_financial_allocations','legacy_financial_documents','legacy_financial_line_items','legacy_financial_payments','location_messaging','messaging_registration_events','messaging_registrations','migration_runs',
    'locations','patient_merge_events','patients','payment_disputes','payment_processor_payouts','payment_processor_refunds','payment_processor_settlements','portal_sessions','practice_payment_accounts','prescription_events','prescriptions','problem_list','procedures','products','purchase_orders',
    'recurring_series','rooms','services','sms_consent_events','sms_send_attempt_events','sms_send_attempts','sms_suppressions','soap_note_addenda','soap_note_replacements','soap_notes','staff_schedules','suppliers',
    'treatment_plans','treatment_templates','usage_records','users','vaccination_records',
    'visit_treatment_plan_response_lines','visit_treatment_plan_responses','visit_treatment_plan_revision_lines','visit_treatment_plan_revisions','visit_treatment_plans',
    'visit_closeouts','visit_work_items','vital_signs','webhooks','wellness_enrollments','wellness_plans'
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

-- Processor evidence is clinic-scoped but never deletable. Settlement,
-- refund, payout, and dispute projections may be reconciled in place by a
-- provider worker. A financial close is an append-only staff attestation.
REVOKE ALL ON payment_processor_settlements, payment_processor_refunds,
  payment_processor_payouts, payment_disputes, financial_closes
  FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON payment_processor_settlements,
  payment_processor_refunds, payment_processor_payouts, payment_disputes
  TO openpims_app;
GRANT SELECT, INSERT ON financial_closes TO openpims_app;
REVOKE ALL ON FUNCTION public.validate_payment_processor_refund_tenant()
  FROM PUBLIC, openpims_app;

-- Object-replica evidence is operational recovery state, not clinic-editable
-- data. Only an explicit system context may read or write it; the composite
-- database foreign key separately guarantees the file belongs to the row's
-- declared practice.
ALTER TABLE file_object_replicas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON file_object_replicas;
CREATE POLICY system_only ON file_object_replicas
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());
REVOKE ALL ON file_object_replicas FROM PUBLIC;
REVOKE ALL ON file_object_replicas FROM openpims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON file_object_replicas TO openpims_app;

-- Storage transition evidence is append-only operational history. Only the
-- system worker may read or append it; even that role cannot rewrite events.
ALTER TABLE file_storage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_read ON file_storage_events;
CREATE POLICY system_read ON file_storage_events
  FOR SELECT USING (app_rls_bypass());
DROP POLICY IF EXISTS system_insert ON file_storage_events;
CREATE POLICY system_insert ON file_storage_events
  FOR INSERT WITH CHECK (app_rls_bypass());
REVOKE ALL ON file_storage_events FROM PUBLIC;
REVOKE ALL ON file_storage_events FROM openpims_app;
GRANT SELECT, INSERT ON file_storage_events TO openpims_app;

-- Clinical correction events are a legal/clinical history ledger. The app may
-- append and read them, but even a future generic repository path must not
-- gain UPDATE or DELETE through the broad table grant above.
REVOKE UPDATE, DELETE ON clinical_record_corrections FROM openpims_app;
GRANT SELECT, INSERT ON clinical_record_corrections TO openpims_app;

-- Allergy source rows are immutable clinical safety evidence. A mistaken
-- entry remains exactly as recorded and is retired through the append-only
-- clinical correction ledger instead of being edited or soft-deleted.
REVOKE ALL ON patient_allergies FROM openpims_app;
GRANT SELECT, INSERT ON patient_allergies TO openpims_app;

-- SOAP addenda are immutable, attributed extensions to a finalized note.
REVOKE ALL ON soap_note_addenda FROM openpims_app;
GRANT SELECT, INSERT ON soap_note_addenda TO openpims_app;
REVOKE ALL ON FUNCTION restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) TO openpims_app;

-- Prescription lifecycle events are an append-only clinical ledger. Tenant
-- users may read and append attributed events through the transactional app
-- service, but even the application role cannot rewrite or remove history.
REVOKE ALL ON prescription_events FROM openpims_app;
GRANT SELECT, INSERT ON prescription_events TO openpims_app;

-- Lab result lifecycle events are immutable clinical safety evidence. The app
-- may append completion, review, and follow-up events but never rewrite them.
REVOKE ALL ON lab_result_events FROM openpims_app;
GRANT SELECT, INSERT ON lab_result_events TO openpims_app;

-- Lab replacement links are immutable amendment lineage. The app may create
-- and read links but cannot rewrite which result replaces which source.
REVOKE ALL ON lab_result_replacements FROM openpims_app;
GRANT SELECT, INSERT ON lab_result_replacements TO openpims_app;

-- SOAP replacement links are immutable amendment lineage. The app may create
-- and read links but cannot rewrite which finalized note replaces its source.
REVOKE ALL ON soap_note_replacements FROM openpims_app;
GRANT SELECT, INSERT ON soap_note_replacements TO openpims_app;
REVOKE ALL ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_soap_note_replacement(uuid,timestamptz,uuid,uuid,uuid,uuid,uuid,text,uuid,text) TO openpims_app;

-- Visit treatment-plan revisions and signed responses are legal decision
-- evidence. Tenant code may stage child rows and seal a header in one
-- transaction, but it can never rewrite or remove a sealed snapshot. The
-- root identity remains status-updatable for later workflow slices.
REVOKE ALL ON visit_treatment_plan_revisions,
  visit_treatment_plan_revision_lines,
  visit_treatment_plan_responses,
  visit_treatment_plan_response_lines
  FROM openpims_app;
GRANT SELECT, INSERT ON visit_treatment_plan_revisions,
  visit_treatment_plan_revision_lines,
  visit_treatment_plan_responses,
  visit_treatment_plan_response_lines
  TO openpims_app;
REVOKE DELETE ON visit_treatment_plans FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON visit_treatment_plans TO openpims_app;

REVOKE ALL ON FUNCTION compute_visit_treatment_plan_revision_sha256(uuid,uuid,uuid,integer,text,numeric,numeric,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_visit_treatment_plan_response_sha256(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compute_visit_treatment_plan_revision_sha256(uuid,uuid,uuid,integer,text,numeric,numeric,numeric) TO openpims_app;
GRANT EXECUTE ON FUNCTION compute_visit_treatment_plan_response_sha256(uuid,uuid,uuid,uuid) TO openpims_app;
REVOKE ALL ON FUNCTION validate_visit_treatment_plan_revision_seal() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION protect_visit_treatment_plan_revision() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION protect_visit_treatment_plan_revision_line() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION validate_visit_treatment_plan_response_seal() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION protect_visit_treatment_plan_response() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION protect_visit_treatment_plan_response_line() FROM PUBLIC, openpims_app;
REVOKE ALL ON FUNCTION protect_visit_treatment_plan_identity() FROM PUBLIC, openpims_app;

-- Carrier registration events are PHI-free, append-only lifecycle evidence.
REVOKE ALL ON messaging_registration_events FROM openpims_app;
GRANT SELECT, INSERT ON messaging_registration_events TO openpims_app;

-- Patient merge events are an append-only identity correction ledger. The app
-- can create and read attributed events but cannot rewrite or remove lineage.
REVOKE ALL ON patient_merge_events FROM openpims_app;
GRANT SELECT, INSERT ON patient_merge_events TO openpims_app;

-- SMS consent events are an append-only compliance ledger. The current client
-- consent projection may change; its evidence history may only be appended.
REVOKE ALL ON sms_consent_events FROM openpims_app;
GRANT SELECT, INSERT ON sms_consent_events TO openpims_app;

-- Outbound SMS reservations and outcomes form one append-only operational and
-- compliance ledger. Reconciliation is a new event, never a row rewrite.
REVOKE ALL ON sms_send_attempts, sms_send_attempt_events FROM openpims_app;
GRANT SELECT, INSERT ON sms_send_attempts, sms_send_attempt_events TO openpims_app;

-- Delivery callbacks can arrive before a tenant can be attributed. Raw
-- evidence is therefore global/system-only, while attributed history is
-- readable by its exact tenant. Both tables remain system-insert-only so a
-- clinic session cannot forge provider or operator evidence.
ALTER TABLE sms_delivery_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_evidence_select ON sms_delivery_events;
CREATE POLICY delivery_evidence_select ON sms_delivery_events
  FOR SELECT
  USING (
    app_rls_bypass()
    OR EXISTS (
      SELECT 1
      FROM sms_delivery_event_history attributed
      WHERE attributed.delivery_event_id = sms_delivery_events.id
        AND attributed.result = 'attributed'
        AND attributed.practice_id IS NOT NULL
        AND attributed.practice_id = app_current_practice_id()
    )
  );
DROP POLICY IF EXISTS delivery_evidence_insert ON sms_delivery_events;
CREATE POLICY delivery_evidence_insert ON sms_delivery_events
  FOR INSERT
  WITH CHECK (app_rls_bypass());

ALTER TABLE sms_delivery_event_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_history_select ON sms_delivery_event_history;
CREATE POLICY delivery_history_select ON sms_delivery_event_history
  FOR SELECT
  USING (
    app_rls_bypass()
    OR (
      practice_id IS NOT NULL
      AND practice_id = app_current_practice_id()
    )
  );
DROP POLICY IF EXISTS delivery_history_insert ON sms_delivery_event_history;
CREATE POLICY delivery_history_insert ON sms_delivery_event_history
  FOR INSERT
  WITH CHECK (app_rls_bypass());

REVOKE ALL ON sms_delivery_events, sms_delivery_event_history FROM openpims_app;
GRANT SELECT, INSERT ON sms_delivery_events, sms_delivery_event_history TO openpims_app;

-- Verification-email dispatch and delivery evidence is global auth operations
-- state. A clinic session must not read another user's verification history or
-- forge provider outcomes. Delivery callbacks are immutable once inserted.
ALTER TABLE auth_email_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON auth_email_attempts;
CREATE POLICY system_only ON auth_email_attempts
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE auth_email_delivery_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON auth_email_delivery_events;
CREATE POLICY system_only ON auth_email_delivery_events
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE auth_email_webhook_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON auth_email_webhook_conflicts;
CREATE POLICY system_only ON auth_email_webhook_conflicts
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE auth_email_provider_identity_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON auth_email_provider_identity_conflicts;
CREATE POLICY system_only ON auth_email_provider_identity_conflicts
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON auth_email_attempts TO openpims_app;
GRANT SELECT, INSERT ON auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts TO openpims_app;

-- Signed provider SMS facts are global until exact routing attributes them.
-- They may include message content, so clinic sessions cannot read the inbox;
-- only explicit system work may ingest, project, retry, or inspect it. Conflict
-- evidence is append-only and deliberately stores no body or phone numbers.
ALTER TABLE sms_provider_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON sms_provider_events;
CREATE POLICY system_only ON sms_provider_events
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE sms_provider_event_conflicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON sms_provider_event_conflicts;
CREATE POLICY system_only ON sms_provider_event_conflicts
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE sms_provider_event_conflict_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON sms_provider_event_conflict_reviews;
CREATE POLICY system_only ON sms_provider_event_conflict_reviews
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE sms_provider_event_resolutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON sms_provider_event_resolutions;
CREATE POLICY system_only ON sms_provider_event_resolutions
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews, sms_provider_event_resolutions FROM PUBLIC;
REVOKE ALL ON sms_provider_events, sms_provider_event_conflicts, sms_provider_event_conflict_reviews, sms_provider_event_resolutions FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON sms_provider_events TO openpims_app;
GRANT SELECT, INSERT ON sms_provider_event_conflicts, sms_provider_event_conflict_reviews, sms_provider_event_resolutions TO openpims_app;

-- Trigger implementation only: never expose its SECURITY DEFINER authority as
-- a directly callable function to public, API, or application roles.
REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM openpims_app;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.validate_sms_provider_event_resolution_insert() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

-- Dispense charge snapshots are durable revenue work. The app may advance or
-- reopen their attributed workflow status, while database triggers prevent
-- snapshot changes and all deletion.
REVOKE ALL ON dispense_charge_queue FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON dispense_charge_queue TO openpims_app;

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

-- Canonical conversion milestones are a cross-tenant, repairable system
-- projection. Product routes write under explicit system context. Ordinary
-- clinic sessions may read their own verified milestones for feature gates,
-- but may not create or change them.
ALTER TABLE practice_conversion_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON practice_conversion_milestones;
DROP POLICY IF EXISTS tenant_select ON practice_conversion_milestones;
CREATE POLICY tenant_select ON practice_conversion_milestones
  FOR SELECT
  USING (
    app_rls_bypass()
    OR practice_id = app_current_practice_id()
  );
DROP POLICY IF EXISTS system_insert ON practice_conversion_milestones;
CREATE POLICY system_insert ON practice_conversion_milestones
  FOR INSERT
  WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS system_update ON practice_conversion_milestones;
CREATE POLICY system_update ON practice_conversion_milestones
  FOR UPDATE
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());
DROP POLICY IF EXISTS system_delete ON practice_conversion_milestones;
CREATE POLICY system_delete ON practice_conversion_milestones
  FOR DELETE
  USING (app_rls_bypass());

-- Controlled clinic-pilot state spans tenants and belongs only to platform
-- operators. Clinics cannot inspect cohort decisions, other practices, or the
-- immutable operator audit trail through a tenant session.
ALTER TABLE clinic_pilots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON clinic_pilots;
CREATE POLICY system_only ON clinic_pilots
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE clinic_pilot_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_read ON clinic_pilot_events;
CREATE POLICY system_read ON clinic_pilot_events
  FOR SELECT USING (app_rls_bypass());
DROP POLICY IF EXISTS system_insert ON clinic_pilot_events;
CREATE POLICY system_insert ON clinic_pilot_events
  FOR INSERT WITH CHECK (app_rls_bypass());

REVOKE ALL ON clinic_pilots, clinic_pilot_events FROM openpims_app;
GRANT SELECT, INSERT, UPDATE ON clinic_pilots TO openpims_app;
GRANT SELECT, INSERT ON clinic_pilot_events TO openpims_app;

-- Keep the operator projection and immutable evidence ledger inseparable even
-- if a future system-context path bypasses the application helper.
CREATE OR REPLACE FUNCTION enforce_clinic_pilot_projection_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.clinic_pilot_events e
    WHERE e.clinic_pilot_id = NEW.id
      AND e.practice_id = NEW.practice_id
      AND e.projection_version = NEW.version
      AND e.cohort_key = NEW.cohort_key
      AND e.workflow = NEW.workflow
      AND e.stage = NEW.stage
      AND e.decision = NEW.decision
      AND e.qualification_checklist = NEW.qualification_checklist
      AND e.readiness_checklist = NEW.readiness_checklist
      AND e.blocker_codes = NEW.blocker_codes
      AND e.next_action = NEW.next_action
      AND e.support_cadence = NEW.support_cadence
      AND e.owner_identity = NEW.owner_identity
      AND e.communication_mode = NEW.communication_mode
      AND e.communication_tested_at IS NOT DISTINCT FROM NEW.communication_tested_at
      AND e.first_visit_validated_at IS NOT DISTINCT FROM NEW.first_visit_validated_at
      AND e.first_visit_validated_closeout_id IS NOT DISTINCT FROM NEW.first_visit_validated_closeout_id
      AND e.clinic_use_validated_at IS NOT DISTINCT FROM NEW.clinic_use_validated_at
      AND e.clinic_use_validated_hash IS NOT DISTINCT FROM NEW.clinic_use_validated_hash
      AND e.clinic_acceptance_at IS NOT DISTINCT FROM NEW.clinic_acceptance_at
      AND e.clinic_acceptance_by_user_id IS NOT DISTINCT FROM NEW.clinic_acceptance_by_user_id
      AND e.last_contact_at IS NOT DISTINCT FROM NEW.last_contact_at
      AND e.last_contact_outcome IS NOT DISTINCT FROM NEW.last_contact_outcome
      AND e.target_start_on IS NOT DISTINCT FROM NEW.target_start_on
      AND e.next_review_at IS NOT DISTINCT FROM NEW.next_review_at
  ) THEN
    RAISE EXCEPTION 'clinic pilot projection version % requires a matching immutable event', NEW.version;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS clinic_pilots_require_event ON clinic_pilots;
CREATE CONSTRAINT TRIGGER clinic_pilots_require_event
AFTER INSERT OR UPDATE ON clinic_pilots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_clinic_pilot_projection_audit();

CREATE OR REPLACE FUNCTION reject_clinic_pilot_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(class.relowner)
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
      WHERE namespace.nspname = TG_TABLE_SCHEMA AND class.relname = TG_TABLE_NAME
    )
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Clinic pilot events are immutable.';
END;
$$;
DROP TRIGGER IF EXISTS clinic_pilot_events_immutable ON clinic_pilot_events;
CREATE TRIGGER clinic_pilot_events_immutable
BEFORE UPDATE OR DELETE ON clinic_pilot_events
FOR EACH ROW EXECUTE FUNCTION reject_clinic_pilot_event_mutation();

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

-- OpenVPM's own optional-email preferences are global recipient state. Clinic
-- sessions may manage them only through server routes running in explicit
-- system context; hashes and audit evidence are never tenant-readable
-- directly. The identity key record and event history are append-only to the
-- application role; only the current projection may be updated.
ALTER TABLE platform_email_identity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_read ON platform_email_identity;
CREATE POLICY system_read ON platform_email_identity
  FOR SELECT USING (app_rls_bypass());
DROP POLICY IF EXISTS system_insert ON platform_email_identity;
CREATE POLICY system_insert ON platform_email_identity
  FOR INSERT WITH CHECK (app_rls_bypass());

ALTER TABLE platform_email_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON platform_email_preferences;
CREATE POLICY system_only ON platform_email_preferences
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());

ALTER TABLE platform_email_preference_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_read ON platform_email_preference_events;
CREATE POLICY system_read ON platform_email_preference_events
  FOR SELECT USING (app_rls_bypass());
DROP POLICY IF EXISTS system_insert ON platform_email_preference_events;
CREATE POLICY system_insert ON platform_email_preference_events
  FOR INSERT WITH CHECK (app_rls_bypass());

REVOKE ALL ON platform_email_identity, platform_email_preferences, platform_email_preference_events FROM openpims_app;
GRANT SELECT, INSERT ON platform_email_identity TO openpims_app;
GRANT SELECT, INSERT, UPDATE ON platform_email_preferences TO openpims_app;
GRANT SELECT, INSERT ON platform_email_preference_events TO openpims_app;

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
        'REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_provider_identity_conflicts, auth_email_webhook_conflicts, auth_tokens, backup_runs, clinic_pilot_events, clinic_pilots, clinical_record_corrections, demo_accesses, dispense_charge_queue, file_object_replicas, file_storage_events, financial_closes, funnel_events, lab_result_events, lab_result_replacements, messaging_registration_events, patient_allergies, patient_merge_events, payment_disputes, payment_processor_payouts, payment_processor_refunds, payment_processor_settlements, platform_email_identity, platform_email_preference_events, platform_email_preferences, practice_conversion_milestones, prescription_events, sessions, sms_delivery_event_history, sms_delivery_events, sms_provider_event_conflict_reviews, sms_provider_event_conflicts, sms_provider_event_resolutions, sms_provider_events, sms_send_attempt_events, sms_send_attempts, stripe_events, verification_tokens FROM %I', r
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.validate_payment_processor_refund_tenant() FROM %I', r
      );
    END IF;
  END LOOP;
END $$;
