import { config } from "dotenv";
config({ path: "../../.env" });
import { sql } from "drizzle-orm";
import { db } from "./client";

// Order doesn't matter with CASCADE, but we TRUNCATE every table the seed touches.
// RESTART IDENTITY resets any serial sequences (none in this schema, but cheap).
const TABLES = [
  // Core / leaf tables first (purely defensive — CASCADE handles it)
  "audit_log",
  "rate_limit_buckets",
  "stripe_events",
  "practice_conversion_milestones",
  "auth_email_webhook_conflicts",
  "auth_email_provider_identity_conflicts",
  "auth_email_delivery_events",
  "auth_email_attempts",
  "usage_records",
  "controlled_substance_log",
  "payments",
  "communications",
  "webhooks",
  "api_keys",
  "treatment_template_items",
  "treatment_templates",
  "sms_delivery_event_history",
  "sms_delivery_events",
  "sms_send_attempt_events",
  "sms_send_attempts",
  "sms_consent_events",
  "patient_merge_events",
  "dispense_charge_queue",
  "invoice_items",
  "invoices",
  "soap_note_replacements",
  "lab_result_replacements",
  "clinical_record_corrections",
  "lab_result_events",
  "lab_results",
  "procedures",
  "visit_closeouts",
  "prescription_events",
  "prescriptions",
  "vaccination_records",
  "soap_notes",
  "appointments",
  "rooms",
  "appointment_types",
  "patient_weights",
  "patient_allergies",
  "patients",
  "clients",
  "products",
  "services",
  "users",
  "locations",
  "practices",
];

async function reset() {
  console.log("Truncating all tables...");
  // Single statement — TRUNCATE ... CASCADE handles FK dependencies.
  const tableList = TABLES.join(", ");
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`),
  );
  console.log(`Truncated ${TABLES.length} tables`);
}

reset()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reset failed:", err);
    process.exit(1);
  });
