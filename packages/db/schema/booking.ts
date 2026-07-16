import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";

/**
 * Public booking pages — one per practice. The page itself is served at
 * /book/[slug] with no auth; `published` is the visibility switch and
 * `config` holds everything the page needs to render and validate bookings
 * (weekly hours, bookable appointment types, lead time, copy, branding).
 * Config is validated/normalized in the app layer (lib/booking/config.ts),
 * never trusted raw from the database.
 */
export const bookingPages = pgTable(
  "booking_pages",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    published: boolean("published").notNull().default(false),
    config: jsonb("config").notNull().default({}),
  },
  (table) => ({
    practiceIdx: index("booking_pages_practice_idx").on(
      table.practiceId,
      table.deletedAt
    ),
    // Public lookup path: slug → live page.
    slugPublishedIdx: index("booking_pages_slug_published_idx").on(
      table.slug,
      table.published,
      table.deletedAt
    ),
  })
);

export const bookingPagesRelations = relations(bookingPages, ({ one }) => ({
  practice: one(practices, {
    fields: [bookingPages.practiceId],
    references: [practices.id],
  }),
}));
