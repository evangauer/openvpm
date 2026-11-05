import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";

/**
 * People who showed interest in OpenVPM before creating a clinic: hosted-demo
 * visitors who passed the email gate (and, later, list subscribers).
 *
 * Global pre-tenant state behind a system-only RLS policy. The address is kept
 * so OpenVPM can send the follow-up the person signed up for; the anonymous id
 * links privacy-safe funnel events (which tools they opened) to the lead.
 */
export const growthLeads = pgTable(
  "growth_leads",
  {
    ...baseColumns(),
    email: varchar("email", { length: 255 }).notNull(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    anonymousId: varchar("anonymous_id", { length: 64 }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    seenCount: integer("seen_count").notNull().default(1),
    /**
     * The email disclosure the person saw when they gave their address. The
     * follow-up sent never exceeds what that disclosure promised.
     */
    disclosureVersion: varchar("disclosure_version", { length: 32 }).notNull(),
    /** Set when a person takes over; automated follow-up stops. */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
  },
  (table) => ({
    emailHashUq: uniqueIndex("growth_leads_email_hash_uq").on(table.emailHash),
    sourceFirstSeenIdx: index("growth_leads_source_first_seen_idx").on(
      table.source,
      table.firstSeenAt,
    ),
    emailHashCheck: check(
      "growth_leads_email_hash_check",
      sql`${table.emailHash} ~ '^[a-f0-9]{64}$'`,
    ),
    sourceCheck: check(
      "growth_leads_source_check",
      sql`${table.source} in ('demo', 'newsletter')`,
    ),
  }),
);

/**
 * One row per follow-up email to a lead. The unique dedupe key makes every
 * sequence step send at most once, mirroring the practice communications
 * ledger for people who do not have a clinic yet.
 */
export const growthLeadEmails = pgTable(
  "growth_lead_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => growthLeads.id),
    sequence: varchar("sequence", { length: 40 }).notNull(),
    step: integer("step").notNull(),
    dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 128 }),
  },
  (table) => ({
    dedupeKeyUq: uniqueIndex("growth_lead_emails_dedupe_key_uq").on(
      table.dedupeKey,
    ),
    leadCreatedIdx: index("growth_lead_emails_lead_created_idx").on(
      table.leadId,
      table.createdAt,
    ),
    statusCheck: check(
      "growth_lead_emails_status_check",
      sql`${table.status} in ('pending', 'sent', 'failed')`,
    ),
  }),
);
