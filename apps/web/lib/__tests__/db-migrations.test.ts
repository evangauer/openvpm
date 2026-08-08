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
      'CREATE TYPE "public"."visit_follow_up_disposition" AS ENUM(\'none\', \'needed\', \'scheduled\')',
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
});
