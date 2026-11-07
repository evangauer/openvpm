-- Hosted feature gates read verified billing milestones inside the clinic's
-- tenant transaction. Clinics may inspect only their own projection; writes
-- remain restricted to explicit system context. Split the former all-command
-- policy so the read path stays both least-privilege and single-policy.
DROP POLICY IF EXISTS system_only ON practice_conversion_milestones;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_select ON practice_conversion_milestones;--> statement-breakpoint
CREATE POLICY tenant_select ON practice_conversion_milestones
  FOR SELECT
  USING (
    app_rls_bypass()
    OR practice_id = app_current_practice_id()
  );--> statement-breakpoint
DROP POLICY IF EXISTS system_insert ON practice_conversion_milestones;--> statement-breakpoint
CREATE POLICY system_insert ON practice_conversion_milestones
  FOR INSERT
  WITH CHECK (app_rls_bypass());--> statement-breakpoint
DROP POLICY IF EXISTS system_update ON practice_conversion_milestones;--> statement-breakpoint
CREATE POLICY system_update ON practice_conversion_milestones
  FOR UPDATE
  USING (app_rls_bypass())
  WITH CHECK (app_rls_bypass());--> statement-breakpoint
DROP POLICY IF EXISTS system_delete ON practice_conversion_milestones;--> statement-breakpoint
CREATE POLICY system_delete ON practice_conversion_milestones
  FOR DELETE
  USING (app_rls_bypass());
