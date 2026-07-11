import {
  pgTable,
  uuid,
  varchar,
  text,
  index,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";
import { files } from "./files";
import { appointments } from "./scheduling";

/**
 * E-sign consent requests. A staff member dispatches one from a patient
 * chart (same QR capability-link model as capture_sessions); the client
 * opens the no-login /sign/[token] page, reads the consent text snapshot
 * stored here, and signs. The durable record is the signed PDF in the
 * files table plus an audit row; this row carries the expiring token and
 * the signing metadata.
 */
export const consentRequests = pgTable(
  "consent_requests",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    createdBy: uuid("created_by").references(() => users.id),
    /** The visit open when the request was dispatched (resolved server-side
     * from the patient's checked-in/in-exam appointment); copied onto the
     * signed PDF's file row so the consent attaches to that visit. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /** 64-hex capability token embedded in the QR link. */
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Consent copy is snapshotted at dispatch time so later template edits
     * never change what someone already signed. */
    title: varchar("title", { length: 200 }).notNull(),
    bodyText: text("body_text").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    signerName: varchar("signer_name", { length: 120 }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** The signed consent PDF in the files table. */
    fileId: uuid("file_id").references(() => files.id),
  },
  (table) => ({
    tokenUq: uniqueIndex("consent_requests_token_uq").on(table.token),
    practiceIdx: index("consent_requests_practice_idx").on(
      table.practiceId,
      table.deletedAt
    ),
    patientIdx: index("consent_requests_patient_idx").on(table.patientId),
  })
);

export const consentRequestsRelations = relations(
  consentRequests,
  ({ one }) => ({
    practice: one(practices, {
      fields: [consentRequests.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [consentRequests.patientId],
      references: [patients.id],
    }),
    creator: one(users, {
      fields: [consentRequests.createdBy],
      references: [users.id],
    }),
    file: one(files, {
      fields: [consentRequests.fileId],
      references: [files.id],
    }),
    appointment: one(appointments, {
      fields: [consentRequests.appointmentId],
      references: [appointments.id],
    }),
  })
);
