import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";
import { appointments } from "./scheduling";
import { patients } from "./patients";
import { practices } from "./practices";
import { users } from "./users";

/**
 * Server-side navigation history for clinicians. Keeping this tenant- and
 * user-scoped avoids placing patient names or identifiers in browser storage.
 */
export const recentClinicalItems = pgTable(
  "recent_clinical_items",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userPatientUq: uniqueIndex("recent_clinical_items_user_patient_uq").on(
      table.practiceId,
      table.userId,
      table.patientId,
    ),
    userViewedIdx: index("recent_clinical_items_user_viewed_idx").on(
      table.practiceId,
      table.userId,
      table.viewedAt,
    ),
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "recent_clinical_items_user_tenant_fk",
    }),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "recent_clinical_items_patient_tenant_fk",
    }),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "recent_clinical_items_appointment_tenant_fk",
    }),
  }),
);
