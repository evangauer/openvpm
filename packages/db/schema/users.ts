import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { locations } from "./practices";

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
  // Read-only access — can view everything in their practice but cannot
  // mutate. Useful for running OpenVPM as a parallel backup/secondary.
  "viewer",
]);

export const users = pgTable(
  "users",
  {
    ...baseColumns(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("front_desk"),
    // Authorization and clinical identity are intentionally separate. A
    // clinic owner can remain the required administrator while also appearing
    // as a veterinarian provider for scheduling and clinical sign-off.
    isVeterinarian: boolean("is_veterinarian").notNull().default(false),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    avatarUrl: varchar("avatar_url", { length: 512 }),
    licenseNumber: varchar("license_number", { length: 64 }),
    phone: varchar("phone", { length: 32 }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("users_practice_id_uq").on(
      table.practiceId,
      table.id
    ),
    practiceIdx: index("users_practice_idx").on(
      table.practiceId,
      table.deletedAt
    ),
    locationIdx: index("users_location_idx").on(
      table.practiceId,
      table.locationId,
      table.deletedAt
    ),
    roleIdx: index("users_role_idx").on(table.practiceId, table.role),
    veterinarianIdx: index("users_veterinarian_idx").on(
      table.practiceId,
      table.isVeterinarian,
      table.deletedAt
    ),
  })
);

export const usersRelations = relations(users, ({ one }) => ({
  practice: one(practices, {
    fields: [users.practiceId],
    references: [practices.id],
  }),
  location: one(locations, {
    fields: [users.locationId],
    references: [locations.id],
  }),
}));
