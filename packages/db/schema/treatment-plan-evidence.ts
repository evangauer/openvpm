import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { practices } from "./practices";
import { clients } from "./clients";
import { patients } from "./patients";
import { appointments } from "./scheduling";
import { users } from "./users";
import { products, services } from "./billing";
import { files } from "./files";
import { consentRequests } from "./consents";

export const visitTreatmentPlanStatusEnum = pgEnum(
  "visit_treatment_plan_status",
  ["open", "completed", "cancelled"],
);

export const visitTreatmentPlanItemTypeEnum = pgEnum(
  "visit_treatment_plan_item_type",
  ["service", "product"],
);

export const visitTreatmentPlanDecisionEnum = pgEnum(
  "visit_treatment_plan_decision",
  ["accepted", "declined"],
);

export type VisitTreatmentPlanPresentationDecision = {
  revisionLineId: string;
  decision: "accepted" | "declined";
  acceptedQuantity: string;
  declineReason: string | null;
};

/**
 * Visit-scoped client treatment-plan identity. This is deliberately separate
 * from the longitudinal clinical treatment_plans table and from invoices.
 * Immutable offered terms live in visitTreatmentPlanRevisions below.
 */
export const visitTreatmentPlans = pgTable(
  "visit_treatment_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    appointmentId: uuid("appointment_id"),
    createdBy: uuid("created_by").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    status: visitTreatmentPlanStatusEnum("status").notNull().default("open"),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("visit_treatment_plans_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceOperationUq: uniqueIndex(
      "visit_treatment_plans_practice_operation_uq",
    ).on(table.practiceId, table.operationId),
    patientHistoryIdx: index("visit_treatment_plans_patient_history_idx").on(
      table.practiceId,
      table.patientId,
      table.createdAt,
      table.id,
    ),
    appointmentIdx: index("visit_treatment_plans_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.createdAt,
    ),
    patientClientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId, table.clientId],
      foreignColumns: [patients.practiceId, patients.id, patients.clientId],
      name: "visit_treatment_plans_patient_client_tenant_fk",
    }),
    appointmentTenantFk: foreignKey({
      columns: [
        table.practiceId,
        table.appointmentId,
        table.patientId,
        table.clientId,
      ],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
        appointments.clientId,
      ],
      name: "visit_treatment_plans_appointment_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "visit_treatment_plans_creator_tenant_fk",
    }),
    titleCheck: check(
      "visit_treatment_plans_title_check",
      sql`length(btrim(${table.title})) between 1 and 255`,
    ),
    operationPayloadHashCheck: check(
      "visit_treatment_plans_operation_payload_hash_check",
      sql`${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

/**
 * A sealed, immutable set of offered terms. Revision lines are staged first
 * in the same transaction through a deferred FK; inserting this header
 * validates and seals the complete snapshot in PostgreSQL.
 */
export const visitTreatmentPlanRevisions = pgTable(
  "visit_treatment_plan_revisions",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id").notNull(),
    planId: uuid("plan_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    tax: numeric("tax", { precision: 12, scale: 2 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    authoredBy: uuid("authored_by").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
    contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
  },
  (table) => ({
    practicePlanIdUq: uniqueIndex(
      "visit_treatment_plan_revisions_practice_plan_id_uq",
    ).on(table.practiceId, table.id, table.planId),
    planRevisionUq: uniqueIndex(
      "visit_treatment_plan_revisions_plan_revision_uq",
    ).on(table.planId, table.revisionNumber),
    practiceOperationUq: uniqueIndex(
      "visit_treatment_plan_revisions_practice_operation_uq",
    ).on(table.practiceId, table.operationId),
    planHistoryIdx: index("visit_treatment_plan_revisions_plan_history_idx").on(
      table.practiceId,
      table.planId,
      table.revisionNumber,
    ),
    planTenantFk: foreignKey({
      columns: [table.practiceId, table.planId],
      foreignColumns: [visitTreatmentPlans.practiceId, visitTreatmentPlans.id],
      name: "visit_treatment_plan_revisions_plan_tenant_fk",
    }),
    authorTenantFk: foreignKey({
      columns: [table.practiceId, table.authoredBy],
      foreignColumns: [users.practiceId, users.id],
      name: "visit_treatment_plan_revisions_author_tenant_fk",
    }),
    revisionNumberCheck: check(
      "visit_treatment_plan_revisions_number_check",
      sql`${table.revisionNumber} >= 1`,
    ),
    currencyCheck: check(
      "visit_treatment_plan_revisions_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    totalsCheck: check(
      "visit_treatment_plan_revisions_totals_check",
      sql`${table.subtotal} >= 0 and ${table.tax} >= 0 and ${table.total} = ${table.subtotal} + ${table.tax}`,
    ),
    operationPayloadHashCheck: check(
      "visit_treatment_plan_revisions_operation_payload_hash_check",
      sql`${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    contentHashCheck: check(
      "visit_treatment_plan_revisions_content_hash_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const visitTreatmentPlanRevisionLines = pgTable(
  "visit_treatment_plan_revision_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id").notNull(),
    planId: uuid("plan_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    sortOrder: integer("sort_order").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    offeredQuantity: numeric("offered_quantity", {
      precision: 12,
      scale: 3,
    }).notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    lineSubtotal: numeric("line_subtotal", {
      precision: 12,
      scale: 2,
    }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    taxable: boolean("taxable").notNull(),
    itemType: visitTreatmentPlanItemTypeEnum("item_type").notNull(),
    serviceId: uuid("service_id"),
    productId: uuid("product_id"),
  },
  (table) => ({
    practiceRevisionIdUq: uniqueIndex(
      "visit_treatment_plan_revision_lines_practice_revision_id_uq",
    ).on(table.practiceId, table.id, table.revisionId),
    revisionOrderUq: uniqueIndex(
      "visit_treatment_plan_revision_lines_revision_order_uq",
    ).on(table.revisionId, table.sortOrder),
    revisionOrderIdx: index(
      "visit_treatment_plan_revision_lines_revision_order_idx",
    ).on(table.practiceId, table.revisionId, table.sortOrder),
    revisionTenantFk: foreignKey({
      columns: [table.practiceId, table.revisionId, table.planId],
      foreignColumns: [
        visitTreatmentPlanRevisions.practiceId,
        visitTreatmentPlanRevisions.id,
        visitTreatmentPlanRevisions.planId,
      ],
      name: "visit_treatment_plan_revision_lines_revision_tenant_fk",
    }),
    planTenantFk: foreignKey({
      columns: [table.practiceId, table.planId],
      foreignColumns: [visitTreatmentPlans.practiceId, visitTreatmentPlans.id],
      name: "visit_treatment_plan_revision_lines_plan_tenant_fk",
    }),
    serviceTenantFk: foreignKey({
      columns: [table.practiceId, table.serviceId],
      foreignColumns: [services.practiceId, services.id],
      name: "visit_treatment_plan_revision_lines_service_tenant_fk",
    }),
    productTenantFk: foreignKey({
      columns: [table.practiceId, table.productId],
      foreignColumns: [products.practiceId, products.id],
      name: "visit_treatment_plan_revision_lines_product_tenant_fk",
    }),
    sortOrderCheck: check(
      "visit_treatment_plan_revision_lines_sort_order_check",
      sql`${table.sortOrder} >= 0`,
    ),
    descriptionCheck: check(
      "visit_treatment_plan_revision_lines_description_check",
      sql`length(btrim(${table.description})) between 1 and 500`,
    ),
    moneyCheck: check(
      "visit_treatment_plan_revision_lines_money_check",
      sql`${table.offeredQuantity} > 0 and ${table.unitPrice} >= 0 and ${table.lineSubtotal} = round(${table.offeredQuantity} * ${table.unitPrice}, 2) and ${table.taxAmount} >= 0 and ${table.lineTotal} = ${table.lineSubtotal} + ${table.taxAmount}`,
    ),
    catalogTargetCheck: check(
      "visit_treatment_plan_revision_lines_catalog_target_check",
      sql`(${table.itemType} = 'service' and ${table.serviceId} is not null and ${table.productId} is null) or (${table.itemType} = 'product' and ${table.productId} is not null and ${table.serviceId} is null)`,
    ),
  }),
);

/**
 * Short-lived capability that presents one exact sealed revision to a client.
 * Only a SHA-256 digest of the bearer token is persisted. Decisions are held
 * here until the existing consent signer produces durable signature/file
 * evidence, after which they are copied into the immutable response spine.
 */
export const visitTreatmentPlanPresentations = pgTable(
  "visit_treatment_plan_presentations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    practiceId: uuid("practice_id").notNull(),
    planId: uuid("plan_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    responseId: uuid("response_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    decisions:
      jsonb("decisions").$type<VisitTreatmentPlanPresentationDecision[]>(),
    responseSha256: varchar("response_sha256", { length: 64 }),
    consentRequestId: uuid("consent_request_id"),
  },
  (table) => ({
    tokenHashUq: uniqueIndex(
      "visit_treatment_plan_presentations_token_hash_uq",
    ).on(table.tokenHash),
    responseUq: uniqueIndex(
      "visit_treatment_plan_presentations_response_uq",
    ).on(table.responseId),
    consentUq: uniqueIndex("visit_treatment_plan_presentations_consent_uq").on(
      table.consentRequestId,
    ),
    revisionStatusIdx: index(
      "visit_treatment_plan_presentations_revision_status_idx",
    ).on(table.practiceId, table.revisionId, table.status, table.expiresAt),
    revisionTenantFk: foreignKey({
      columns: [table.practiceId, table.revisionId, table.planId],
      foreignColumns: [
        visitTreatmentPlanRevisions.practiceId,
        visitTreatmentPlanRevisions.id,
        visitTreatmentPlanRevisions.planId,
      ],
      name: "visit_treatment_plan_presentations_revision_tenant_fk",
    }),
    planTenantFk: foreignKey({
      columns: [table.practiceId, table.planId],
      foreignColumns: [visitTreatmentPlans.practiceId, visitTreatmentPlans.id],
      name: "visit_treatment_plan_presentations_plan_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "visit_treatment_plan_presentations_creator_tenant_fk",
    }),
    consentTenantFk: foreignKey({
      columns: [table.practiceId, table.consentRequestId],
      foreignColumns: [consentRequests.practiceId, consentRequests.id],
      name: "visit_treatment_plan_presentations_consent_tenant_fk",
    }),
    statusCheck: check(
      "visit_treatment_plan_presentations_status_check",
      sql`${table.status} in ('pending', 'awaiting_signature', 'completed', 'superseded')`,
    ),
    tokenHashCheck: check(
      "visit_treatment_plan_presentations_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    responseHashCheck: check(
      "visit_treatment_plan_presentations_response_hash_check",
      sql`${table.responseSha256} is null or ${table.responseSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    stateCheck: check(
      "visit_treatment_plan_presentations_state_check",
      sql`(${table.status} in ('pending', 'superseded') and ${table.decisions} is null and ${table.responseSha256} is null and ${table.consentRequestId} is null) or (${table.status} in ('awaiting_signature', 'completed') and ${table.decisions} is not null and ${table.responseSha256} is not null and ${table.consentRequestId} is not null)`,
    ),
  }),
);

/**
 * A sealed client response. The linked signed consent must carry the exact
 * response hash marker, binding the PDF/signature evidence to these decisions.
 */
export const visitTreatmentPlanResponses = pgTable(
  "visit_treatment_plan_responses",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id").notNull(),
    planId: uuid("plan_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    consentRequestId: uuid("consent_request_id").notNull(),
    signedFileId: uuid("signed_file_id").notNull(),
    signatureSha256: varchar("signature_sha256", { length: 64 }).notNull(),
    signedDocumentSha256: varchar("signed_document_sha256", {
      length: 64,
    }).notNull(),
    signerName: varchar("signer_name", { length: 120 }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
    responseSha256: varchar("response_sha256", { length: 64 }).notNull(),
  },
  (table) => ({
    practiceRevisionIdUq: uniqueIndex(
      "visit_treatment_plan_responses_practice_revision_id_uq",
    ).on(table.practiceId, table.id, table.revisionId),
    revisionUq: uniqueIndex("visit_treatment_plan_responses_revision_uq").on(
      table.revisionId,
    ),
    consentUq: uniqueIndex("visit_treatment_plan_responses_consent_uq").on(
      table.consentRequestId,
    ),
    practiceOperationUq: uniqueIndex(
      "visit_treatment_plan_responses_practice_operation_uq",
    ).on(table.practiceId, table.operationId),
    patientHistoryIdx: index(
      "visit_treatment_plan_responses_plan_history_idx",
    ).on(table.practiceId, table.planId, table.createdAt, table.id),
    revisionTenantFk: foreignKey({
      columns: [table.practiceId, table.revisionId, table.planId],
      foreignColumns: [
        visitTreatmentPlanRevisions.practiceId,
        visitTreatmentPlanRevisions.id,
        visitTreatmentPlanRevisions.planId,
      ],
      name: "visit_treatment_plan_responses_revision_tenant_fk",
    }),
    signedFileTenantFk: foreignKey({
      columns: [table.practiceId, table.signedFileId],
      foreignColumns: [files.practiceId, files.id],
      name: "visit_treatment_plan_responses_signed_file_tenant_fk",
    }),
    signerNameCheck: check(
      "visit_treatment_plan_responses_signer_name_check",
      sql`length(btrim(${table.signerName})) between 1 and 120`,
    ),
    operationPayloadHashCheck: check(
      "visit_treatment_plan_responses_operation_payload_hash_check",
      sql`${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    responseHashCheck: check(
      "visit_treatment_plan_responses_response_hash_check",
      sql`${table.responseSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    signatureHashCheck: check(
      "visit_treatment_plan_responses_signature_hash_check",
      sql`${table.signatureSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    signedDocumentHashCheck: check(
      "visit_treatment_plan_responses_document_hash_check",
      sql`${table.signedDocumentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const visitTreatmentPlanResponseLines = pgTable(
  "visit_treatment_plan_response_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    responseId: uuid("response_id").notNull(),
    revisionLineId: uuid("revision_line_id").notNull(),
    decision: visitTreatmentPlanDecisionEnum("decision").notNull(),
    acceptedQuantity: numeric("accepted_quantity", {
      precision: 12,
      scale: 3,
    }).notNull(),
    declineReason: text("decline_reason"),
  },
  (table) => ({
    responseLineUq: uniqueIndex(
      "visit_treatment_plan_response_lines_response_line_uq",
    ).on(table.responseId, table.revisionLineId),
    responseOrderIdx: index(
      "visit_treatment_plan_response_lines_response_idx",
    ).on(table.practiceId, table.responseId, table.id),
    responseTenantFk: foreignKey({
      columns: [table.practiceId, table.responseId, table.revisionId],
      foreignColumns: [
        visitTreatmentPlanResponses.practiceId,
        visitTreatmentPlanResponses.id,
        visitTreatmentPlanResponses.revisionId,
      ],
      name: "visit_treatment_plan_response_lines_response_tenant_fk",
    }),
    revisionLineTenantFk: foreignKey({
      columns: [table.practiceId, table.revisionLineId, table.revisionId],
      foreignColumns: [
        visitTreatmentPlanRevisionLines.practiceId,
        visitTreatmentPlanRevisionLines.id,
        visitTreatmentPlanRevisionLines.revisionId,
      ],
      name: "visit_treatment_plan_response_lines_revision_line_tenant_fk",
    }),
    decisionQuantityCheck: check(
      "visit_treatment_plan_response_lines_decision_quantity_check",
      sql`(${table.decision} = 'accepted' and ${table.acceptedQuantity} > 0) or (${table.decision} = 'declined' and ${table.acceptedQuantity} = 0)`,
    ),
    declineReasonCheck: check(
      "visit_treatment_plan_response_lines_decline_reason_check",
      sql`${table.declineReason} is null or length(btrim(${table.declineReason})) between 1 and 2000`,
    ),
  }),
);
