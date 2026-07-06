import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  numeric,
  boolean,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { clients } from "./clients";
import { patients } from "./patients";

export const billingIntervalEnum = pgEnum("billing_interval", [
  "monthly",
  "annual",
]);

export const enrollmentStatusEnum = pgEnum("enrollment_status", [
  "active",
  "cancelled",
]);

/** A wellness/membership plan a practice offers (e.g. "Puppy Wellness"). */
export const wellnessPlans = pgTable(
  "wellness_plans",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    billingInterval: billingIntervalEnum("billing_interval").notNull().default("monthly"),
    active: boolean("active").notNull().default(true),
  },
  (table) => ({
    practiceCreatedIdx: index("wellness_plans_practice_created_idx").on(
      table.practiceId,
      table.deletedAt,
      table.createdAt
    ),
  })
);

/** A client/patient enrolled in a plan, with the next billing date. */
export const wellnessEnrollments = pgTable(
  "wellness_enrollments",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => wellnessPlans.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    patientId: uuid("patient_id").references(() => patients.id),
    status: enrollmentStatusEnum("status").notNull().default("active"),
    startDate: date("start_date").notNull(),
    nextBillingDate: date("next_billing_date").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => ({
    practiceIdx: index("wellness_enrollments_practice_idx").on(
      table.practiceId,
      table.status
    ),
    dueIdx: index("wellness_enrollments_due_idx").on(table.nextBillingDate),
    billingDueIdx: index("wellness_enrollments_billing_due_idx").on(
      table.practiceId,
      table.status,
      table.nextBillingDate,
      table.deletedAt
    ),
    targetIdx: index("wellness_enrollments_target_idx").on(
      table.practiceId,
      table.planId,
      table.clientId,
      table.patientId,
      table.status,
      table.deletedAt
    ),
  })
);

export const wellnessPlansRelations = relations(wellnessPlans, ({ one, many }) => ({
  practice: one(practices, {
    fields: [wellnessPlans.practiceId],
    references: [practices.id],
  }),
  enrollments: many(wellnessEnrollments),
}));

export const wellnessEnrollmentsRelations = relations(
  wellnessEnrollments,
  ({ one }) => ({
    practice: one(practices, {
      fields: [wellnessEnrollments.practiceId],
      references: [practices.id],
    }),
    plan: one(wellnessPlans, {
      fields: [wellnessEnrollments.planId],
      references: [wellnessPlans.id],
    }),
    client: one(clients, {
      fields: [wellnessEnrollments.clientId],
      references: [clients.id],
    }),
    patient: one(patients, {
      fields: [wellnessEnrollments.patientId],
      references: [patients.id],
    }),
  })
);
