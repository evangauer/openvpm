import {
  pgTable,
  uuid,
  varchar,
  integer,
  index,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";

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
    category: varchar("category", { length: 64 }),
    entityType: varchar("entity_type", { length: 64 }),
    entityId: uuid("entity_id"),
  },
  (table) => ({
    practiceIdx: index("files_practice_idx").on(table.practiceId, table.deletedAt),
    entityIdx: index("files_entity_idx").on(table.entityType, table.entityId),
    uploadedByIdx: index("files_uploaded_by_idx").on(table.uploadedBy),
    categoryIdx: index("files_category_idx").on(table.practiceId, table.category),
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
}));

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
    /** 64-hex capability token embedded in the QR link. */
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    tokenUq: uniqueIndex("capture_sessions_token_uq").on(table.token),
    practiceIdx: index("capture_sessions_practice_idx").on(
      table.practiceId,
      table.deletedAt
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
  })
);
