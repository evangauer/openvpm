import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";

export const controlledSubstanceActionEnum = pgEnum(
  "controlled_substance_action",
  ["received", "administered", "wasted", "returned"],
);

export const controlledSubstanceLog = pgTable(
  "controlled_substance_log",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    drugName: varchar("drug_name", { length: 255 }).notNull(),
    deaSchedule: varchar("dea_schedule", { length: 10 }).notNull(),
    action: controlledSubstanceActionEnum("action").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull(),
    unit: varchar("unit", { length: 32 }).notNull(),
    patientId: uuid("patient_id").references(() => patients.id),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => users.id),
    witnessedBy: uuid("witnessed_by").references(() => users.id),
    /** Client-generated identity makes append-only ledger writes retry-safe. */
    operationId: uuid("operation_id").notNull(),
    lotNumber: varchar("lot_number", { length: 64 }),
    notes: text("notes"),
    performedAt: timestamp("performed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("controlled_substance_log_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    operationIdUq: uniqueIndex(
      "controlled_substance_log_practice_operation_uq",
    ).on(table.practiceId, table.operationId),
    practiceDrugDateIdx: index("cs_log_practice_drug_date_idx").on(
      table.practiceId,
      table.drugName,
      table.performedAt,
    ),
    practiceDateIdx: index("cs_log_practice_date_idx").on(
      table.practiceId,
      table.deletedAt,
      table.performedAt,
    ),
    patientTenantFk: foreignKey({
      name: "controlled_substance_log_patient_tenant_fk",
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
    }),
    performerTenantFk: foreignKey({
      name: "controlled_substance_log_performer_tenant_fk",
      columns: [table.practiceId, table.performedBy],
      foreignColumns: [users.practiceId, users.id],
    }),
    witnessTenantFk: foreignKey({
      name: "controlled_substance_log_witness_tenant_fk",
      columns: [table.practiceId, table.witnessedBy],
      foreignColumns: [users.practiceId, users.id],
    }),
    positiveQuantityCheck: check(
      "controlled_substance_log_positive_quantity_check",
      sql`${table.quantity} > 0`,
    ),
    administeredPatientCheck: check(
      "controlled_substance_log_administered_patient_check",
      sql`${table.action} <> 'administered' or ${table.patientId} is not null`,
    ),
    wasteWitnessCheck: check(
      "controlled_substance_log_waste_witness_check",
      sql`${table.action} <> 'wasted' or ${table.witnessedBy} is not null`,
    ),
    distinctWitnessCheck: check(
      "controlled_substance_log_distinct_witness_check",
      sql`${table.witnessedBy} is null or ${table.witnessedBy} <> ${table.performedBy}`,
    ),
  }),
);

// Relations
export const controlledSubstanceLogRelations = relations(
  controlledSubstanceLog,
  ({ one }) => ({
    practice: one(practices, {
      fields: [controlledSubstanceLog.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [controlledSubstanceLog.patientId],
      references: [patients.id],
    }),
    performer: one(users, {
      fields: [controlledSubstanceLog.performedBy],
      references: [users.id],
      relationName: "performer",
    }),
    witness: one(users, {
      fields: [controlledSubstanceLog.witnessedBy],
      references: [users.id],
      relationName: "witness",
    }),
  }),
);
