import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { patients } from "./patients";
import { practices } from "./practices";
import { users } from "./users";

export type PatientMergeIdentitySnapshot = {
  id: string;
  clientId: string;
  name: string;
  species:
    | "canine"
    | "feline"
    | "avian"
    | "rabbit"
    | "reptile"
    | "equine"
    | "bovine"
    | "ovine"
    | "caprine"
    | "porcine"
    | "poultry"
    | "camelid"
    | "other";
  breed: string | null;
  sex: "male" | "female" | "male_neutered" | "female_spayed" | null;
  dob: string | null;
  microchipNumber: string | null;
  externalSource: string | null;
  externalId: string | null;
};

/**
 * Append-only identity correction events for patient merges. Patient records
 * remain the durable identities; this ledger records which identity became an
 * alias, the canonical target, who performed the correction, and the exact
 * identity snapshots staff reviewed.
 */
export const patientMergeEvents = pgTable(
  "patient_merge_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    sourcePatientId: uuid("source_patient_id")
      .notNull()
      .references(() => patients.id),
    targetPatientId: uuid("target_patient_id")
      .notNull()
      .references(() => patients.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    performedBy: uuid("performed_by")
      .notNull()
      .references(() => users.id),
    performedByName: varchar("performed_by_name", { length: 255 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    operationId: uuid("operation_id").notNull(),
    sourceSnapshot: jsonb("source_snapshot")
      .$type<PatientMergeIdentitySnapshot>()
      .notNull(),
    targetSnapshot: jsonb("target_snapshot")
      .$type<PatientMergeIdentitySnapshot>()
      .notNull(),
  },
  (table) => ({
    sourceUq: uniqueIndex("patient_merge_events_source_uq").on(
      table.practiceId,
      table.sourcePatientId,
    ),
    operationUq: uniqueIndex("patient_merge_events_operation_uq").on(
      table.practiceId,
      table.operationId,
    ),
    targetHistoryIdx: index("patient_merge_events_target_history_idx").on(
      table.practiceId,
      table.targetPatientId,
      table.createdAt,
      table.id,
    ),
    sourceTenantFk: foreignKey({
      columns: [table.practiceId, table.sourcePatientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "patient_merge_events_source_tenant_fk",
    }),
    targetTenantFk: foreignKey({
      columns: [table.practiceId, table.targetPatientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "patient_merge_events_target_tenant_fk",
    }),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "patient_merge_events_client_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.performedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "patient_merge_events_actor_tenant_fk",
    }),
    differentPatientsCheck: check(
      "patient_merge_events_different_patients_check",
      sql`${table.sourcePatientId} <> ${table.targetPatientId}`,
    ),
    attributionCheck: check(
      "patient_merge_events_attribution_check",
      sql`length(btrim(${table.performedByName})) between 1 and 255`,
    ),
    reasonCheck: check(
      "patient_merge_events_reason_check",
      sql`length(btrim(${table.reason})) between 5 and 500`,
    ),
    snapshotsCheck: check(
      "patient_merge_events_snapshots_check",
      sql`jsonb_typeof(${table.sourceSnapshot}) = 'object'
        and jsonb_typeof(${table.targetSnapshot}) = 'object'`,
    ),
  }),
);

export const patientMergeEventsRelations = relations(
  patientMergeEvents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [patientMergeEvents.practiceId],
      references: [practices.id],
    }),
    sourcePatient: one(patients, {
      fields: [patientMergeEvents.sourcePatientId],
      references: [patients.id],
      relationName: "patientMergeSource",
    }),
    targetPatient: one(patients, {
      fields: [patientMergeEvents.targetPatientId],
      references: [patients.id],
      relationName: "patientMergeTarget",
    }),
    client: one(clients, {
      fields: [patientMergeEvents.clientId],
      references: [clients.id],
    }),
    actor: one(users, {
      fields: [patientMergeEvents.performedBy],
      references: [users.id],
    }),
  }),
);
