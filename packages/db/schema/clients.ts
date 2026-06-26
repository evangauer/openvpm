import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";

export const contactMethodEnum = pgEnum("contact_method", [
  "phone",
  "email",
  "sms",
  "portal",
]);

export const clients = pgTable(
  "clients",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    firstName: varchar("first_name", { length: 128 }).notNull(),
    lastName: varchar("last_name", { length: 128 }).notNull(),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 32 }),
    address: text("address"),
    city: varchar("city", { length: 128 }),
    state: varchar("state", { length: 64 }),
    zip: varchar("zip", { length: 16 }),
    emergencyContact: varchar("emergency_contact", { length: 255 }),
    emergencyPhone: varchar("emergency_phone", { length: 32 }),
    preferredContactMethod: contactMethodEnum("preferred_contact_method").default("phone"),
    // SMS opt-in for TCPA: consent state + an audit trail of how/when it was
    // captured and the exact disclosure shown. Required before texting a client.
    smsConsent: boolean("sms_consent").notNull().default(false),
    smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
    smsConsentSource: varchar("sms_consent_source", { length: 32 }), // intake|verbal|import|portal
    smsConsentDisclosure: text("sms_consent_disclosure"),
    notes: text("notes"),
    accessToken: varchar("access_token", { length: 64 }).unique(),
  },
  (table) => ({
    practiceIdx: index("clients_practice_idx").on(table.practiceId, table.deletedAt),
    nameTrgmIdx: index("clients_name_trgm_idx").on(table.firstName, table.lastName),
    emailIdx: index("clients_email_idx").on(table.email),
  })
);

export const clientsRelations = relations(clients, ({ one }) => ({
  practice: one(practices, {
    fields: [clients.practiceId],
    references: [practices.id],
  }),
}));
