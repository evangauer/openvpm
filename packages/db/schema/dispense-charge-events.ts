import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  dispenseChargeQueue,
  dispenseChargeStatusEnum,
} from "./dispense-charge-queue";
import { practices } from "./practices";
import { prescriptionEvents } from "./prescription-events";
import { users } from "./users";

export const dispenseChargeEventTypeEnum = pgEnum(
  "dispense_charge_event_type",
  ["created", "invoiced", "waived", "reopened"],
);

export const dispenseChargeTransitionSourceEnum = pgEnum(
  "dispense_charge_transition_source",
  [
    "prescription_dispense",
    "invoice_create",
    "invoice_edit",
    "medication_queue",
    "visit_reconciliation",
    "invoice_void",
    "invoice_line_removed",
    "legacy_backfill",
    "database_safeguard",
  ],
);

/**
 * Append-only evidence for every medication charge state transition. The
 * queue row is the efficient current-state projection; this ledger preserves
 * attribution even when an invoice is voided or a line is removed.
 *
 * Rows are written by a database trigger on `dispense_charge_queue`. The app
 * role has read-only access so application code cannot fabricate history.
 */
export const dispenseChargeEvents = pgTable(
  "dispense_charge_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    dispenseChargeId: uuid("dispense_charge_id")
      .notNull()
      .references(() => dispenseChargeQueue.id),
    prescriptionEventId: uuid("prescription_event_id")
      .notNull()
      .references(() => prescriptionEvents.id),
    sequence: integer("sequence").notNull(),
    operationId: uuid("operation_id").notNull(),
    eventType: dispenseChargeEventTypeEnum("event_type").notNull(),
    transitionSource:
      dispenseChargeTransitionSourceEnum("transition_source").notNull(),
    statusBefore: dispenseChargeStatusEnum("status_before"),
    statusAfter: dispenseChargeStatusEnum("status_after").notNull(),
    // Historical snapshots deliberately do not carry foreign keys. An invoice
    // line may be soft-deleted as the exact action that reopens this charge;
    // the immutable evidence must outlive that mutable projection.
    invoiceId: uuid("invoice_id"),
    invoiceItemId: uuid("invoice_item_id"),
    actorId: uuid("actor_id").references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    reason: text("reason"),
  },
  (table) => ({
    chargeHistoryIdx: index("dispense_charge_events_charge_history_idx").on(
      table.practiceId,
      table.dispenseChargeId,
      table.createdAt,
      table.id,
    ),
    practiceTimeIdx: index("dispense_charge_events_practice_time_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    chargeSequenceUq: uniqueIndex(
      "dispense_charge_events_charge_sequence_uq",
    ).on(table.practiceId, table.dispenseChargeId, table.sequence),
    operationUq: uniqueIndex(
      "dispense_charge_events_practice_charge_operation_uq",
    ).on(
      table.practiceId,
      table.dispenseChargeId,
      table.operationId,
      table.eventType,
    ),
    chargeTenantFk: foreignKey({
      columns: [table.practiceId, table.dispenseChargeId],
      foreignColumns: [dispenseChargeQueue.practiceId, dispenseChargeQueue.id],
      name: "dispense_charge_events_practice_charge_fk",
    }),
    prescriptionEventTenantFk: foreignKey({
      columns: [table.practiceId, table.prescriptionEventId],
      foreignColumns: [prescriptionEvents.practiceId, prescriptionEvents.id],
      name: "dispense_charge_events_practice_prescription_event_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "dispense_charge_events_practice_actor_fk",
    }),
    shapeCheck: check(
      "dispense_charge_events_shape_check",
      sql`length(btrim(${table.actorName})) > 0
        and (${table.reason} is null or length(${table.reason}) <= 1000)
        and (
          ${table.eventType} = 'created'
          and ${table.statusBefore} is null
          and ${table.statusAfter} = 'pending'
          and ${table.invoiceId} is null
          and ${table.invoiceItemId} is null
          and ${table.reason} is null
        or ${table.eventType} = 'invoiced'
          and ${table.statusBefore} = 'pending'
          and ${table.statusAfter} = 'invoiced'
          and ${table.invoiceId} is not null
          and ${table.invoiceItemId} is not null
          and ${table.reason} is null
        or ${table.eventType} = 'waived'
          and ${table.statusBefore} = 'pending'
          and ${table.statusAfter} = 'waived'
          and ${table.invoiceId} is null
          and ${table.invoiceItemId} is null
          and length(btrim(coalesce(${table.reason}, ''))) >= 5
        or ${table.eventType} = 'reopened'
          and ${table.statusBefore} in ('invoiced', 'waived')
          and ${table.statusAfter} = 'pending'
          and (
            ${table.statusBefore} = 'invoiced'
            and ${table.invoiceId} is not null
            and ${table.invoiceItemId} is not null
          or ${table.statusBefore} = 'waived'
            and ${table.invoiceId} is null
            and ${table.invoiceItemId} is null
          )
          and length(btrim(coalesce(${table.reason}, ''))) >= 5
        )`,
    ),
  }),
);
