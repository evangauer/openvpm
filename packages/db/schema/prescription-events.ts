import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { patients } from "./patients";
import { prescriptions, prescriptionStatusEnum } from "./prescriptions";
import { practices } from "./practices";
import { products } from "./billing";
import { users } from "./users";

export const prescriptionEventTypeEnum = pgEnum("prescription_event_type", [
  "created",
  "refill_dispensed",
  "refill_authorized",
  "completed",
  "cancelled",
  "expired",
]);

/**
 * Immutable clinical lifecycle history for prescriptions. The prescription row
 * keeps the current state for efficient reads; every state/refill transition is
 * attributed here in the same database transaction.
 */
export const prescriptionEvents = pgTable(
  "prescription_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    productId: uuid("product_id").references(() => products.id),
    eventType: prescriptionEventTypeEnum("event_type").notNull(),
    quantity: integer("quantity"),
    statusBefore: prescriptionStatusEnum("status_before"),
    statusAfter: prescriptionStatusEnum("status_after").notNull(),
    refillsBefore: integer("refills_before"),
    refillsAfter: integer("refills_after").notNull(),
    reason: text("reason"),
    actorId: uuid("actor_id").references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    operationId: uuid("operation_id"),
  },
  (table) => ({
    prescriptionHistoryIdx: index(
      "prescription_events_prescription_history_idx",
    ).on(table.practiceId, table.prescriptionId, table.createdAt, table.id),
    practiceTimeIdx: index("prescription_events_practice_time_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    operationUq: uniqueIndex("prescription_events_practice_operation_uq")
      .on(table.practiceId, table.operationId)
      .where(sql`${table.operationId} is not null`),
    createdUq: uniqueIndex("prescription_events_created_uq")
      .on(table.practiceId, table.prescriptionId)
      .where(sql`${table.eventType} = 'created'`),
    terminalUq: uniqueIndex("prescription_events_terminal_uq")
      .on(table.practiceId, table.prescriptionId)
      .where(sql`${table.eventType} in ('completed', 'cancelled', 'expired')`),
    practiceIdUq: uniqueIndex("prescription_events_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    prescriptionTenantFk: foreignKey({
      columns: [table.practiceId, table.prescriptionId],
      foreignColumns: [prescriptions.practiceId, prescriptions.id],
      name: "prescription_events_practice_prescription_fk",
    }),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "prescription_events_practice_patient_fk",
    }),
    productTenantFk: foreignKey({
      columns: [table.practiceId, table.productId],
      foreignColumns: [products.practiceId, products.id],
      name: "prescription_events_practice_product_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "prescription_events_practice_actor_fk",
    }),
    immutableShapeCheck: check(
      "prescription_events_shape_check",
      sql`length(btrim(${table.actorName})) > 0
        and ${table.refillsAfter} >= 0
        and (${table.refillsBefore} is null or ${table.refillsBefore} >= 0)
        and (${table.reason} is null or length(${table.reason}) <= 500)
        and (
          ${table.eventType} = 'created'
          and ${table.statusBefore} is null
          and ${table.statusAfter} = 'active'
          and ${table.refillsBefore} is null
          and ${table.actorId} is not null
        or ${table.eventType} = 'refill_dispensed'
          and ${table.statusBefore} = 'active'
          and ${table.statusAfter} = 'active'
          and ${table.productId} is not null
          and ${table.quantity} > 0
          and ${table.refillsBefore} > 0
          and ${table.refillsAfter} = ${table.refillsBefore} - 1
          and ${table.actorId} is not null
          and ${table.operationId} is not null
        or ${table.eventType} = 'refill_authorized'
          and ${table.statusBefore} = 'active'
          and ${table.statusAfter} = 'active'
          and ${table.productId} is null
          and ${table.refillsBefore} > 0
          and ${table.refillsAfter} = ${table.refillsBefore} - 1
          and ${table.actorId} is not null
          and ${table.operationId} is not null
        or ${table.eventType} in ('completed', 'cancelled')
          and ${table.statusBefore} = 'active'
          and ${table.statusAfter}::text = ${table.eventType}::text
          and length(btrim(coalesce(${table.reason}, ''))) >= 5
          and ${table.refillsBefore} = ${table.refillsAfter}
          and ${table.actorId} is not null
          and ${table.operationId} is not null
        or ${table.eventType} = 'expired'
          and ${table.statusBefore} = 'active'
          and ${table.statusAfter} = 'expired'
          and length(btrim(coalesce(${table.reason}, ''))) >= 5
          and ${table.refillsBefore} = ${table.refillsAfter}
        )`,
    ),
  }),
);

export const prescriptionEventsRelations = relations(
  prescriptionEvents,
  ({ one }) => ({
    prescription: one(prescriptions, {
      fields: [prescriptionEvents.prescriptionId],
      references: [prescriptions.id],
    }),
    patient: one(patients, {
      fields: [prescriptionEvents.patientId],
      references: [patients.id],
    }),
    product: one(products, {
      fields: [prescriptionEvents.productId],
      references: [products.id],
    }),
    actor: one(users, {
      fields: [prescriptionEvents.actorId],
      references: [users.id],
    }),
  }),
);
