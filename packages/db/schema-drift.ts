import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as schema from "./schema/index";

/**
 * Schema drift detection.
 *
 * The app's Drizzle schema is the source of truth for what the running code
 * expects. When a deploy ships a schema change whose migration was never
 * applied, the code keeps querying a column the database does not have and the
 * failure only surfaces as a 500 on whichever page happens to touch it — which
 * is how "column prescriptions.product_id does not exist" reached a customer
 * instead of an alert.
 *
 * This compares what the schema *declares* against what the database *has*, so
 * any environment running ahead of its database reports unhealthy immediately
 * rather than silently erroring one feature at a time.
 *
 * Deliberately one-directional: extra tables/columns in the database are not
 * drift. Rolling deploys and expand-then-contract migrations both leave columns
 * behind on purpose, and flagging them would make the check cry wolf.
 */

export type DeclaredColumn = {
  table: string;
  column: string;
};

export type SchemaDrift = {
  missingTables: string[];
  missingColumns: DeclaredColumn[];
  invalidObjects: DeclaredDatabaseObject[];
};

export type DeclaredDatabaseObject = {
  kind:
    | "constraint"
    | "index"
    | "trigger"
    | "rls_policy"
    | "table_privilege"
    | "forbidden_table_privilege"
    | "forbidden_function_privilege";
  table: string;
  name: string;
};

/**
 * Release-critical database controls that cannot be inferred from the mere
 * presence of a table or column. Keep this deliberately narrow: these are the
 * controls whose absence would let the attachment recovery worker cross a
 * tenant boundary, accept unverifiable recovery evidence, or expose its
 * operational state to a clinic session.
 *
 * A constraint that exists but remains NOT VALID and an index that exists but
 * is not valid/ready both count as drift. This makes the application release
 * wait for the separate validation gate instead of treating a staged schema as
 * fully ready.
 */
export function criticalDatabaseContract(): DeclaredDatabaseObject[] {
  const objects: DeclaredDatabaseObject[] = [
    {
      kind: "constraint",
      table: "practices",
      name: "practices_recovery_hold_evidence_check",
    },
    {
      kind: "constraint",
      table: "clients",
      name: "clients_portal_access_token_state_check",
    },
    {
      kind: "constraint",
      table: "portal_sessions",
      name: "portal_sessions_client_tenant_fk",
    },
    {
      kind: "index",
      table: "portal_sessions",
      name: "portal_sessions_token_hash_uq",
    },
    {
      kind: "index",
      table: "portal_sessions",
      name: "portal_sessions_client_active_idx",
    },
    {
      kind: "index",
      table: "portal_sessions",
      name: "portal_sessions_expiry_idx",
    },
    {
      kind: "rls_policy",
      table: "portal_sessions",
      name: "tenant_isolation",
    },
    { kind: "constraint", table: "files", name: "files_uploader_tenant_fk" },
    { kind: "constraint", table: "files", name: "files_patient_tenant_fk" },
    {
      kind: "constraint",
      table: "files",
      name: "files_appointment_patient_tenant_fk",
    },
    {
      kind: "constraint",
      table: "files",
      name: "files_available_evidence_check",
    },
    {
      kind: "constraint",
      table: "files",
      name: "files_primary_namespace_check",
    },
    {
      kind: "constraint",
      table: "files",
      name: "files_category_required_check",
    },
    {
      kind: "constraint",
      table: "files",
      name: "files_patient_entity_consistency_check",
    },
    {
      kind: "constraint",
      table: "files",
      name: "files_appointment_requires_patient_check",
    },
    {
      kind: "constraint",
      table: "file_object_replicas",
      name: "file_object_replicas_file_tenant_fk",
    },
    {
      kind: "constraint",
      table: "file_object_replicas",
      name: "file_object_replicas_available_evidence_check",
    },
    {
      kind: "constraint",
      table: "file_object_replicas",
      name: "file_object_replicas_independent_object_key_check",
    },
    {
      kind: "constraint",
      table: "file_object_replicas",
      name: "file_object_replicas_lease_coherence_check",
    },
    {
      kind: "constraint",
      table: "file_storage_events",
      name: "file_storage_events_file_tenant_fk",
    },
    {
      kind: "constraint",
      table: "capture_sessions",
      name: "capture_sessions_patient_tenant_fk",
    },
    {
      kind: "constraint",
      table: "capture_sessions",
      name: "capture_sessions_creator_tenant_fk",
    },
    {
      kind: "constraint",
      table: "capture_sessions",
      name: "capture_sessions_appointment_patient_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_patient_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_creator_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_appointment_patient_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_form_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_file_tenant_fk",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_status_check",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_signing_evidence_check",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_signature_evidence_pair_check",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_signature_evidence_size_check",
    },
    {
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_signature_evidence_hash_check",
    },
    ...[
      "consent_requests_credential_storage_check",
      "consent_requests_token_hash_format_check",
      "consent_requests_document_render_version_check",
      "consent_requests_storage_lease_pair_check",
      "consent_requests_storage_lease_state_check",
      "consent_requests_signature_method_check",
      "consent_requests_signed_file_binding_check",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "consent_requests",
      name,
    })),
    ...[
      "consent_requests_evidence_guard",
      "consent_requests_signed_file_binding_guard",
    ].map((name) => ({
      kind: "trigger" as const,
      table: "consent_requests",
      name,
    })),
    {
      kind: "trigger" as const,
      table: "files",
      name: "consent_signature_files_guard",
    },
    {
      kind: "trigger" as const,
      table: "files",
      name: "consent_files_signed_binding_guard",
    },
    ...[
      "consent_receipt_capabilities_consent_tenant_fk",
      "consent_receipt_capabilities_file_tenant_fk",
      "consent_receipt_capabilities_token_hash_check",
      "consent_receipt_capabilities_checksum_check",
      "consent_receipt_capabilities_file_size_check",
      "consent_receipt_capabilities_expiry_check",
      "consent_receipt_capabilities_claims_check",
      "consent_receipt_capabilities_claim_evidence_check",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "consent_receipt_capabilities",
      name,
    })),
    ...[
      "consent_receipt_capabilities_token_hash_uq",
      "consent_receipt_capabilities_consent_uq",
      "consent_receipt_capabilities_practice_expiry_idx",
    ].map((name) => ({
      kind: "index" as const,
      table: "consent_receipt_capabilities",
      name,
    })),
    {
      kind: "trigger",
      table: "consent_receipt_capabilities",
      name: "consent_receipt_capabilities_guard",
    },
    {
      kind: "rls_policy",
      table: "consent_receipt_capabilities",
      name: "tenant_isolation",
    },
    ...["SELECT", "INSERT", "UPDATE"].map((name) => ({
      kind: "table_privilege" as const,
      table: "consent_receipt_capabilities",
      name,
    })),
    {
      kind: "forbidden_table_privilege",
      table: "consent_receipt_capabilities",
      name: "DELETE",
    },
    {
      kind: "forbidden_function_privilege",
      table: "protect_consent_receipt_capability",
      name: "EXECUTE",
    },
    {
      kind: "forbidden_function_privilege",
      table: "resolve_consent_document_render_version",
      name: "EXECUTE",
    },
    {
      kind: "forbidden_function_privilege",
      table: "restore_signed_consent_evidence",
      name: "EXECUTE",
    },
    {
      kind: "index",
      table: "files",
      name: "files_practice_file_key_uq",
    },
    {
      kind: "index",
      table: "files",
      name: "files_practice_idempotency_key_uq",
    },
    {
      kind: "index",
      table: "file_object_replicas",
      name: "file_object_replicas_due_idx",
    },
    {
      kind: "index",
      table: "file_storage_events",
      name: "file_storage_events_event_key_uq",
    },
    {
      kind: "index",
      table: "consent_forms",
      name: "consent_forms_practice_id_uq",
    },
    { kind: "rls_policy", table: "files", name: "tenant_isolation" },
    {
      kind: "rls_policy",
      table: "capture_sessions",
      name: "tenant_isolation",
    },
    {
      kind: "rls_policy",
      table: "consent_requests",
      name: "tenant_isolation",
    },
    {
      kind: "rls_policy",
      table: "file_object_replicas",
      name: "system_only",
    },
    {
      kind: "rls_policy",
      table: "file_storage_events",
      name: "system_read",
    },
    {
      kind: "rls_policy",
      table: "file_storage_events",
      name: "system_insert",
    },
    ...["SELECT", "INSERT", "UPDATE", "DELETE"].map((name) => ({
      kind: "table_privilege" as const,
      table: "file_object_replicas",
      name,
    })),
    ...["SELECT", "INSERT"].map((name) => ({
      kind: "table_privilege" as const,
      table: "file_storage_events",
      name,
    })),
    ...["UPDATE", "DELETE"].map((name) => ({
      kind: "forbidden_table_privilege" as const,
      table: "file_storage_events",
      name,
    })),
    ...["financial_closes_actor_tenant_fk"].map((name) => ({
      kind: "constraint" as const,
      table: "financial_closes",
      name,
    })),
    ...["payment_disputes_settlement_tenant_fk"].map((name) => ({
      kind: "constraint" as const,
      table: "payment_disputes",
      name,
    })),
    ...["payment_processor_payouts_account_tenant_fk"].map((name) => ({
      kind: "constraint" as const,
      table: "payment_processor_payouts",
      name,
    })),
    ...[
      "payment_processor_refunds_settlement_payment_tenant_fk",
      "payment_processor_refunds_account_tenant_fk",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "payment_processor_refunds",
      name,
    })),
    ...[
      "payment_processor_settlements_invoice_tenant_fk",
      "payment_processor_settlements_payment_invoice_fk",
      "payment_processor_settlements_account_tenant_fk",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "payment_processor_settlements",
      name,
    })),
    ...[
      ["invoices", "invoices_practice_id_uq"],
      ["payments", "payments_invoice_id_uq"],
      [
        "practice_payment_accounts",
        "practice_payment_accounts_tenant_provider_account_uq",
      ],
      [
        "payment_processor_settlements",
        "payment_processor_settlements_practice_id_uq",
      ],
      [
        "payment_processor_settlements",
        "payment_processor_settlements_tenant_payment_uq",
      ],
    ].map(([table, name]) => ({
      kind: "index" as const,
      table,
      name,
    })),
    {
      kind: "trigger",
      table: "payment_processor_refunds",
      name: "payment_processor_refunds_tenant_guard",
    },
    ...[
      "financial_closes",
      "payment_disputes",
      "payment_processor_payouts",
      "payment_processor_refunds",
      "payment_processor_settlements",
    ].map((table) => ({
      kind: "rls_policy" as const,
      table,
      name: "tenant_isolation",
    })),
    ...[
      "payment_disputes",
      "payment_processor_payouts",
      "payment_processor_refunds",
      "payment_processor_settlements",
    ].flatMap((table) =>
      ["SELECT", "INSERT", "UPDATE"].map((name) => ({
        kind: "table_privilege" as const,
        table,
        name,
      })),
    ),
    ...[
      "payment_disputes",
      "payment_processor_payouts",
      "payment_processor_refunds",
      "payment_processor_settlements",
    ].map((table) => ({
      kind: "forbidden_table_privilege" as const,
      table,
      name: "DELETE",
    })),
    ...["SELECT", "INSERT"].map((name) => ({
      kind: "table_privilege" as const,
      table: "financial_closes",
      name,
    })),
    ...["UPDATE", "DELETE"].map((name) => ({
      kind: "forbidden_table_privilege" as const,
      table: "financial_closes",
      name,
    })),
    {
      kind: "forbidden_function_privilege",
      table: "validate_payment_processor_refund_tenant",
      name: "EXECUTE",
    },
    {
      kind: "constraint",
      table: "sms_provider_events",
      name: "sms_provider_events_location_tenant_fk",
    },
    {
      kind: "constraint",
      table: "sms_provider_events",
      name: "sms_provider_events_kind_shape_check",
    },
    {
      kind: "constraint",
      table: "sms_provider_events",
      name: "sms_provider_events_state_shape_check",
    },
    {
      kind: "index",
      table: "sms_provider_events",
      name: "sms_provider_events_provider_event_key_uq",
    },
    {
      kind: "index",
      table: "sms_provider_events",
      name: "sms_provider_events_due_idx",
    },
    {
      kind: "index",
      table: "sms_provider_events",
      name: "sms_provider_events_consent_order_idx",
    },
    {
      kind: "trigger",
      table: "sms_provider_events",
      name: "sms_provider_events_mutation_guard",
    },
    {
      kind: "rls_policy",
      table: "sms_provider_events",
      name: "system_only",
    },
    ...["SELECT", "INSERT", "UPDATE"].map((name) => ({
      kind: "table_privilege" as const,
      table: "sms_provider_events",
      name,
    })),
    {
      kind: "forbidden_table_privilege",
      table: "sms_provider_events",
      name: "DELETE",
    },
    {
      kind: "constraint",
      table: "sms_provider_event_conflicts",
      name: "sms_provider_event_conflicts_shape_check",
    },
    {
      kind: "index",
      table: "sms_provider_event_conflicts",
      name: "sms_provider_event_conflicts_identity_uq",
    },
    {
      kind: "trigger",
      table: "sms_provider_event_conflicts",
      name: "sms_provider_event_conflicts_immutable",
    },
    {
      kind: "rls_policy",
      table: "sms_provider_event_conflicts",
      name: "system_only",
    },
    ...["SELECT", "INSERT"].map((name) => ({
      kind: "table_privilege" as const,
      table: "sms_provider_event_conflicts",
      name,
    })),
    ...["UPDATE", "DELETE"].map((name) => ({
      kind: "forbidden_table_privilege" as const,
      table: "sms_provider_event_conflicts",
      name,
    })),
    {
      kind: "constraint",
      table: "sms_provider_event_conflict_reviews",
      name: "sms_provider_event_conflict_reviews_shape_check",
    },
    {
      kind: "index",
      table: "sms_provider_event_conflict_reviews",
      name: "sms_provider_event_conflict_reviews_conflict_uq",
    },
    {
      kind: "index",
      table: "sms_provider_event_conflict_reviews",
      name: "sms_provider_event_conflict_reviews_operation_uq",
    },
    {
      kind: "trigger",
      table: "sms_provider_event_conflict_reviews",
      name: "sms_provider_event_conflict_reviews_immutable",
    },
    {
      kind: "rls_policy",
      table: "sms_provider_event_conflict_reviews",
      name: "system_only",
    },
    ...["SELECT", "INSERT"].map((name) => ({
      kind: "table_privilege" as const,
      table: "sms_provider_event_conflict_reviews",
      name,
    })),
    ...["UPDATE", "DELETE"].map((name) => ({
      kind: "forbidden_table_privilege" as const,
      table: "sms_provider_event_conflict_reviews",
      name,
    })),
    {
      kind: "constraint",
      table: "sms_provider_event_resolutions",
      name: "sms_provider_event_resolutions_shape_check",
    },
    ...[
      "sms_provider_event_resolutions_event_id_sms_provider_events_id_",
      "sms_provider_event_resolutions_conflict_id_sms_provider_event_c",
      "sms_provider_event_resolutions_practice_id_practices_id_fk",
      "sms_provider_event_resolutions_inbound_communication_id_communi",
      "sms_provider_event_resolutions_sms_consent_event_id_sms_consent",
      "sms_provider_event_resolutions_sms_delivery_event_id_sms_delive",
      "sms_provider_event_resolutions_messaging_registration_event_id_",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "sms_provider_event_resolutions",
      name,
    })),
    ...[
      "sms_provider_event_resolutions_base_event_uq",
      "sms_provider_event_resolutions_event_idx",
      "sms_provider_event_resolutions_conflict_uq",
      "sms_provider_event_resolutions_operation_uq",
      "sms_provider_event_resolutions_communication_evidence_idx",
      "sms_provider_event_resolutions_consent_evidence_idx",
      "sms_provider_event_resolutions_delivery_evidence_idx",
      "sms_provider_event_resolutions_registration_evidence_idx",
    ].map((name) => ({
      kind: "index" as const,
      table: "sms_provider_event_resolutions",
      name,
    })),
    ...[
      "sms_provider_event_resolutions_validate_insert",
      "sms_provider_event_resolutions_immutable",
    ].map((name) => ({
      kind: "trigger" as const,
      table: "sms_provider_event_resolutions",
      name,
    })),
    {
      kind: "rls_policy",
      table: "sms_provider_event_resolutions",
      name: "system_only",
    },
    ...["SELECT", "INSERT"].map((name) => ({
      kind: "table_privilege" as const,
      table: "sms_provider_event_resolutions",
      name,
    })),
    ...["UPDATE", "DELETE"].map((name) => ({
      kind: "forbidden_table_privilege" as const,
      table: "sms_provider_event_resolutions",
      name,
    })),
    {
      kind: "forbidden_function_privilege",
      table: "validate_sms_provider_event_resolution_insert",
      name: "EXECUTE",
    },
    ...[
      "care_reminders_patient_tenant_fk",
      "care_reminders_creator_tenant_fk",
      "care_reminders_completer_tenant_fk",
      "care_reminders_dismisser_tenant_fk",
      "care_reminders_state_check",
      "care_reminders_dismissal_reason_check",
      "care_reminders_import_identity_check",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "care_reminders",
      name,
    })),
    ...[
      "care_reminders_external_id_uq",
      "care_reminders_import_fingerprint_uq",
      "care_reminders_open_due_idx",
    ].map((name) => ({
      kind: "index" as const,
      table: "care_reminders",
      name,
    })),
    {
      kind: "rls_policy",
      table: "care_reminders",
      name: "tenant_isolation",
    },
    ...[
      "vaccination_records_supervising_veterinarian_id_users_id_fk",
      "vaccination_records_supervisor_practice_fk",
      "vaccination_records_licensed_duration_check",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "vaccination_records",
      name,
    })),
    ...[
      "services_import_identity_check",
      "services_import_fingerprint_check",
      "services_external_source_check",
    ].map((name) => ({
      kind: "constraint" as const,
      table: "services",
      name,
    })),
    ...["services_external_id_uq", "services_import_fingerprint_uq"].map(
      (name) => ({
        kind: "index" as const,
        table: "services",
        name,
      }),
    ),
    ...[
      "client_contacts",
      "historical_appointments",
      "external_prescriptions",
      "external_prescription_fills",
      "external_lab_reports",
      "external_lab_observations",
      "legacy_financial_documents",
      "legacy_financial_line_items",
      "legacy_financial_payments",
      "legacy_financial_allocations",
      "historical_documents",
    ].map((table) => ({
      kind: "rls_policy" as const,
      table,
      name: "tenant_isolation",
    })),
    ...[
      ["client_contacts", "client_contacts_client_tenant_fk"],
      ["historical_appointments", "historical_appointments_patient_tenant_fk"],
      ["historical_appointments", "historical_appointments_client_tenant_fk"],
      ["external_prescriptions", "external_prescriptions_patient_tenant_fk"],
      [
        "external_prescription_fills",
        "external_prescription_fills_prescription_tenant_fk",
      ],
      ["external_lab_reports", "external_lab_reports_patient_tenant_fk"],
      [
        "external_lab_observations",
        "external_lab_observations_report_tenant_fk",
      ],
      [
        "legacy_financial_documents",
        "legacy_financial_documents_client_tenant_fk",
      ],
      [
        "legacy_financial_line_items",
        "legacy_financial_line_items_document_tenant_fk",
      ],
      [
        "legacy_financial_payments",
        "legacy_financial_payments_client_tenant_fk",
      ],
      [
        "legacy_financial_allocations",
        "legacy_financial_allocations_document_tenant_fk",
      ],
      [
        "legacy_financial_allocations",
        "legacy_financial_allocations_payment_tenant_fk",
      ],
      ["historical_documents", "historical_documents_file_tenant_fk"],
      ["historical_documents", "historical_documents_link_shape_check"],
      ["historical_documents", "historical_documents_kind_shape_check"],
    ].map(([table, name]) => ({
      kind: "constraint" as const,
      table,
      name,
    })),
    ...[
      ["client_contacts", "client_contacts_external_id_uq"],
      ["historical_appointments", "historical_appointments_external_id_uq"],
      ["external_prescriptions", "external_prescriptions_external_id_uq"],
      [
        "external_prescription_fills",
        "external_prescription_fills_external_id_uq",
      ],
      ["external_lab_reports", "external_lab_reports_external_id_uq"],
      ["external_lab_observations", "external_lab_observations_external_id_uq"],
      [
        "legacy_financial_documents",
        "legacy_financial_documents_external_id_uq",
      ],
      [
        "legacy_financial_line_items",
        "legacy_financial_line_items_external_id_uq",
      ],
      ["legacy_financial_payments", "legacy_financial_payments_external_id_uq"],
      [
        "legacy_financial_allocations",
        "legacy_financial_allocations_external_id_uq",
      ],
      ["historical_documents", "historical_documents_external_id_uq"],
      ["historical_documents", "historical_documents_file_uq"],
    ].map(([table, name]) => ({
      kind: "index" as const,
      table,
      name,
    })),
  ];

  return objects;
}

/** Every table the Drizzle schema declares, with its database column names. */
export function declaredSchema(): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTableClass)) continue;
    const config = getTableConfig(exported as PgTable);
    // Views and tables outside the default schema are managed elsewhere.
    if (config.schema && config.schema !== "public") continue;
    declared.set(
      config.name,
      new Set(config.columns.map((column) => column.name)),
    );
  }

  return declared;
}

type SchemaObjectRow = {
  object_type:
    | "column"
    | "constraint"
    | "index"
    | "trigger"
    | "rls_policy"
    | "table_privilege"
    | "forbidden_table_privilege"
    | "forbidden_function_privilege";
  table_name: string;
  object_name: string;
  healthy: boolean;
};

type Queryable = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

function toRows(result: unknown): SchemaObjectRow[] {
  // postgres-js returns the rows array directly; node-postgres wraps them in
  // { rows }. Support both so this works against the app client and a plain
  // script connection.
  if (Array.isArray(result)) return result as SchemaObjectRow[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as SchemaObjectRow[];
  }
  return [];
}

/**
 * Compare the declared schema against the live database.
 *
 * One introspection query, no per-table round trips, so this remains cheap
 * enough to run on a health check while also proving the critical constraints,
 * indexes, and RLS policies are present and active.
 */
export async function findSchemaDrift(db: Queryable): Promise<SchemaDrift> {
  const result = await db.execute(sql`
    select
      'column'::text as object_type,
      table_name::text,
      column_name::text as object_name,
      true as healthy
    from information_schema.columns
    where table_schema = 'public'
    union all
    select
      'constraint'::text,
      table_class.relname::text,
      constraint_object.conname::text,
      constraint_object.convalidated
    from pg_catalog.pg_constraint constraint_object
    join pg_catalog.pg_class table_class
      on table_class.oid = constraint_object.conrelid
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
    where table_namespace.nspname = 'public'
    union all
    select
      'index'::text,
      table_class.relname::text,
      index_class.relname::text,
      (index_state.indisvalid and index_state.indisready)
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class table_class
      on table_class.oid = index_state.indrelid
    join pg_catalog.pg_class index_class
      on index_class.oid = index_state.indexrelid
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
    where table_namespace.nspname = 'public'
    union all
    select
      'trigger'::text,
      table_class.relname::text,
      trigger_object.tgname::text,
      trigger_object.tgenabled <> 'D'
    from pg_catalog.pg_trigger trigger_object
    join pg_catalog.pg_class table_class
      on table_class.oid = trigger_object.tgrelid
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
    where table_namespace.nspname = 'public'
      and not trigger_object.tgisinternal
    union all
    select
      'rls_policy'::text,
      table_class.relname::text,
      policy_object.polname::text,
      table_class.relrowsecurity
    from pg_catalog.pg_policy policy_object
    join pg_catalog.pg_class table_class
      on table_class.oid = policy_object.polrelid
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
    where table_namespace.nspname = 'public'
    union all
    select
      'table_privilege'::text,
      table_name::text,
      privilege_type::text,
      true
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee = 'openpims_app'
    union all
    select
      'forbidden_table_privilege'::text,
      required_absence.table_name,
      required_absence.privilege_type,
      not has_table_privilege(
        'openpims_app',
        format('public.%I', required_absence.table_name),
        required_absence.privilege_type
      )
    from (values
      ('file_storage_events'::text, 'UPDATE'::text),
      ('file_storage_events'::text, 'DELETE'::text),
      ('sms_provider_events'::text, 'DELETE'::text),
      ('sms_provider_event_conflicts'::text, 'UPDATE'::text),
      ('sms_provider_event_conflicts'::text, 'DELETE'::text),
      ('sms_provider_event_conflict_reviews'::text, 'UPDATE'::text),
      ('sms_provider_event_conflict_reviews'::text, 'DELETE'::text),
      ('sms_provider_event_resolutions'::text, 'UPDATE'::text),
      ('sms_provider_event_resolutions'::text, 'DELETE'::text),
      ('payment_processor_settlements'::text, 'DELETE'::text),
      ('payment_processor_refunds'::text, 'DELETE'::text),
      ('payment_processor_payouts'::text, 'DELETE'::text),
      ('payment_disputes'::text, 'DELETE'::text),
      ('financial_closes'::text, 'UPDATE'::text),
      ('financial_closes'::text, 'DELETE'::text),
      ('consent_receipt_capabilities'::text, 'DELETE'::text)
    ) required_absence(table_name, privilege_type)
    union all
    select
      'forbidden_function_privilege'::text,
      function_object.proname::text,
      'EXECUTE'::text,
      not exists (
        select 1
        from aclexplode(
          coalesce(
            function_object.proacl,
            acldefault('f', function_object.proowner)
          )
        ) function_acl
        left join pg_catalog.pg_roles privilege_role
          on privilege_role.oid = function_acl.grantee
        where function_acl.privilege_type = 'EXECUTE'
          and (
            function_acl.grantee = 0
            or privilege_role.rolname in ('anon', 'authenticated', 'openpims_app')
          )
      )
    from pg_catalog.pg_proc function_object
    join pg_catalog.pg_namespace function_namespace
      on function_namespace.oid = function_object.pronamespace
    where function_namespace.nspname = 'public'
      and function_object.proname in (
        'validate_sms_provider_event_resolution_insert',
        'validate_payment_processor_refund_tenant',
        'protect_consent_receipt_capability',
        'resolve_consent_document_render_version',
        'restore_signed_consent_evidence'
      )
  `);

  const live = new Map<string, Set<string>>();
  for (const row of toRows(result)) {
    if (row.object_type !== "column") continue;
    const existing = live.get(row.table_name);
    if (existing) {
      existing.add(row.object_name);
    } else {
      live.set(row.table_name, new Set([row.object_name]));
    }
  }

  const missingTables: string[] = [];
  const missingColumns: DeclaredColumn[] = [];

  for (const [table, columns] of declaredSchema()) {
    const liveColumns = live.get(table);
    if (!liveColumns) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!liveColumns.has(column)) {
        missingColumns.push({ table, column });
      }
    }
  }

  missingTables.sort();
  missingColumns.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table),
  );

  const liveObjects = new Map<string, boolean>();
  for (const row of toRows(result)) {
    if (row.object_type === "column") continue;
    liveObjects.set(
      `${row.object_type}:${row.table_name}:${row.object_name}`,
      row.healthy,
    );
  }

  const invalidObjects = criticalDatabaseContract().filter(
    (object) =>
      liveObjects.get(`${object.kind}:${object.table}:${object.name}`) !== true,
  );

  return { missingTables, missingColumns, invalidObjects };
}

export function driftIsClean(drift: SchemaDrift): boolean {
  return (
    drift.missingTables.length === 0 &&
    drift.missingColumns.length === 0 &&
    drift.invalidObjects.length === 0
  );
}

/** Short operator-facing summary, e.g. "2 tables and 1 column missing". */
export function describeDrift(drift: SchemaDrift): string {
  if (driftIsClean(drift)) return "Database schema matches the deployed code";

  const parts: string[] = [];
  if (drift.missingTables.length > 0) {
    parts.push(
      `${drift.missingTables.length} table${
        drift.missingTables.length === 1 ? "" : "s"
      } missing (${drift.missingTables.slice(0, 5).join(", ")}${
        drift.missingTables.length > 5 ? ", …" : ""
      })`,
    );
  }
  if (drift.missingColumns.length > 0) {
    const shown = drift.missingColumns
      .slice(0, 5)
      .map((c) => `${c.table}.${c.column}`)
      .join(", ");
    parts.push(
      `${drift.missingColumns.length} column${
        drift.missingColumns.length === 1 ? "" : "s"
      } missing (${shown}${drift.missingColumns.length > 5 ? ", …" : ""})`,
    );
  }
  if (drift.invalidObjects.length > 0) {
    const shown = drift.invalidObjects
      .slice(0, 5)
      .map((object) => `${object.table}.${object.name}`)
      .join(", ");
    parts.push(
      `${drift.invalidObjects.length} critical database control${
        drift.invalidObjects.length === 1 ? "" : "s"
      } missing or invalid (${shown}${
        drift.invalidObjects.length > 5 ? ", …" : ""
      })`,
    );
  }
  return `Database is behind the deployed code: ${parts.join("; ")}`;
}
