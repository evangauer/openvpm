import {
  check,
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  date,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { clients } from "./clients";
import { users } from "./users";

export const speciesEnum = pgEnum("species", [
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "other",
]);

export const sexEnum = pgEnum("sex", [
  "male",
  "female",
  "male_neutered",
  "female_spayed",
]);

export const patientStatusEnum = pgEnum("patient_status", [
  "active",
  "inactive",
  "deceased",
]);

export const allergySeverityEnum = pgEnum("allergy_severity", [
  "mild",
  "moderate",
  "severe",
]);

export const patients = pgTable(
  "patients",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    externalSource: varchar("external_source", { length: 64 }),
    externalId: varchar("external_id", { length: 160 }),
    // Import-only identity. Ordinary clinic-created charts keep this null.
    importFingerprint: varchar("import_fingerprint", { length: 64 }),
    name: varchar("name", { length: 128 }).notNull(),
    species: speciesEnum("species").notNull(),
    breed: varchar("breed", { length: 128 }),
    sex: sexEnum("sex"),
    dob: date("dob"),
    color: varchar("color", { length: 64 }),
    microchipNumber: varchar("microchip_number", { length: 64 }),
    photoUrl: varchar("photo_url", { length: 512 }),
    status: patientStatusEnum("status").notNull().default("active"),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("patients_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceClientIdUq: uniqueIndex("patients_practice_client_id_uq").on(
      table.practiceId,
      table.id,
      table.clientId,
    ),
    practiceIdx: index("patients_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    clientIdx: index("patients_client_idx").on(table.clientId),
    nameIdx: index("patients_name_idx").on(table.name),
    externalIdUq: uniqueIndex("patients_external_id_uq")
      .on(table.practiceId, table.externalSource, table.externalId)
      .where(
        sql`${table.externalSource} is not null and ${table.externalId} is not null`,
      ),
    importFingerprintUq: uniqueIndex("patients_import_fingerprint_uq")
      .on(table.practiceId, table.importFingerprint)
      .where(
        sql`${table.importFingerprint} is not null and ${table.deletedAt} is null`,
      ),
    importFingerprintCheck: check(
      "patients_import_fingerprint_check",
      sql`${table.importFingerprint} is null or ${table.importFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    externalIdentityPairCheck: check(
      "patients_external_identity_pair_check",
      sql`(${table.externalSource} is null) = (${table.externalId} is null)`,
    ),
  }),
);

export const patientWeights = pgTable(
  "patient_weights",
  {
    ...baseColumns(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    weightKg: numeric("weight_kg", { precision: 8, scale: 3 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    recordedBy: uuid("recorded_by").references(() => users.id),
  },
  (table) => ({
    patientRecordedIdx: index("patient_weights_patient_recorded_idx").on(
      table.patientId,
      table.deletedAt,
      table.recordedAt,
    ),
  }),
);

export const patientAllergies = pgTable(
  "patient_allergies",
  {
    ...baseColumns(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    allergen: varchar("allergen", { length: 255 }).notNull(),
    reaction: text("reaction"),
    severity: allergySeverityEnum("severity").notNull().default("moderate"),
    notedBy: uuid("noted_by").references(() => users.id),
    notedAt: timestamp("noted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    idPatientUq: uniqueIndex("patient_allergies_id_patient_uq").on(
      table.id,
      table.patientId,
    ),
    patientIdx: index("patient_allergies_patient_idx").on(
      table.patientId,
      table.deletedAt,
    ),
  }),
);

export const patientsRelations = relations(patients, ({ one, many }) => ({
  practice: one(practices, {
    fields: [patients.practiceId],
    references: [practices.id],
  }),
  client: one(clients, {
    fields: [patients.clientId],
    references: [clients.id],
  }),
  weights: many(patientWeights),
  allergies: many(patientAllergies),
}));

export const patientWeightsRelations = relations(patientWeights, ({ one }) => ({
  patient: one(patients, {
    fields: [patientWeights.patientId],
    references: [patients.id],
  }),
  recorder: one(users, {
    fields: [patientWeights.recordedBy],
    references: [users.id],
  }),
}));

export const patientAllergiesRelations = relations(
  patientAllergies,
  ({ one }) => ({
    patient: one(patients, {
      fields: [patientAllergies.patientId],
      references: [patients.id],
    }),
    notedByUser: one(users, {
      fields: [patientAllergies.notedBy],
      references: [users.id],
    }),
  }),
);
