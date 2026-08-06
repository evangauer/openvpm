import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";

/**
 * Email-gated access to the hosted demo.
 *
 * This is global pre-tenant state, so it is protected by a system-only RLS
 * policy rather than a practice_id policy. The browser receives only a signed
 * token containing a hash of the email; the raw address stays server-side.
 */
export const demoAccesses = pgTable(
  "demo_accesses",
  {
    ...baseColumns(),
    email: varchar("email", { length: 255 }).notNull(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    firstAccessedAt: timestamp("first_accessed_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    accessCount: integer("access_count").notNull().default(1),
    feedbackOptOutAt: timestamp("feedback_opt_out_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    emailUq: uniqueIndex("demo_accesses_email_uq").on(table.email),
    emailHashUq: uniqueIndex("demo_accesses_email_hash_uq").on(
      table.emailHash
    ),
    recentIdx: index("demo_accesses_recent_idx").on(table.lastAccessedAt),
  })
);
