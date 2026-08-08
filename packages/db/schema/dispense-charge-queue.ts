import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
import { appointments } from "./scheduling";
import { clients } from "./clients";
import { patients } from "./patients";
import { practices } from "./practices";
import { prescriptionEvents } from "./prescription-events";
import { prescriptions } from "./prescriptions";
import { invoiceItems, invoices, products } from "./billing";
import { users } from "./users";

export const dispenseChargeStatusEnum = pgEnum("dispense_charge_status", [
  "pending",
  "invoiced",
  "waived",
]);

/**
 * Durable revenue work created in the same transaction as a clinic-stock
 * prescription event. Snapshot columns are immutable at the database layer;
 * status changes are explicit and attributed.
 */
export const dispenseChargeQueue = pgTable(
  "dispense_charge_queue",
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
    prescriptionEventId: uuid("prescription_event_id")
      .notNull()
      .references(() => prescriptionEvents.id),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    descriptionSnapshot: varchar("description_snapshot", {
      length: 500,
    }).notNull(),
    unitPriceSnapshot: numeric("unit_price_snapshot", {
      precision: 10,
      scale: 2,
    }).notNull(),
    status: dispenseChargeStatusEnum("status").notNull().default("pending"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    invoiceItemId: uuid("invoice_item_id").references(() => invoiceItems.id),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedByName: varchar("resolved_by_name", { length: 255 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason"),
    legacyReview: boolean("legacy_review").notNull().default(false),
  },
  (table) => ({
    sourceUq: uniqueIndex("dispense_charge_queue_source_uq").on(
      table.practiceId,
      table.prescriptionEventId,
    ),
    pendingIdx: index("dispense_charge_queue_pending_idx")
      .on(table.practiceId, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    patientIdx: index("dispense_charge_queue_patient_idx").on(
      table.practiceId,
      table.patientId,
      table.createdAt,
      table.id,
    ),
    invoiceItemUq: uniqueIndex("dispense_charge_queue_invoice_item_uq")
      .on(table.invoiceItemId)
      .where(sql`${table.invoiceItemId} is not null`),
    eventTenantFk: foreignKey({
      columns: [table.practiceId, table.prescriptionEventId],
      foreignColumns: [prescriptionEvents.practiceId, prescriptionEvents.id],
      name: "dispense_charge_queue_practice_event_fk",
    }),
    prescriptionTenantFk: foreignKey({
      columns: [table.practiceId, table.prescriptionId],
      foreignColumns: [prescriptions.practiceId, prescriptions.id],
      name: "dispense_charge_queue_practice_prescription_fk",
    }),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "dispense_charge_queue_practice_patient_fk",
    }),
    productTenantFk: foreignKey({
      columns: [table.practiceId, table.productId],
      foreignColumns: [products.practiceId, products.id],
      name: "dispense_charge_queue_practice_product_fk",
    }),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "dispense_charge_queue_practice_appointment_fk",
    }),
    invoiceItemTargetFk: foreignKey({
      columns: [table.invoiceId, table.invoiceItemId],
      foreignColumns: [invoiceItems.invoiceId, invoiceItems.id],
      name: "dispense_charge_queue_invoice_item_target_fk",
    }),
    shapeCheck: check(
      "dispense_charge_queue_shape_check",
      sql`${table.quantity} > 0
        and ${table.unitPriceSnapshot} >= 0
        and length(btrim(${table.descriptionSnapshot})) > 0
        and (
          ${table.status} = 'pending'
          and ${table.invoiceId} is null
          and ${table.invoiceItemId} is null
          and ${table.resolvedBy} is null
          and ${table.resolvedByName} is null
          and ${table.resolvedAt} is null
          and ${table.resolutionReason} is null
        or ${table.status} = 'invoiced'
          and ${table.invoiceId} is not null
          and ${table.invoiceItemId} is not null
          and ${table.resolvedBy} is not null
          and length(btrim(coalesce(${table.resolvedByName}, ''))) > 0
          and ${table.resolvedAt} is not null
          and ${table.resolutionReason} is null
        or ${table.status} = 'waived'
          and ${table.invoiceId} is null
          and ${table.invoiceItemId} is null
          and ${table.resolvedBy} is not null
          and length(btrim(coalesce(${table.resolvedByName}, ''))) > 0
          and ${table.resolvedAt} is not null
          and length(btrim(coalesce(${table.resolutionReason}, ''))) >= 5
          and length(${table.resolutionReason}) <= 1000
        )`,
    ),
  }),
);
