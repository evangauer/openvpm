import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(process.cwd(), "../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("committed Drizzle migrations", () => {
  it("exercises committed migrations in the CI RLS isolation job", () => {
    const ci = readRepoFile(".github/workflows/ci.yml");

    expect(ci).toContain("pnpm --filter @openpims/db db:migrate");
    expect(ci).not.toContain("drizzle-kit push --force");
  });

  it("includes a baseline migration registered in the Drizzle journal", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };

    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0000_baseline",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0001_wellness_enrollment_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0002_location_messaging_sender_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0003_product_inventory_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0004_auth_expiry_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0005_rate_limit_bucket_reset_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0006_practice_billing_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0007_patient_chart_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0008_payment_invoice_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0009_scheduling_configuration_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0010_webhook_dispatch_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0011_catalog_lookup_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0012_wellness_plan_list_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0013_api_key_practice_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0014_clinical_child_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0015_waitlist_target_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0016_appointment_target_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0017_location_guard_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0018_invoice_item_active_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0019_invoice_list_index",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0020_invoice_target_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0021_communications_active_indexes",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0022_email_suppressions",
    );
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0025_practice_payment_accounts",
    );
  });

  it("captures hot-table indexes in the baseline SQL", () => {
    const sql = readRepoFile("packages/db/drizzle/0000_baseline.sql");

    for (const indexName of [
      "communications_practice_list_idx",
      "communications_client_timeline_idx",
      "communications_inbox_status_idx",
      "communications_assigned_idx",
      "vaccination_records_patient_idx",
      "vaccination_records_practice_due_idx",
      "lab_results_patient_idx",
      "lab_results_practice_status_idx",
      "procedures_patient_idx",
      "procedures_practice_idx",
      "soap_notes_patient_idx",
      "soap_notes_practice_idx",
      "clinical_notes_patient_idx",
      "clinical_notes_practice_idx",
      "problem_list_patient_status_idx",
      "problem_list_practice_status_idx",
      "users_practice_idx",
      "users_location_idx",
      "users_role_idx",
      "locations_practice_idx",
      "locations_primary_idx",
      "products_practice_idx",
      "products_location_idx",
      "products_sku_idx",
      "products_expiration_idx",
      "invoice_items_invoice_idx",
      "invoice_items_item_idx",
      "prescriptions_patient_status_idx",
      "prescriptions_practice_status_idx",
      "prescriptions_product_idx",
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }
  });

  it("commits wellness enrollment indexes used by billing automation", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0001_wellness_enrollment_indexes.sql",
    );

    expect(sql).toContain(
      'CREATE INDEX "wellness_enrollments_billing_due_idx"',
    );
    expect(sql).toContain('CREATE INDEX "wellness_enrollments_target_idx"');
  });

  it("commits the location messaging sender index used by SMS webhooks", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0002_location_messaging_sender_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "location_messaging_sender_idx"');
    expect(sql).toContain('ON "location_messaging"');
    expect(sql).toContain('("sender_e164")');
  });

  it("commits product indexes used by inventory list and alert workflows", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0003_product_inventory_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "products_practice_name_idx"');
    expect(sql).toContain(
      'ON "products" USING btree ("practice_id","deleted_at","name")',
    );
    expect(sql).toContain('CREATE INDEX "products_stock_alert_idx"');
    expect(sql).toContain(
      'ON "products" USING btree ("practice_id","deleted_at","stock_quantity")',
    );
  });

  it("commits auth expiry indexes used by cleanup automation", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0004_auth_expiry_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "sessions_expires_idx"');
    expect(sql).toContain('ON "sessions" USING btree ("expires")');
    expect(sql).toContain('CREATE INDEX "verification_tokens_expires_idx"');
    expect(sql).toContain('ON "verification_tokens" USING btree ("expires")');
    expect(sql).toContain('CREATE INDEX "auth_tokens_expires_idx"');
    expect(sql).toContain('ON "auth_tokens" USING btree ("expires_at")');
  });

  it("commits the rate-limit reset index used by cleanup automation", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0005_rate_limit_bucket_reset_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "rate_limit_buckets_reset_at_idx"');
    expect(sql).toContain('ON "rate_limit_buckets" USING btree ("reset_at")');
  });

  it("commits practice indexes used by hosted billing automation", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0006_practice_billing_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "practices_billing_trial_idx"');
    expect(sql).toContain(
      'ON "practices" USING btree ("billing_status","trial_ends_at","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "practices_stripe_customer_idx"');
    expect(sql).toContain(
      'ON "practices" USING btree ("stripe_customer_id","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "practices_stripe_subscription_idx"');
    expect(sql).toContain(
      'ON "practices" USING btree ("stripe_subscription_id","deleted_at")',
    );
  });

  it("commits patient chart indexes used by weight and allergy lookups", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0007_patient_chart_indexes.sql",
    );

    expect(sql).toContain(
      'CREATE INDEX "patient_weights_patient_recorded_idx"',
    );
    expect(sql).toContain(
      'ON "patient_weights" USING btree ("patient_id","deleted_at","recorded_at")',
    );
    expect(sql).toContain('CREATE INDEX "patient_allergies_patient_idx"');
    expect(sql).toContain(
      'ON "patient_allergies" USING btree ("patient_id","deleted_at")',
    );
  });

  it("commits the payment invoice index used by billing history lookups", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0008_payment_invoice_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "payments_invoice_idx"');
    expect(sql).toContain(
      'ON "payments" USING btree ("invoice_id","deleted_at","received_at")',
    );
  });

  it("commits Stripe Connect practice payment account storage", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0025_practice_payment_accounts.sql",
    );

    expect(sql).toContain('CREATE TABLE "practice_payment_accounts"');
    expect(sql).toContain('"stripe_account_id" varchar(128) NOT NULL');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "practice_payment_accounts_practice_provider_uq"',
    );
    expect(sql).toContain(
      'CREATE INDEX "practice_payment_accounts_status_idx"',
    );
  });

  it("commits scheduling indexes used by settings and booking lookups", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0009_scheduling_configuration_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "appointment_types_practice_name_idx"');
    expect(sql).toContain(
      'ON "appointment_types" USING btree ("practice_id","deleted_at","name")',
    );
    expect(sql).toContain('CREATE INDEX "rooms_practice_name_idx"');
    expect(sql).toContain(
      'ON "rooms" USING btree ("practice_id","deleted_at","name")',
    );
    expect(sql).toContain('CREATE INDEX "rooms_location_idx"');
    expect(sql).toContain(
      'ON "rooms" USING btree ("practice_id","location_id","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "staff_schedules_location_idx"');
    expect(sql).toContain(
      'ON "staff_schedules" USING btree ("practice_id","location_id","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "staff_schedules_user_idx"');
    expect(sql).toContain(
      'ON "staff_schedules" USING btree ("practice_id","user_id","deleted_at")',
    );
  });

  it("commits the webhook dispatch index used by integration delivery", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0010_webhook_dispatch_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "webhooks_practice_active_idx"');
    expect(sql).toContain(
      'ON "webhooks" USING btree ("practice_id","deleted_at","active")',
    );
  });

  it("commits catalog indexes used by service and supplier pickers", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0011_catalog_lookup_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "services_practice_name_idx"');
    expect(sql).toContain(
      'ON "services" USING btree ("practice_id","deleted_at","name")',
    );
    expect(sql).toContain('CREATE INDEX "suppliers_practice_name_idx"');
    expect(sql).toContain(
      'ON "suppliers" USING btree ("practice_id","deleted_at","name")',
    );
  });

  it("commits the wellness plan index used by plan lists", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0012_wellness_plan_list_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "wellness_plans_practice_created_idx"');
    expect(sql).toContain(
      'ON "wellness_plans" USING btree ("practice_id","deleted_at","created_at")',
    );
  });

  it("commits the API key index used by admin key lists", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0013_api_key_practice_index.sql",
    );

    expect(sql).toContain('CREATE INDEX "api_keys_practice_created_idx"');
    expect(sql).toContain(
      'ON "api_keys" USING btree ("practice_id","deleted_at","created_at")',
    );
  });

  it("commits clinical child indexes used by plan and export lookups", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0014_clinical_child_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "case_entries_case_idx"');
    expect(sql).toContain(
      'ON "case_entries" USING btree ("case_id","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "treatment_plan_items_plan_order_idx"');
    expect(sql).toContain(
      'ON "treatment_plan_items" USING btree ("plan_id","deleted_at","sort_order")',
    );
  });

  it("commits waitlist target indexes used by delete safety checks", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0015_waitlist_target_indexes.sql",
    );

    expect(sql).toContain('CREATE INDEX "waitlist_client_status_idx"');
    expect(sql).toContain(
      'ON "appointment_waitlist" USING btree ("practice_id","client_id","status","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "waitlist_patient_status_idx"');
    expect(sql).toContain(
      'ON "appointment_waitlist" USING btree ("practice_id","patient_id","status","deleted_at")',
    );
  });

  it("commits appointment target indexes used by active appointment guards", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0016_appointment_target_indexes.sql",
    );

    for (const [indexName, targetColumn] of [
      ["appointments_client_status_idx", "client_id"],
      ["appointments_patient_status_idx", "patient_id"],
      ["appointments_doctor_status_idx", "doctor_id"],
      ["appointments_type_status_idx", "type_id"],
      ["appointments_room_status_idx", "room_id"],
    ]) {
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
      expect(sql).toContain(
        `ON "appointments" USING btree ("practice_id","${targetColumn}","status","deleted_at")`,
      );
    }
  });

  it("commits tenant-scoped location guard indexes for staff and products", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0017_location_guard_indexes.sql",
    );

    expect(sql).toContain('DROP INDEX "users_location_idx"');
    expect(sql).toContain('DROP INDEX "products_location_idx"');
    expect(sql).toContain('CREATE INDEX "users_location_idx"');
    expect(sql).toContain(
      'ON "users" USING btree ("practice_id","location_id","deleted_at")',
    );
    expect(sql).toContain('CREATE INDEX "products_location_idx"');
    expect(sql).toContain(
      'ON "products" USING btree ("practice_id","location_id","deleted_at")',
    );
  });

  it("commits the active invoice-item index used by billing lookups", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0018_invoice_item_active_index.sql",
    );

    expect(sql).toContain('DROP INDEX "invoice_items_item_idx"');
    expect(sql).toContain('CREATE INDEX "invoice_items_item_idx"');
    expect(sql).toContain(
      'ON "invoice_items" USING btree ("item_type","deleted_at","item_id")',
    );
  });

  it("commits the invoice list index used by newest-first billing pages", () => {
    const sql = readRepoFile("packages/db/drizzle/0019_invoice_list_index.sql");

    expect(sql).toContain('DROP INDEX "invoices_practice_idx"');
    expect(sql).toContain('CREATE INDEX "invoices_practice_idx"');
    expect(sql).toContain(
      'ON "invoices" USING btree ("practice_id","deleted_at","created_at")',
    );
  });

  it("commits invoice target indexes used by client and patient workflows", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0020_invoice_target_indexes.sql",
    );

    expect(sql).toContain('DROP INDEX "invoices_client_idx"');
    expect(sql).toContain('CREATE INDEX "invoices_client_idx"');
    expect(sql).toContain(
      'ON "invoices" USING btree ("practice_id","client_id","deleted_at","created_at")',
    );
    expect(sql).toContain('CREATE INDEX "invoices_patient_idx"');
    expect(sql).toContain(
      'ON "invoices" USING btree ("practice_id","patient_id","client_id","deleted_at")',
    );
  });

  it("commits active communications indexes used by shared inbox workflows", () => {
    const sql = readRepoFile(
      "packages/db/drizzle/0021_communications_active_indexes.sql",
    );

    for (const indexName of [
      "communications_practice_list_idx",
      "communications_client_timeline_idx",
      "communications_inbox_status_idx",
      "communications_assigned_idx",
      "communications_provider_message_idx",
    ]) {
      expect(sql).toContain(`DROP INDEX "${indexName}"`);
      expect(sql).toContain(`CREATE INDEX "${indexName}"`);
    }

    expect(sql).toContain(
      'ON "communications" USING btree ("practice_id","deleted_at","created_at")',
    );
    expect(sql).toContain(
      'ON "communications" USING btree ("practice_id","client_id","deleted_at","created_at")',
    );
    expect(sql).toContain(
      'ON "communications" USING btree ("practice_id","direction","status","deleted_at")',
    );
    expect(sql).toContain(
      'ON "communications" USING btree ("practice_id","assigned_to","deleted_at")',
    );
    expect(sql).toContain(
      'ON "communications" USING btree ("practice_id","provider_message_id","channel","direction")',
    );
  });

  it("commits email suppressions used by Resend bounce and complaint webhooks", () => {
    const sql = readRepoFile("packages/db/drizzle/0022_email_suppressions.sql");

    expect(sql).toContain('CREATE TYPE "public"."email_suppression_reason"');
    expect(sql).toContain('CREATE TABLE "email_suppressions"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "email_suppressions_practice_email_uq"',
    );
    expect(sql).toContain(
      'ON "email_suppressions" USING btree ("practice_id","email")',
    );
    expect(sql).toContain('CREATE INDEX "email_suppressions_practice_idx"');
    expect(sql).toContain(
      'ON "email_suppressions" USING btree ("practice_id","deleted_at")',
    );
  });

  it("commits the tenant-scoped exact-file migration run ledger", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0041_aromatic_rhino",
    );

    const sql = readRepoFile("packages/db/drizzle/0041_aromatic_rhino.sql");
    expect(sql).toContain('CREATE TABLE "migration_runs"');
    expect(sql).toContain(
      "CREATE TYPE \"public\".\"migration_run_mode\" AS ENUM('clients', 'patients', 'vaccinations', 'soap_notes')",
    );
    expect(sql).toContain("'previewed', 'superseded', 'committing'");
    expect(sql).toContain('CONSTRAINT "migration_runs_file_hash_check"');
    expect(sql).toContain('CONSTRAINT "migration_runs_counts_check"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "migration_runs_active_preview_uq"',
    );
    expect(sql).toContain(
      'WHERE "migration_runs"."status" = \'previewed\' and "migration_runs"."deleted_at" is null',
    );

    const rls = readRepoFile("packages/db/rls/enable-rls.sql");
    expect(rls).toContain("'migration_runs'");
  });

  it("adds a backfilled privacy-safe reviewed-plan hash to migration runs", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0044_round_chronomancer",
    );

    const sql = readRepoFile("packages/db/drizzle/0044_round_chronomancer.sql");
    expect(sql).toContain('ADD COLUMN "reviewed_plan_hash" varchar(64)');
    expect(sql).toContain(
      'SET "reviewed_plan_hash" = "file_hash" WHERE "reviewed_plan_hash" IS NULL',
    );
    expect(sql).toContain('ALTER COLUMN "reviewed_plan_hash" SET NOT NULL');
    expect(sql).toContain(
      'CONSTRAINT "migration_runs_reviewed_plan_hash_check"',
    );
    expect(sql).not.toMatch(/name|email|phone|note|external_id|raw_csv/i);
  });

  it("fails clearly before enforcing one active invoice per visit", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0042_tough_mattie_franklin",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0042_tough_mattie_franklin.sql",
    );
    expect(sql).toContain('CREATE TABLE "visit_closeouts"');
    expect(sql).toContain('"medication_snapshot" jsonb');
    expect(sql).toContain('"follow_up_scheduled_at" timestamp with time zone');
    expect(sql).toContain('GROUP BY "practice_id", "appointment_id"');
    expect(sql).toContain("HAVING count(*) > 1");
    expect(sql).toContain(
      "duplicate active visit invoices require audited reconciliation",
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "invoices_active_appointment_uq"',
    );
  });

  it("adds retry-safe billing operations and accountable follow-up work", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0043_normal_bloodstrike",
    );

    const sql = readRepoFile("packages/db/drizzle/0043_normal_bloodstrike.sql");
    expect(sql).toContain('"prescriptions" ADD COLUMN "operation_id" uuid');
    expect(sql).toContain(
      '"invoice_adjustments" ADD COLUMN "operation_key" varchar(160)',
    );
    expect(sql).toContain(
      'CONSTRAINT "invoice_items_source_prescription_id_prescriptions_id_fk"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "invoice_items_source_prescription_invoice_uq"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "prescriptions_practice_operation_uq"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "invoice_adjustments_operation_key_uq"',
    );
    expect(sql).toContain("invoice_adjustments_operation_result_check");
    expect(sql).toContain(
      'ALTER TYPE "public"."visit_follow_up_disposition" RENAME TO "visit_follow_up_disposition_old"',
    );
    expect(sql).toContain(
      "CREATE TYPE \"public\".\"visit_follow_up_disposition\" AS ENUM('none', 'needed', 'scheduled')",
    );
    expect(sql).toContain(
      'ALTER TABLE "visit_closeouts" ALTER COLUMN "follow_up_disposition" TYPE',
    );
    expect(sql).not.toContain("ADD VALUE 'needed'");
    expect(sql).toContain(
      '"visit_closeouts" ADD COLUMN "follow_up_due_date" date',
    );
    expect(sql).toContain(
      '"visit_closeouts" ADD COLUMN "amendment_draft" jsonb',
    );
    expect(sql).toContain("visit_closeouts_follow_up_resolution_check");
  });

  it("adds the tenant-bound visit work ledger before checkout enforcement ships", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0045_visit_work_ledger",
    );

    const sql = readRepoFile("packages/db/drizzle/0045_visit_work_ledger.sql");
    expect(sql).toContain('CREATE TABLE "visit_work_items"');
    expect(sql).toContain(
      '"vaccination_records" ADD COLUMN "appointment_id" uuid',
    );
    expect(sql).toContain("visit_work_items_exactly_one_source_check");
    expect(sql).toContain("visit_work_items_resolution_check");
    expect(sql).toContain("visit_work_items_practice_appointment_fk");
    expect(sql).toContain("visit_work_items_vaccination_source_fk");
    expect(sql).toContain("visit_work_items_invoice_visit_fk");
    expect(sql).toContain("visit_work_items_invoice_item_fk");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("a.status IN ('checked_in', 'in_exam')");
    expect(
      sql.indexOf('CREATE UNIQUE INDEX "appointments_practice_id_uq"'),
    ).toBeLessThan(sql.indexOf("visit_work_items_practice_appointment_fk"));
  });

  it("indexes tenant appointment vital timelines", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0046_encounter_vitals_index",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0046_encounter_vitals_index.sql",
    );
    expect(sql).toContain(
      'CREATE INDEX "vital_signs_appointment_idx" ON "vital_signs"',
    );
    expect(sql).toContain(
      '("practice_id","appointment_id","deleted_at","recorded_at")',
    );
  });

  it("adds an append-only tenant-bound prescription lifecycle ledger", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0048_prescription_lifecycle",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0048_prescription_lifecycle.sql",
    );
    const tableDefinition = sql.match(
      /CREATE TABLE "prescription_events" \([\s\S]*?\n\);/,
    )?.[0];

    expect(sql).toContain("'refill_authorized'");
    expect(tableDefinition).toBeDefined();
    expect(tableDefinition).not.toContain('"updated_at"');
    expect(tableDefinition).not.toContain('"deleted_at"');
    expect(sql).toContain("prescription_events_shape_check");
    expect(sql).toContain("prescription_events_practice_prescription_fk");
    expect(sql).toContain("prescription_events_practice_operation_uq");
    expect(sql).toContain("prescription_events_validate_source");
    expect(sql).toContain("source.patient_id = NEW.patient_id");
    expect(sql).toContain(
      "source.product_id IS NOT DISTINCT FROM NEW.product_id",
    );
    expect(sql).toContain("source.quantity IS NOT DISTINCT FROM NEW.quantity");
    expect(sql).toContain("prescription_events_immutable");
    expect(sql).toContain("app.ledger_maintenance");
    expect(sql).toContain(
      "ALTER TABLE prescription_events ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON prescription_events TO openpims_app",
    );
    expect(sql).toContain("REVOKE ALL ON prescription_events FROM anon");
    expect(sql).toContain(
      "REVOKE ALL ON prescription_events FROM authenticated",
    );
  });

  it("adds a durable tenant-bound dispense-to-charge queue", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0049_dispense_charge_queue",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0049_dispense_charge_queue.sql",
    );
    expect(sql).toContain('CREATE TABLE "dispense_charge_queue"');
    expect(sql).toContain('ADD COLUMN "source_dispense_charge_id" uuid');
    expect(sql).toContain("dispense_charge_queue_shape_check");
    expect(sql).toContain("dispense_charge_queue_practice_event_fk");
    expect(sql.indexOf("prescription_events_practice_id_uq")).toBeLessThan(
      sql.indexOf("dispense_charge_queue_practice_event_fk"),
    );
    expect(sql).toContain("dispense_charge_queue_validate_source");
    expect(sql).toContain("invoice_items_validate_dispense_charge");
    expect(sql).toContain("dispense_charge_queue_protect");
    expect(sql).toContain("dispense_charge_queue_no_delete");
    expect(sql).toContain("invoice_items_reopen_dispense_charge");
    expect(sql).toContain("invoices_reopen_dispense_charges");
    expect(sql).toContain("legacy_review");
    expect(sql).toContain(
      "charged prescription work does not match an active dispense invoice line",
    );
    expect(sql).toContain(
      "prescription invoice target does not match its dispense patient and visit",
    );
    expect(sql).toContain(
      "invoice.appointment_id IS DISTINCT FROM prescription.appointment_id",
    );
    expect(sql).toContain(
      "source_queue.appointment_id IS DISTINCT FROM target_invoice.appointment_id",
    );
    expect(sql).toContain("invalid medication dispense charge resolver");
    expect(sql).toContain(
      "ALTER TABLE dispense_charge_queue ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE ON dispense_charge_queue TO openpims_app",
    );
    expect(sql).toContain("REVOKE ALL ON dispense_charge_queue FROM anon");
    expect(sql).toContain(
      "REVOKE ALL ON dispense_charge_queue FROM authenticated",
    );
  });

  it("backfills explicit requestable types for legacy booking pages", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0052_booking_page_request_types",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0052_booking_page_request_types.sql",
    );
    expect(sql).toContain("at.practice_id = bp.practice_id");
    expect(sql).toContain("at.deleted_at IS NULL");
    expect(sql).toContain("'{bookableTypeIds}'");
    expect(sql).toContain("jsonb_array_length(legacy.active_type_ids) = 0");
    expect(sql).toContain("THEN false");
  });

  it("backfills immutable invoice-line and product taxability", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0053_invoice_line_taxability",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0053_invoice_line_taxability.sql",
    );
    expect(sql).toContain(
      'ALTER TABLE "products" ADD COLUMN "taxable" boolean',
    );
    expect(sql).toContain(
      'UPDATE "products" SET "taxable" = true WHERE "taxable" IS NULL',
    );
    expect(sql).toContain(
      'ALTER TABLE "invoice_items" ADD COLUMN "taxable" boolean',
    );
    expect(sql).toContain(
      'UPDATE "invoice_items" SET "taxable" = true WHERE "taxable" IS NULL',
    );
    expect(sql.match(/ALTER COLUMN "taxable" SET NOT NULL/g)).toHaveLength(2);
  });

  it("adds an immutable tenant-scoped SMS consent evidence ledger", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0055_flippant_silver_fox",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0055_flippant_silver_fox.sql",
    );
    expect(sql).toContain('CREATE TABLE "sms_consent_events"');
    expect(sql).toContain("sms_consent_events_client_tenant_fk");
    expect(sql).toContain("sms_consent_events_location_tenant_fk");
    expect(sql).toContain("sms_consent_events_actor_tenant_fk");
    expect(
      sql.indexOf('CREATE UNIQUE INDEX "locations_practice_id_uq"'),
    ).toBeLessThan(sql.indexOf("sms_consent_events_location_tenant_fk"));
    expect(sql).toContain("sms_consent_events_practice_event_key_uq");
    expect(sql).toContain("sms_consent_events_provider_message_uq");
    expect(sql).toContain('"provider_message_id" varchar(255)');
    expect(sql).toContain("sms_consent_events_destination_check");
    expect(sql).toContain("sms_consent_events_evidence_shape_check");
    expect(sql).toContain("sms_consent_events_actor_shape_check");
    expect(sql).toContain(
      "\"sms_consent_events\".\"provider\" in ('telnyx', 'twilio')",
    );
    expect(sql).toContain(
      'coalesce("sms_consent_events"."provider_message_id", \'\')',
    );
    expect(sql).toContain("AND c.sms_consent = true");
    expect(sql).toContain("c.sms_consent_at IS NOT NULL");
    expect(sql).toContain("split_part(c.sms_consent_source, ':', 2)");
    expect(sql).toContain("WITH consent_candidates AS MATERIALIZED");
    expect(sql).toContain("'[^0-9]'");
    expect(sql).not.toContain("'\\\\D'");
    expect(sql).toContain("normalized_destination ~ '^\\+[1-9][0-9]{7,14}$'");
    expect(sql).toContain("UPDATE clients c");
    expect(sql).toContain("AND NOT EXISTS (");
    expect(sql).not.toContain("WHERE c.sms_consent = false");
    expect(sql).toContain("sms_consent_events_immutable");
    expect(sql).toContain("app.ledger_maintenance");
    expect(sql).toContain(
      "ALTER TABLE sms_consent_events ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON sms_consent_events TO openpims_app",
    );
    expect(sql).toContain("REVOKE ALL ON sms_consent_events FROM anon");
    expect(sql).toContain(
      "REVOKE ALL ON sms_consent_events FROM authenticated",
    );
  });

  it("adds canonical conversion projections without inventing payment dates", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0056_lively_magdalene",
    );

    const sql = readRepoFile("packages/db/drizzle/0056_lively_magdalene.sql");
    expect(sql).toContain('CREATE TABLE "practice_conversion_milestones"');
    expect(sql).toContain("practice_conversion_milestones_payment_shape_check");
    expect(sql).toContain(
      '"practice_conversion_milestones"."amount_cents" is not null',
    );
    expect(sql).toContain(
      '"practice_conversion_milestones"."currency" is not null',
    );
    expect(sql).toContain(
      "practice_conversion_milestones_evidence_source_check",
    );
    expect(sql).toContain("stripe_events_conversion_evidence_shape_check");
    expect(sql).toContain('"stripe_events"."amount_cents" is not null');
    expect(sql).toContain('length(btrim("stripe_events"."object_id")) > 0');
    expect(sql).toContain("p.created_at");
    expect(sql).toContain("greatest(p.created_at, c.created_at, a.created_at)");
    expect(sql).toContain("p.settings -> 'demoData' -> 'clientIds'");
    expect(sql).toContain("p.settings -> 'demoData' -> 'appointmentIds'");
    expect(sql).not.toContain("FROM funnel_events");
    expect(sql).not.toContain("p.billing_status = 'active'");
    expect(sql).toContain(
      "ALTER TABLE practice_conversion_milestones ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "REVOKE ALL ON practice_conversion_milestones, stripe_events FROM anon",
    );
    expect(sql).toContain(
      "REVOKE ALL ON practice_conversion_milestones, stripe_events",
    );
  });

  it("creates the append-only SMS delivery ledger with valid self-FK ordering", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0058_mysterious_black_cat",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0058_mysterious_black_cat.sql",
    );
    const referencedUniqueAt = sql.indexOf(
      'CREATE UNIQUE INDEX "sms_delivery_event_history_event_id_uq"',
    );
    const reviewedHistoryFkAt = sql.indexOf(
      'ADD CONSTRAINT "sms_delivery_event_history_reviewed_history_fk"',
    );
    expect(referencedUniqueAt).toBeGreaterThan(0);
    expect(reviewedHistoryFkAt).toBeGreaterThan(referencedUniqueAt);
    expect(sql).toContain('"reviewed_history_id" uuid');
    expect(sql).toContain("sms_delivery_event_history_reviewed_history_uq");
    expect(sql).toContain("sms_delivery_events_immutable");
    expect(sql).toContain("sms_delivery_event_history_immutable");
    expect(sql).toContain(
      "ALTER TABLE sms_delivery_events ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON sms_delivery_events, sms_delivery_event_history TO openpims_app",
    );
  });

  it("creates lab tenant uniqueness before the event ledger references it", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0059_daffy_darkstar",
    );

    const sql = readRepoFile("packages/db/drizzle/0059_daffy_darkstar.sql");
    const referencedUniqueAt = sql.indexOf(
      'CREATE UNIQUE INDEX "lab_results_practice_record_uq"',
    );
    const resultTenantFkAt = sql.indexOf(
      'ADD CONSTRAINT "lab_result_events_result_tenant_fk"',
    );
    expect(referencedUniqueAt).toBeGreaterThan(0);
    expect(resultTenantFkAt).toBeGreaterThan(referencedUniqueAt);
  });

  it("creates exact, immutable lab correction and replacement evidence", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0060_warm_rawhide_kid",
    );

    const sql = readRepoFile("packages/db/drizzle/0060_warm_rawhide_kid.sql");
    const correctionSourceUniqueAt = sql.indexOf(
      'CREATE UNIQUE INDEX "clinical_record_corrections_practice_record_lab_source_uq"',
    );
    const exactCorrectionFkAt = sql.indexOf(
      'ADD CONSTRAINT "lab_result_replacements_correction_source_tenant_fk"',
    );
    expect(correctionSourceUniqueAt).toBeGreaterThan(0);
    expect(exactCorrectionFkAt).toBeGreaterThan(correctionSourceUniqueAt);
    expect(sql).not.toContain("ADD VALUE 'lab_result'");
    expect(sql).toContain(
      'ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old"',
    );
    expect(sql).toContain(
      'CREATE TYPE "public"."clinical_correction_record_type" AS ENUM',
    );
    expect(sql).toContain(
      'USING "record_type"::text::"public"."clinical_correction_record_type"',
    );
    expect(sql).toContain("ELSIF NEW.record_type = 'lab_result' THEN");
    expect(sql).toContain("FROM public.lab_results source");
    expect(sql).toContain('CREATE TABLE "lab_result_replacements"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "lab_result_replacements_source_uq"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "lab_result_replacements_replacement_uq"',
    );
    expect(sql).toContain(
      "pg_catalog.hashtextextended('lab-result-replacement-graph:' || NEW.practice_id::text, 0)",
    );
    expect(sql).toContain("WITH RECURSIVE descendants(id) AS");
    expect(sql).toContain(
      "Lab result replacement lineage cannot contain a cycle.",
    );
    expect(sql).toContain("Lab result replacement evidence is append-only");
    expect(sql).toContain("current_setting('app.ledger_maintenance', true)");
    expect(sql).toContain("current_user = (");
    expect(sql).toContain(
      'ALTER TABLE "lab_result_replacements" ENABLE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON lab_result_replacements TO openpims_app",
    );
    expect(sql).toContain(
      "REVOKE ALL ON lab_result_replacements FROM authenticated",
    );
  });

  it("creates system-only verification email attempts and immutable delivery evidence", () => {
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0062_ambitious_moon_knight",
    );

    const sql = readRepoFile(
      "packages/db/drizzle/0062_ambitious_moon_knight.sql",
    );
    expect(sql).toContain('CREATE TABLE "auth_email_attempts"');
    expect(sql).toContain('CREATE TABLE "auth_email_delivery_events"');
    expect(sql).toContain('CREATE TABLE "auth_email_webhook_conflicts"');
    expect(sql).toContain(
      'CREATE TABLE "auth_email_provider_identity_conflicts"',
    );
    expect(sql).toContain("auth_email_attempts_outcome_shape_check");
    expect(sql).toContain("auth_email_attempts_state_guard");
    expect(sql).toContain("guard_auth_email_attempt_mutation");
    expect(sql).toContain("Auth email attempt identity is immutable");
    expect(sql).toContain(
      "Auth email attempt state transition is not permitted",
    );
    expect(sql).toContain("OLD.outcome = 'outcome_unknown'");
    expect(sql).toContain("NEW.outcome = 'accepted'");
    expect(sql).toContain(
      "Auth email attempts may only be deleted during owner maintenance",
    );
    expect(sql).toContain("\"provider\" in ('resend', 'console')");
    expect(sql).toContain("auth_email_delivery_events_attribution_shape_check");
    expect(sql).toContain(
      "auth_email_delivery_events_raw_body_fingerprint_check",
    );
    expect(sql).toContain('"raw_body_fingerprint" varchar(64) NOT NULL');
    expect(sql).toContain("'^[0-9a-f]{64}$'");
    expect(sql).toContain("auth_email_delivery_events_immutable");
    expect(sql).toContain("auth_email_webhook_conflicts_identity_uq");
    expect(sql.indexOf("auth_email_delivery_events_webhook_uq")).toBeLessThan(
      sql.indexOf("auth_email_webhook_conflicts_webhook_fk"),
    );
    expect(sql).toContain("auth_email_webhook_conflicts_immutable");
    expect(sql).toContain("auth_email_provider_identity_conflicts_immutable");
    expect(sql).toContain(
      "auth_email_provider_identity_conflicts_distinct_id_check",
    );
    expect(sql).toContain(
      "auth_email_provider_identity_conflicts_id_shape_check",
    );
    expect(sql).toContain(
      "auth_email_webhook_conflicts_raw_body_fingerprint_check",
    );
    expect(sql).toContain(
      "ALTER TABLE auth_email_attempts ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "ALTER TABLE auth_email_delivery_events ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "ALTER TABLE auth_email_webhook_conflicts ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "ALTER TABLE auth_email_provider_identity_conflicts ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE ON auth_email_attempts TO openpims_app",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts TO openpims_app",
    );
    expect(sql).not.toMatch(
      /recipient|verify_url|auth_token|subject|html|\bto\b varchar/i,
    );

    const reset = readRepoFile("packages/db/reset.ts");
    expect(reset).toContain('"auth_email_delivery_events"');
    expect(reset).toContain('"auth_email_webhook_conflicts"');
    expect(reset).toContain('"auth_email_provider_identity_conflicts"');
    expect(reset).toContain('"auth_email_attempts"');
    expect(reset.indexOf('"auth_email_webhook_conflicts"')).toBeLessThan(
      reset.indexOf('"auth_email_delivery_events"'),
    );
    expect(reset.indexOf('"auth_email_delivery_events"')).toBeLessThan(
      reset.indexOf('"auth_email_attempts"'),
    );

    const rls = readRepoFile("packages/db/rls/enable-rls.sql");
    expect(rls).toContain("CREATE POLICY system_only ON auth_email_attempts");
    expect(rls).toContain(
      "CREATE POLICY system_only ON auth_email_delivery_events",
    );
    expect(rls).toContain(
      "CREATE POLICY system_only ON auth_email_webhook_conflicts",
    );
    expect(rls).toContain(
      "CREATE POLICY system_only ON auth_email_provider_identity_conflicts",
    );
    expect(rls).toContain(
      "REVOKE ALL ON auth_email_attempts, auth_email_delivery_events, auth_email_webhook_conflicts, auth_email_provider_identity_conflicts FROM openpims_app",
    );
  });
});
