import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  integer,
  index,
  timestamp,
  uniqueIndex,
  date,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";
import { appointments } from "./scheduling";

export const fileStorageStatusEnum = pgEnum("file_storage_status", [
  // Existing objects start here until the reconciliation job verifies them.
  "unverified",
  "pending_upload",
  "available",
  "missing",
  "corrupt",
  "cleanup_pending",
]);

export const fileReplicaStatusEnum = pgEnum("file_replica_status", [
  "pending",
  "available",
  "missing",
  "corrupt",
  "failed",
]);

export const files = pgTable(
  "files",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileKey: varchar("file_key", { length: 512 }).notNull(),
    fileUrl: varchar("file_url", { length: 512 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }),
    fileSizeBytes: integer("file_size_bytes"),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    objectEtag: varchar("object_etag", { length: 255 }),
    objectVersionId: varchar("object_version_id", { length: 255 }),
    storageStatus: fileStorageStatusEnum("storage_status")
      .notNull()
      .default("unverified"),
    storageVerifiedAt: timestamp("storage_verified_at", {
      withTimezone: true,
    }),
    category: varchar("category", { length: 64 }),
    title: varchar("title", { length: 255 }),
    documentType: varchar("document_type", { length: 64 }),
    documentDate: date("document_date"),
    source: varchar("source", { length: 64 }),
    idempotencyKey: uuid("idempotency_key"),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: uuid("entity_id"),
    /** Exact patient ownership for clinical attachments. The legacy
     * entityType/entityId pair remains during the additive backfill window. */
    patientId: uuid("patient_id"),
    /** The visit this clinical file was captured in, when there was one.
     * General practice assets can remain unbound; patient documents use the
     * exact tenant-bound patient and optional visit links below. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
  },
  (table) => ({
    practiceIdx: index("files_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    practiceIdUq: uniqueIndex("files_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceFileKeyUq: uniqueIndex("files_practice_file_key_uq").on(
      table.practiceId,
      table.fileKey,
    ),
    practiceIdempotencyUq: uniqueIndex("files_practice_idempotency_key_uq")
      .on(table.practiceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    entityIdx: index("files_entity_idx").on(table.entityType, table.entityId),
    uploadedByIdx: index("files_uploaded_by_idx").on(table.uploadedBy),
    categoryIdx: index("files_category_idx").on(
      table.practiceId,
      table.category,
    ),
    appointmentIdx: index("files_appointment_idx").on(table.appointmentId),
    patientCreatedIdx: index("files_patient_created_idx").on(
      table.practiceId,
      table.patientId,
      table.deletedAt,
      table.createdAt,
    ),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "files_patient_tenant_fk",
    }),
    appointmentPatientTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "files_appointment_patient_tenant_fk",
    }),
    uploaderTenantFk: foreignKey({
      columns: [table.practiceId, table.uploadedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "files_uploader_tenant_fk",
    }),
    checksumFormatCheck: check(
      "files_checksum_sha256_format_check",
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    sizeCheck: check(
      "files_file_size_bytes_check",
      sql`${table.fileSizeBytes} is null or ${table.fileSizeBytes} >= 0`,
    ),
    availableEvidenceCheck: check(
      "files_available_evidence_check",
      sql`${table.storageStatus} <> 'available' or (${table.checksumSha256} is not null and ${table.fileSizeBytes} is not null and ${table.storageVerifiedAt} is not null)`,
    ),
    primaryNamespaceCheck: check(
      "files_primary_namespace_check",
      sql`${table.category} in ('patient-photos', 'documents', 'lab-results', 'branding', 'consents') and ${table.fileKey} ~ ('^' || ${table.practiceId}::text || '/' || ${table.category} || '/[^/]+$') and ${table.fileUrl} = '/api/files/' || ${table.fileKey}`,
    ),
    categoryRequiredCheck: check(
      "files_category_required_check",
      sql`${table.category} is not null`,
    ),
    patientEntityConsistencyCheck: check(
      "files_patient_entity_consistency_check",
      sql`${table.entityType} is distinct from 'patient' or (${table.patientId} is not null and ${table.entityId} is not null and ${table.entityId} = ${table.patientId})`,
    ),
    appointmentPatientCheck: check(
      "files_appointment_requires_patient_check",
      sql`${table.appointmentId} is null or ${table.patientId} is not null`,
    ),
  }),
);

export const filesRelations = relations(files, ({ one }) => ({
  practice: one(practices, {
    fields: [files.practiceId],
    references: [practices.id],
  }),
  uploader: one(users, {
    fields: [files.uploadedBy],
    references: [users.id],
  }),
  appointment: one(appointments, {
    fields: [files.appointmentId],
    references: [appointments.id],
  }),
  patient: one(patients, {
    fields: [files.patientId],
    references: [patients.id],
  }),
}));

/** Independent object-copy evidence. A file can have more than one replica
 * target, each with its own verified version and integrity state. */
export const fileObjectReplicas = pgTable(
  "file_object_replicas",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    fileId: uuid("file_id").notNull(),
    replicaTarget: varchar("replica_target", { length: 64 }).notNull(),
    objectKey: varchar("object_key", { length: 512 }).notNull(),
    objectEtag: varchar("object_etag", { length: 255 }),
    objectVersionId: varchar("object_version_id", { length: 255 }),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    fileSizeBytes: integer("file_size_bytes"),
    status: fileReplicaStatusEnum("status").notNull().default("pending"),
    replicatedAt: timestamp("replicated_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 64 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorClass: varchar("last_error_class", { length: 64 }),
  },
  (table) => ({
    fileTargetUq: uniqueIndex("file_object_replicas_file_target_uq").on(
      table.fileId,
      table.replicaTarget,
    ),
    practiceStatusIdx: index("file_object_replicas_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.updatedAt,
    ),
    dueIdx: index("file_object_replicas_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    fileTenantFk: foreignKey({
      columns: [table.practiceId, table.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "file_object_replicas_file_tenant_fk",
    }),
    attemptCountCheck: check(
      "file_object_replicas_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    checksumFormatCheck: check(
      "file_object_replicas_checksum_sha256_format_check",
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    sizeCheck: check(
      "file_object_replicas_file_size_bytes_check",
      sql`${table.fileSizeBytes} is null or ${table.fileSizeBytes} >= 0`,
    ),
    availableEvidenceCheck: check(
      "file_object_replicas_available_evidence_check",
      sql`${table.status} <> 'available' or (${table.checksumSha256} is not null and ${table.fileSizeBytes} is not null and ${table.replicatedAt} is not null and ${table.verifiedAt} is not null)`,
    ),
    independentObjectKeyCheck: check(
      "file_object_replicas_independent_object_key_check",
      sql`${table.replicaTarget} <> 'independent-v1' or (${table.objectKey} ~ ('^attachments/v1/' || ${table.practiceId}::text || '/' || ${table.fileId}::text || '/(pending|[0-9a-f]{64})$') and (${table.status} <> 'available' or (${table.checksumSha256} is not null and ${table.objectKey} = 'attachments/v1/' || ${table.practiceId}::text || '/' || ${table.fileId}::text || '/' || ${table.checksumSha256} and ${table.objectVersionId} is not null)))`,
    ),
    leaseCoherenceCheck: check(
      "file_object_replicas_lease_coherence_check",
      sql`(${table.leaseToken} is null and ${table.leaseExpiresAt} is null) or (${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  }),
);

export const fileObjectReplicasRelations = relations(
  fileObjectReplicas,
  ({ one }) => ({
    practice: one(practices, {
      fields: [fileObjectReplicas.practiceId],
      references: [practices.id],
    }),
    file: one(files, {
      fields: [fileObjectReplicas.fileId],
      references: [files.id],
    }),
  }),
);

/** Append-only system evidence for primary and replica storage transitions. */
export const fileStorageEvents = pgTable(
  "file_storage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    fileId: uuid("file_id").notNull(),
    storageTarget: varchar("storage_target", { length: 64 }).notNull(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    operationId: uuid("operation_id").notNull(),
    eventKind: varchar("event_kind", { length: 64 }).notNull(),
    previousStatus: varchar("previous_status", { length: 32 }),
    nextStatus: varchar("next_status", { length: 32 }).notNull(),
    expectedChecksumSha256: varchar("expected_checksum_sha256", { length: 64 }),
    observedChecksumSha256: varchar("observed_checksum_sha256", { length: 64 }),
    expectedFileSizeBytes: integer("expected_file_size_bytes"),
    observedFileSizeBytes: integer("observed_file_size_bytes"),
    objectEtag: varchar("object_etag", { length: 255 }),
    objectVersionId: varchar("object_version_id", { length: 255 }),
    failureCode: varchar("failure_code", { length: 64 }),
    workerRunId: uuid("worker_run_id"),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("file_storage_events_event_key_uq").on(
      table.eventKey,
    ),
    fileCreatedIdx: index("file_storage_events_file_created_idx").on(
      table.practiceId,
      table.fileId,
      table.createdAt,
    ),
    operationIdx: index("file_storage_events_operation_idx").on(
      table.operationId,
    ),
    fileTenantFk: foreignKey({
      columns: [table.practiceId, table.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "file_storage_events_file_tenant_fk",
    }),
    expectedChecksumFormatCheck: check(
      "file_storage_events_expected_checksum_format_check",
      sql`${table.expectedChecksumSha256} is null or ${table.expectedChecksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    observedChecksumFormatCheck: check(
      "file_storage_events_observed_checksum_format_check",
      sql`${table.observedChecksumSha256} is null or ${table.observedChecksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    expectedSizeCheck: check(
      "file_storage_events_expected_file_size_bytes_check",
      sql`${table.expectedFileSizeBytes} is null or ${table.expectedFileSizeBytes} >= 0`,
    ),
    observedSizeCheck: check(
      "file_storage_events_observed_file_size_bytes_check",
      sql`${table.observedFileSizeBytes} is null or ${table.observedFileSizeBytes} >= 0`,
    ),
  }),
);

export const fileStorageEventsRelations = relations(
  fileStorageEvents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [fileStorageEvents.practiceId],
      references: [practices.id],
    }),
    file: one(files, {
      fields: [fileStorageEvents.fileId],
      references: [files.id],
    }),
  }),
);

/**
 * Short-lived QR photo-capture sessions. A staff member mints one from a
 * patient chart; scanning the QR opens a no-login mobile upload page whose
 * token is this row's capability credential (same model as portal links and
 * the calendar feed: the raw token IS the credential, expiring quickly).
 */
export const captureSessions = pgTable(
  "capture_sessions",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    createdBy: uuid("created_by").references(() => users.id),
    /** The visit open when the session was minted (resolved server-side from
     * the patient's checked-in/in-exam appointment); copied onto each
     * uploaded file so photos attach to that visit. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /** 64-hex capability token embedded in the QR link. */
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** "photos" links upload pictures; "scribe" links record the visit. A
     * link only ever does the one thing it was made for. */
    purpose: varchar("purpose", { length: 16 }).notNull().default("photos"),
  },
  (table) => ({
    tokenUq: uniqueIndex("capture_sessions_token_uq").on(table.token),
    purposeCheck: check(
      "capture_sessions_purpose_check",
      sql`${table.purpose} in ('photos', 'scribe')`,
    ),
    practiceIdx: index("capture_sessions_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    patientIdx: index("capture_sessions_patient_idx").on(table.patientId),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "capture_sessions_patient_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "capture_sessions_creator_tenant_fk",
    }),
    appointmentPatientTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "capture_sessions_appointment_patient_tenant_fk",
    }),
  }),
);

export const captureSessionsRelations = relations(
  captureSessions,
  ({ one }) => ({
    practice: one(practices, {
      fields: [captureSessions.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [captureSessions.patientId],
      references: [patients.id],
    }),
    creator: one(users, {
      fields: [captureSessions.createdBy],
      references: [users.id],
    }),
  }),
);
