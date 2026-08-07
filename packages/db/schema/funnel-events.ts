import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";
import { practices } from "./practices";

/**
 * Privacy-safe product journey ledger.
 *
 * Browser events carry a random anonymous id and coarse route metadata only.
 * Server-owned lifecycle stages may also reference a practice. Email, client,
 * patient, and clinical data never belong in this table.
 */
export const funnelEvents = pgTable(
  "funnel_events",
  {
    ...baseColumns(),
    eventName: varchar("event_name", { length: 64 }).notNull(),
    anonymousId: varchar("anonymous_id", { length: 64 }),
    practiceId: uuid("practice_id").references(() => practices.id),
    source: varchar("source", { length: 80 }),
    path: varchar("path", { length: 500 }),
    origin: varchar("origin", { length: 255 }),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => ({
    eventTimeIdx: index("funnel_events_event_time_idx").on(
      table.eventName,
      table.createdAt
    ),
    anonymousTimeIdx: index("funnel_events_anonymous_time_idx").on(
      table.anonymousId,
      table.createdAt
    ),
    practiceTimeIdx: index("funnel_events_practice_time_idx").on(
      table.practiceId,
      table.createdAt
    ),
    practiceStageUq: uniqueIndex("funnel_events_practice_stage_uq")
      .on(table.practiceId, table.eventName)
      .where(
        sql`${table.practiceId} is not null and ${table.eventName} in ('registration', 'activation', 'card_added', 'paid')`
      ),
  })
);
