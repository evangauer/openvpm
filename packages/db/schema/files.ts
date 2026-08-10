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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
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
    fileTenantFk: foreignKey({
      columns: [table.practiceId, table.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "file_object_replicas_file_tenant_fk",
    }),
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
  },
  (table) => ({
    tokenUq: uniqueIndex("capture_sessions_token_uq").on(table.token),
    practiceIdx: index("capture_sessions_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    patientIdx: index("capture_sessions_patient_idx").on(table.patientId),
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
