import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { users } from "./users";
import { patients } from "./patients";

/** Durable preparation/replay identity. Clinical text stays in clinical records. */
export const offlineFieldBatches = pgTable(
  "offline_field_batches",
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
    preparationHash: varchar("preparation_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<{
      appointmentId: string;
      noteId: string;
      invoiceId: string;
      paymentId: string | null;
      vaccinationIds: string[];
      syncedAt: string;
    }>(),
  },
  (t) => ({
    userPracticeFk: foreignKey({
      columns: [t.practiceId, t.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "offline_field_batches_practice_user_fk",
    }),
    patientPracticeFk: foreignKey({
      columns: [t.practiceId, t.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "offline_field_batches_practice_patient_fk",
    }),
    ownerIdx: index("offline_field_batches_owner_idx").on(
      t.practiceId,
      t.userId,
      t.createdAt,
    ),
    stateCheck: check(
      "offline_field_batches_state_check",
      sql`(${t.requestHash} is null and ${t.result} is null and ${t.receipt} is null) or (${t.requestHash} is not null and ${t.requestHash} ~ '^[a-f0-9]{64}$' and ${t.result} is not null and ${t.receipt} is not null)`,
    ),
    hashCheck: check(
      "offline_field_batches_hash_check",
      sql`${t.preparationHash} ~ '^[a-f0-9]{64}$'`,
    ),
  }),
);
