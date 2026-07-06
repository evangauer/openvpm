import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { patients } from "./patients";
import { users } from "./users";

export const controlledSubstanceActionEnum = pgEnum(
  "controlled_substance_action",
  ["received", "administered", "wasted", "returned"]
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
    lotNumber: varchar("lot_number", { length: 64 }),
    notes: text("notes"),
    performedAt: timestamp("performed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    practiceDrugDateIdx: index("cs_log_practice_drug_date_idx").on(
      table.practiceId,
      table.drugName,
      table.performedAt
    ),
    practiceDateIdx: index("cs_log_practice_date_idx").on(
      table.practiceId,
      table.deletedAt,
      table.performedAt
    ),
  })
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
  })
);
