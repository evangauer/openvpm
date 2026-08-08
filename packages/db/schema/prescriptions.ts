import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  date,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { users } from "./users";
import { patients } from "./patients";
import { products } from "./billing";
import { appointments } from "./scheduling";

export const prescriptionStatusEnum = pgEnum("prescription_status", [
  "active",
  "completed",
  "cancelled",
  "expired",
]);

export const interactionSeverityEnum = pgEnum("interaction_severity", [
  "minor",
  "moderate",
  "major",
]);

export const prescriptions = pgTable(
  "prescriptions",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    medicationName: varchar("medication_name", { length: 255 }).notNull(),
    dosage: varchar("dosage", { length: 128 }).notNull(),
    frequency: varchar("frequency", { length: 128 }).notNull(),
    quantity: integer("quantity"),
    productId: uuid("product_id").references((): AnyPgColumn => products.id),
    operationId: uuid("operation_id"),
    refillsRemaining: integer("refills_remaining").notNull().default(0),
    prescribedBy: uuid("prescribed_by")
      .notNull()
      .references(() => users.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    status: prescriptionStatusEnum("status").notNull().default("active"),
    instructions: text("instructions"),
  },
  (table) => ({
    patientStatusIdx: index("prescriptions_patient_status_idx").on(
      table.patientId,
      table.status
    ),
    practiceStatusIdx: index("prescriptions_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.deletedAt
    ),
    productIdx: index("prescriptions_product_idx").on(table.productId),
    appointmentIdx: index("prescriptions_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt
    ),
    operationUq: uniqueIndex("prescriptions_practice_operation_uq").on(
      table.practiceId,
      table.operationId
    ),
  })
);

export const drugInteractions = pgTable("drug_interactions", {
  ...baseColumns(),
  drugA: varchar("drug_a", { length: 255 }).notNull(),
  drugB: varchar("drug_b", { length: 255 }).notNull(),
  severity: interactionSeverityEnum("severity").notNull(),
  description: text("description"),
});

export const prescriptionsRelations = relations(prescriptions, ({ one }) => ({
  practice: one(practices, {
    fields: [prescriptions.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [prescriptions.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [prescriptions.appointmentId],
    references: [appointments.id],
  }),
  prescriber: one(users, {
    fields: [prescriptions.prescribedBy],
    references: [users.id],
  }),
  product: one(products, {
    fields: [prescriptions.productId],
    references: [products.id],
  }),
}));
