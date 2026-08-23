import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { invoices, payments, practicePaymentAccounts } from "./billing";
import { practices } from "./practices";
import { users } from "./users";

/**
 * Stripe's immutable settlement projection for one locally recorded payment.
 * Amounts use integer minor units so gross = Stripe fee + OpenVPM fee + clinic
 * net can be proved without floating-point or report-time inference.
 */
export const paymentProcessorSettlements = pgTable(
  "payment_processor_settlements",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("stripe_connect"),
    connectedAccountId: varchar("connected_account_id", {
      length: 128,
    }).notNull(),
    checkoutSessionId: varchar("checkout_session_id", {
      length: 128,
    }).notNull(),
    paymentIntentId: varchar("payment_intent_id", { length: 128 }).notNull(),
    chargeId: varchar("charge_id", { length: 128 }).notNull(),
    balanceTransactionId: varchar("balance_transaction_id", {
      length: 128,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    grossAmountCents: integer("gross_amount_cents").notNull(),
    processorFeeCents: integer("processor_fee_cents").notNull(),
    applicationFeeCents: integer("application_fee_cents").notNull(),
    clinicNetCents: integer("clinic_net_cents").notNull(),
    balanceStatus: varchar("balance_status", { length: 24 }).notNull(),
    availableOn: timestamp("available_on", { withTimezone: true }),
    payoutId: varchar("payout_id", { length: 128 }),
    payoutStatus: varchar("payout_status", { length: 24 })
      .notNull()
      .default("unassigned"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    paymentUq: uniqueIndex("payment_processor_settlements_payment_uq").on(
      table.paymentId,
    ),
    checkoutUq: uniqueIndex("payment_processor_settlements_checkout_uq").on(
      table.provider,
      table.connectedAccountId,
      table.checkoutSessionId,
    ),
    chargeUq: uniqueIndex("payment_processor_settlements_charge_uq").on(
      table.provider,
      table.connectedAccountId,
      table.chargeId,
    ),
    balanceTransactionUq: uniqueIndex(
      "payment_processor_settlements_balance_transaction_uq",
    ).on(table.provider, table.connectedAccountId, table.balanceTransactionId),
    practiceDateIdx: index(
      "payment_processor_settlements_practice_date_idx",
    ).on(table.practiceId, table.reconciledAt),
    payoutIdx: index("payment_processor_settlements_payout_idx").on(
      table.practiceId,
      table.payoutId,
      table.payoutStatus,
    ),
    practiceIdUq: uniqueIndex(
      "payment_processor_settlements_practice_id_uq",
    ).on(table.practiceId, table.id),
    tenantPaymentUq: uniqueIndex(
      "payment_processor_settlements_tenant_payment_uq",
    ).on(table.practiceId, table.id, table.paymentId),
    invoiceTenantFk: foreignKey({
      columns: [table.practiceId, table.invoiceId],
      foreignColumns: [invoices.practiceId, invoices.id],
      name: "payment_processor_settlements_invoice_tenant_fk",
    }),
    paymentInvoiceFk: foreignKey({
      columns: [table.invoiceId, table.paymentId],
      foreignColumns: [payments.invoiceId, payments.id],
      name: "payment_processor_settlements_payment_invoice_fk",
    }),
    accountTenantFk: foreignKey({
      columns: [table.practiceId, table.provider, table.connectedAccountId],
      foreignColumns: [
        practicePaymentAccounts.practiceId,
        practicePaymentAccounts.provider,
        practicePaymentAccounts.stripeAccountId,
      ],
      name: "payment_processor_settlements_account_tenant_fk",
    }),
    currencyCheck: check(
      "payment_processor_settlements_currency_check",
      sql`${table.currency} ~ '^[a-z]{3}$'`,
    ),
    amountsCheck: check(
      "payment_processor_settlements_amounts_check",
      sql`${table.grossAmountCents} > 0
        and ${table.processorFeeCents} >= 0
        and ${table.applicationFeeCents} >= 0
        and ${table.clinicNetCents} >= 0
        and ${table.grossAmountCents} = ${table.processorFeeCents} + ${table.applicationFeeCents} + ${table.clinicNetCents}`,
    ),
    statusCheck: check(
      "payment_processor_settlements_status_check",
      sql`${table.balanceStatus} in ('pending', 'available')
        and ${table.payoutStatus} in ('unassigned', 'pending', 'paid', 'failed', 'canceled')`,
    ),
  }),
);

/** Stripe refund evidence tied to the local negative payment entry. */
export const paymentProcessorRefunds = pgTable(
  "payment_processor_refunds",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    settlementId: uuid("settlement_id").references(
      () => paymentProcessorSettlements.id,
    ),
    originalPaymentId: uuid("original_payment_id")
      .notNull()
      .references(() => payments.id),
    refundPaymentId: uuid("refund_payment_id")
      .notNull()
      .references(() => payments.id),
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("stripe_connect"),
    connectedAccountId: varchar("connected_account_id", { length: 128 }),
    externalRefundId: varchar("external_refund_id", {
      length: 128,
    }).notNull(),
    balanceTransactionId: varchar("balance_transaction_id", { length: 128 }),
    currency: varchar("currency", { length: 3 }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    balanceAmountCents: integer("balance_amount_cents"),
    balanceFeeCents: integer("balance_fee_cents"),
    balanceNetCents: integer("balance_net_cents"),
    status: varchar("status", { length: 24 }).notNull(),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
    }).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    refundPaymentUq: uniqueIndex("payment_processor_refunds_payment_uq").on(
      table.refundPaymentId,
    ),
    externalUq: uniqueIndex("payment_processor_refunds_external_uq").on(
      table.provider,
      table.externalRefundId,
    ),
    practiceDateIdx: index("payment_processor_refunds_practice_date_idx").on(
      table.practiceId,
      table.providerCreatedAt,
    ),
    settlementPaymentTenantFk: foreignKey({
      columns: [table.practiceId, table.settlementId, table.originalPaymentId],
      foreignColumns: [
        paymentProcessorSettlements.practiceId,
        paymentProcessorSettlements.id,
        paymentProcessorSettlements.paymentId,
      ],
      name: "payment_processor_refunds_settlement_payment_tenant_fk",
    }),
    accountTenantFk: foreignKey({
      columns: [table.practiceId, table.provider, table.connectedAccountId],
      foreignColumns: [
        practicePaymentAccounts.practiceId,
        practicePaymentAccounts.provider,
        practicePaymentAccounts.stripeAccountId,
      ],
      name: "payment_processor_refunds_account_tenant_fk",
    }),
    amountCheck: check(
      "payment_processor_refunds_amount_check",
      sql`${table.amountCents} > 0
        and ${table.currency} ~ '^[a-z]{3}$'
        and (${table.balanceAmountCents} is null or ${table.balanceAmountCents} <= 0)
        and (${table.balanceFeeCents} is null or ${table.balanceFeeCents} >= 0)
        and (${table.balanceNetCents} is null or ${table.balanceNetCents} <= 0)`,
    ),
    statusCheck: check(
      "payment_processor_refunds_status_check",
      sql`${table.status} in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')`,
    ),
  }),
);

/** Actual bank payout activity for a clinic-owned Stripe account. */
export const paymentProcessorPayouts = pgTable(
  "payment_processor_payouts",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("stripe_connect"),
    connectedAccountId: varchar("connected_account_id", {
      length: 128,
    }).notNull(),
    externalPayoutId: varchar("external_payout_id", {
      length: 128,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    automatic: boolean("automatic").notNull(),
    reconciliationComplete: boolean("reconciliation_complete")
      .notNull()
      .default(false),
    arrivalAt: timestamp("arrival_at", { withTimezone: true }).notNull(),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
    }).notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    failureMessage: varchar("failure_message", { length: 500 }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    externalUq: uniqueIndex("payment_processor_payouts_external_uq").on(
      table.provider,
      table.connectedAccountId,
      table.externalPayoutId,
    ),
    practiceDateIdx: index("payment_processor_payouts_practice_date_idx").on(
      table.practiceId,
      table.providerCreatedAt,
      table.status,
    ),
    accountTenantFk: foreignKey({
      columns: [table.practiceId, table.provider, table.connectedAccountId],
      foreignColumns: [
        practicePaymentAccounts.practiceId,
        practicePaymentAccounts.provider,
        practicePaymentAccounts.stripeAccountId,
      ],
      name: "payment_processor_payouts_account_tenant_fk",
    }),
    amountCheck: check(
      "payment_processor_payouts_amount_check",
      sql`${table.amountCents} > 0 and ${table.currency} ~ '^[a-z]{3}$'`,
    ),
    statusCheck: check(
      "payment_processor_payouts_status_check",
      sql`${table.status} in ('pending', 'in_transit', 'paid', 'failed', 'canceled')`,
    ),
  }),
);

/** Current Stripe dispute state, retained even after it is won or lost. */
export const paymentDisputes = pgTable(
  "payment_disputes",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => paymentProcessorSettlements.id),
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("stripe_connect"),
    externalDisputeId: varchar("external_dispute_id", {
      length: 128,
    }).notNull(),
    chargeId: varchar("charge_id", { length: 128 }).notNull(),
    status: varchar("status", { length: 48 }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    reason: varchar("reason", { length: 64 }),
    evidenceDueBy: timestamp("evidence_due_by", { withTimezone: true }),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
    }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    externalUq: uniqueIndex("payment_disputes_external_uq").on(
      table.provider,
      table.externalDisputeId,
    ),
    practiceStatusIdx: index("payment_disputes_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.providerCreatedAt,
    ),
    settlementTenantFk: foreignKey({
      columns: [table.practiceId, table.settlementId],
      foreignColumns: [
        paymentProcessorSettlements.practiceId,
        paymentProcessorSettlements.id,
      ],
      name: "payment_disputes_settlement_tenant_fk",
    }),
    amountCheck: check(
      "payment_disputes_amount_check",
      sql`${table.amountCents} > 0 and ${table.currency} ~ '^[a-z]{3}$'`,
    ),
  }),
);

/**
 * Immutable clinic-day close. Later refunds/disputes appear on later closes;
 * the historical snapshot is never rewritten to hide what staff closed.
 */
export const financialCloses = pgTable(
  "financial_closes",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    businessDate: date("business_date").notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    closedBy: uuid("closed_by")
      .notNull()
      .references(() => users.id),
    paymentCount: integer("payment_count").notNull(),
    grossReceiptsCents: integer("gross_receipts_cents").notNull(),
    refundsCents: integer("refunds_cents").notNull(),
    netReceiptsCents: integer("net_receipts_cents").notNull(),
    cashCents: integer("cash_cents").notNull(),
    checkCents: integer("check_cents").notNull(),
    cardAndOnlineCents: integer("card_and_online_cents").notNull(),
    otherCents: integer("other_cents").notNull(),
    processorGrossCents: integer("processor_gross_cents").notNull(),
    processorFeeCents: integer("processor_fee_cents").notNull(),
    applicationFeeCents: integer("application_fee_cents").notNull(),
    clinicNetCents: integer("clinic_net_cents").notNull(),
    paidOutCents: integer("paid_out_cents").notNull(),
    openDisputeCents: integer("open_dispute_cents").notNull(),
    unreconciledCount: integer("unreconciled_count").notNull(),
  },
  (table) => ({
    practiceDayUq: uniqueIndex("financial_closes_practice_day_uq").on(
      table.practiceId,
      table.businessDate,
    ),
    practiceCutoffIdx: index("financial_closes_practice_cutoff_idx").on(
      table.practiceId,
      table.cutoffAt,
    ),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.closedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "financial_closes_actor_tenant_fk",
    }),
    countsCheck: check(
      "financial_closes_counts_check",
      sql`${table.paymentCount} >= 0 and ${table.unreconciledCount} >= 0`,
    ),
    nonnegativeCheck: check(
      "financial_closes_nonnegative_check",
      sql`${table.grossReceiptsCents} >= 0
        and ${table.refundsCents} >= 0
        and ${table.processorGrossCents} >= 0
        and ${table.processorFeeCents} >= 0
        and ${table.applicationFeeCents} >= 0
        and ${table.clinicNetCents} >= 0
        and ${table.paidOutCents} >= 0
        and ${table.openDisputeCents} >= 0`,
    ),
    receiptIdentityCheck: check(
      "financial_closes_receipt_identity_check",
      sql`${table.netReceiptsCents} = ${table.grossReceiptsCents} - ${table.refundsCents}`,
    ),
    processorIdentityCheck: check(
      "financial_closes_processor_identity_check",
      sql`${table.processorGrossCents} = ${table.processorFeeCents} + ${table.applicationFeeCents} + ${table.clinicNetCents}`,
    ),
  }),
);
