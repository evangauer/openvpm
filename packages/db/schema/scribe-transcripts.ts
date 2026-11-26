import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { practices } from "./practices";
import { users } from "./users";
import { appointments } from "./scheduling";

/**
 * Working transcript for a visit that Scribe is recording, one row per short
 * stretch of audio. It exists only so the visit's SOAP note can be drafted from
 * it: rows are deleted when that note is finalized, and a daily job removes any
 * left behind. Audio is never stored.
 */
export const scribeTranscriptSegments = pgTable(
  "scribe_transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** Chosen by the recording device so a retried upload is stored once. */
    clientKey: uuid("client_key").notNull(),
    /** Which device recorded it: "browser" (the chart) or "phone" (QR link). */
    source: varchar("source", { length: 16 }).notNull(),
    text: text("text").notNull(),
  },
  (table) => ({
    clientKeyUq: uniqueIndex("scribe_transcript_segments_client_key_uq").on(
      table.practiceId,
      table.appointmentId,
      table.clientKey,
    ),
    visitIdx: index("scribe_transcript_segments_visit_idx").on(
      table.practiceId,
      table.appointmentId,
      table.createdAt,
    ),
    createdIdx: index("scribe_transcript_segments_created_idx").on(
      table.createdAt,
    ),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "scribe_transcript_segments_appointment_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "scribe_transcript_segments_creator_tenant_fk",
    }),
    sourceCheck: check(
      "scribe_transcript_segments_source_check",
      sql`${table.source} in ('browser', 'phone')`,
    ),
    textLengthCheck: check(
      "scribe_transcript_segments_text_length_check",
      sql`length(${table.text}) <= 8000`,
    ),
  }),
);

/**
 * One row per recording Scribe makes, holding counts only: how much audio it
 * has taken and how many AI runs that has been billed as. It is what lets the
 * server meter a recording by its length, cap it, and tell two devices apart
 * without trusting anything the recording device says about itself. It never
 * holds audio, transcript, or note text.
 */
export const scribeRecordings = pgTable(
  "scribe_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    /** The visit being recorded; null for the standalone Scribe page. */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /** Names the recording: chosen by the browser, or the phone link's id. */
    recordingKey: uuid("recording_key").notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    /** SHA-256 of the secret held by the one phone a link is opened on. */
    deviceKeyHash: varchar("device_key_hash", { length: 64 }),
    audioSeconds: integer("audio_seconds").notNull().default(0),
    meteredRuns: integer("metered_runs").notNull().default(0),
  },
  (table) => ({
    recordingKeyUq: uniqueIndex("scribe_recordings_recording_key_uq").on(
      table.practiceId,
      table.recordingKey,
    ),
    visitIdx: index("scribe_recordings_visit_idx").on(
      table.practiceId,
      table.appointmentId,
      table.updatedAt,
    ),
    createdIdx: index("scribe_recordings_created_idx").on(table.createdAt),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "scribe_recordings_appointment_tenant_fk",
    }),
    creatorTenantFk: foreignKey({
      columns: [table.practiceId, table.createdBy],
      foreignColumns: [users.practiceId, users.id],
      name: "scribe_recordings_creator_tenant_fk",
    }),
    sourceCheck: check(
      "scribe_recordings_source_check",
      sql`${table.source} in ('browser', 'phone')`,
    ),
    countsCheck: check(
      "scribe_recordings_counts_check",
      sql`${table.audioSeconds} >= 0 and ${table.meteredRuns} >= 0`,
    ),
  }),
);
