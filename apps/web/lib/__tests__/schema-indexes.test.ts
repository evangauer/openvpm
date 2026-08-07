import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  apiKeys,
  appointmentTypes,
  appointmentWaitlist,
  appointments,
  authTokens,
  cases,
  caseEntries,
  clinicalNotes,
  communications,
  controlledSubstanceLog,
  emailSuppressions,
  invoices,
  invoiceItems,
  labResults,
  locationMessaging,
  messagingRegistrations,
  locations,
  patientAllergies,
  patientWeights,
  payments,
  practicePaymentAccounts,
  prescriptions,
  problemList,
  procedures,
  products,
  practices,
  rateLimitBuckets,
  rooms,
  services,
  soapNotes,
  staffSchedules,
  smsSuppressions,
  sessions,
  suppliers,
  treatmentPlanItems,
  users,
  vaccinationRecords,
  verificationTokens,
  vitalSigns,
  webhooks,
  wellnessEnrollments,
  wellnessPlans,
} from "@openpims/db";

function indexNames(table: PgTable): string[] {
  return getTableConfig(table).indexes
    .map((idx) => idx.config.name)
    .filter((name): name is string => typeof name === "string");
}

function indexColumnNames(table: PgTable, name: string): string[] {
  const index = getTableConfig(table).indexes.find(
    (idx) => idx.config.name === name
  );

  expect(index, `${name} should be registered`).toBeDefined();
  return index!.config.columns.map((column) => {
    const columnName = "name" in column ? column.name : undefined;
    if (typeof columnName !== "string") {
      throw new Error(`${name} should use named table columns`);
    }

    return columnName;
  });
}

describe("hot table indexes", () => {
  it.each([
    [
      "communications",
      communications,
      [
        "communications_practice_list_idx",
        "communications_client_timeline_idx",
        "communications_inbox_status_idx",
        "communications_assigned_idx",
      ],
    ],
    [
      "controlled_substance_log",
      controlledSubstanceLog,
      ["cs_log_practice_drug_date_idx", "cs_log_practice_date_idx"],
    ],
    [
      "webhooks",
      webhooks,
      ["webhooks_practice_active_idx"],
    ],
    [
      "email_suppressions",
      emailSuppressions,
      [
        "email_suppressions_practice_email_uq",
        "email_suppressions_practice_idx",
      ],
    ],
    [
      "sms_suppressions",
      smsSuppressions,
      ["sms_suppressions_practice_phone_uq", "sms_suppressions_practice_idx"],
    ],
    [
      "api_keys",
      apiKeys,
      ["api_keys_prefix_idx", "api_keys_practice_created_idx"],
    ],
    [
      "vaccination_records",
      vaccinationRecords,
      [
        "vaccination_records_patient_idx",
        "vaccination_records_practice_due_idx",
      ],
    ],
    [
      "lab_results",
      labResults,
      ["lab_results_patient_idx", "lab_results_practice_status_idx"],
    ],
    [
      "patient_weights",
      patientWeights,
      ["patient_weights_patient_recorded_idx"],
    ],
    [
      "vital_signs",
      vitalSigns,
      ["vital_signs_patient_idx", "vital_signs_practice_idx"],
    ],
    [
      "patient_allergies",
      patientAllergies,
      ["patient_allergies_patient_idx"],
    ],
    [
      "procedures",
      procedures,
      ["procedures_patient_idx", "procedures_practice_idx"],
    ],
    [
      "soap_notes",
      soapNotes,
      ["soap_notes_patient_idx", "soap_notes_practice_idx"],
    ],
    [
      "clinical_notes",
      clinicalNotes,
      ["clinical_notes_patient_idx", "clinical_notes_practice_idx"],
    ],
    [
      "problem_list",
      problemList,
      ["problem_list_patient_status_idx", "problem_list_practice_status_idx"],
    ],
    [
      "cases",
      cases,
      ["cases_patient_status_idx", "cases_practice_status_idx"],
    ],
    [
      "case_entries",
      caseEntries,
      ["case_entries_case_idx"],
    ],
    [
      "treatment_plan_items",
      treatmentPlanItems,
      ["treatment_plan_items_plan_order_idx"],
    ],
    [
      "users",
      users,
      ["users_practice_idx", "users_location_idx", "users_role_idx"],
    ],
    [
      "locations",
      locations,
      ["locations_practice_idx", "locations_primary_idx"],
    ],
    [
      "location_messaging",
      locationMessaging,
      ["location_messaging_practice_idx", "location_messaging_sender_idx"],
    ],
    [
      "messaging_registrations",
      messagingRegistrations,
      [
        "messaging_registrations_practice_idx",
        "messaging_registrations_status_idx",
        "messaging_registrations_attested_by_idx",
      ],
    ],
    [
      "appointment_types",
      appointmentTypes,
      ["appointment_types_practice_name_idx"],
    ],
    [
      "appointments",
      appointments,
      [
        "appointments_practice_time_idx",
        "appointments_client_status_idx",
        "appointments_patient_status_idx",
        "appointments_doctor_status_idx",
        "appointments_type_status_idx",
        "appointments_room_status_idx",
      ],
    ],
    [
      "appointment_waitlist",
      appointmentWaitlist,
      [
        "waitlist_practice_idx",
        "waitlist_client_status_idx",
        "waitlist_patient_status_idx",
      ],
    ],
    [
      "rooms",
      rooms,
      ["rooms_practice_name_idx", "rooms_location_idx"],
    ],
    [
      "staff_schedules",
      staffSchedules,
      ["staff_schedules_location_idx", "staff_schedules_user_idx"],
    ],
    [
      "products",
      products,
      [
        "products_practice_idx",
        "products_practice_name_idx",
        "products_location_idx",
        "products_sku_idx",
        "products_expiration_idx",
        "products_stock_alert_idx",
      ],
    ],
    [
      "services",
      services,
      ["services_practice_name_idx"],
    ],
    [
      "suppliers",
      suppliers,
      ["suppliers_practice_name_idx"],
    ],
    [
      "invoices",
      invoices,
      [
        "invoices_practice_idx",
        "invoices_client_idx",
        "invoices_patient_idx",
      ],
    ],
    [
      "invoice_items",
      invoiceItems,
      ["invoice_items_invoice_idx", "invoice_items_item_idx"],
    ],
    [
      "payments",
      payments,
      ["payments_invoice_idx", "payments_external_id_uq"],
    ],
    [
      "prescriptions",
      prescriptions,
      [
        "prescriptions_patient_status_idx",
        "prescriptions_practice_status_idx",
        "prescriptions_product_idx",
      ],
    ],
    [
      "wellness_enrollments",
      wellnessEnrollments,
      [
        "wellness_enrollments_practice_idx",
        "wellness_enrollments_due_idx",
        "wellness_enrollments_billing_due_idx",
        "wellness_enrollments_target_idx",
      ],
    ],
    [
      "wellness_plans",
      wellnessPlans,
      ["wellness_plans_practice_created_idx"],
    ],
    [
      "auth_tokens",
      authTokens,
      ["auth_tokens_hash_idx", "auth_tokens_expires_idx"],
    ],
    ["sessions", sessions, ["sessions_expires_idx"]],
    [
      "verification_tokens",
      verificationTokens,
      ["verification_tokens_expires_idx"],
    ],
    [
      "rate_limit_buckets",
      rateLimitBuckets,
      ["rate_limit_buckets_reset_at_idx"],
    ],
    [
      "practices",
      practices,
      [
        "practices_billing_trial_idx",
        "practices_stripe_customer_idx",
        "practices_stripe_subscription_idx",
      ],
    ],
    [
      "practice_payment_accounts",
      practicePaymentAccounts,
      [
        "practice_payment_accounts_practice_provider_uq",
        "practice_payment_accounts_stripe_account_uq",
        "practice_payment_accounts_status_idx",
      ],
    ],
  ])("registers %s indexes", (_tableName, table, expectedIndexes) => {
    expect(indexNames(table)).toEqual(expect.arrayContaining(expectedIndexes));
  });

  it("matches communications indexes to active inbox query shapes", () => {
    expect(
      indexColumnNames(communications, "communications_practice_list_idx")
    ).toEqual(["practice_id", "deleted_at", "created_at"]);
    expect(
      indexColumnNames(communications, "communications_client_timeline_idx")
    ).toEqual(["practice_id", "client_id", "deleted_at", "created_at"]);
    expect(
      indexColumnNames(communications, "communications_inbox_status_idx")
    ).toEqual(["practice_id", "direction", "status", "deleted_at"]);
    expect(
      indexColumnNames(communications, "communications_assigned_idx")
    ).toEqual(["practice_id", "assigned_to", "deleted_at"]);
    expect(
      indexColumnNames(communications, "communications_provider_message_idx")
    ).toEqual(["practice_id", "provider_message_id", "channel", "direction"]);
  });

  it("matches controlled-substance ledger indexes to list and summary query shapes", () => {
    expect(
      indexColumnNames(
        controlledSubstanceLog,
        "cs_log_practice_drug_date_idx"
      )
    ).toEqual(["practice_id", "drug_name", "performed_at"]);
    expect(
      indexColumnNames(controlledSubstanceLog, "cs_log_practice_date_idx")
    ).toEqual(["practice_id", "deleted_at", "performed_at"]);
  });

  it("matches email suppression indexes to send-gate and restore query shapes", () => {
    expect(
      indexColumnNames(emailSuppressions, "email_suppressions_practice_email_uq")
    ).toEqual(["practice_id", "email"]);
    expect(
      indexColumnNames(emailSuppressions, "email_suppressions_practice_idx")
    ).toEqual(["practice_id", "deleted_at"]);
  });

  it("matches SMS suppression indexes to send-gate and export query shapes", () => {
    expect(
      indexColumnNames(smsSuppressions, "sms_suppressions_practice_phone_uq")
    ).toEqual(["practice_id", "phone"]);
    expect(
      indexColumnNames(smsSuppressions, "sms_suppressions_practice_idx")
    ).toEqual(["practice_id", "deleted_at"]);
  });
});
