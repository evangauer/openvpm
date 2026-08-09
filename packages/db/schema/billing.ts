import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { locations } from "./practices";
import { clients } from "./clients";
import { patients } from "./patients";
import { appointments } from "./scheduling";
import { users } from "./users";
import { prescriptions } from "./prescriptions";

export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "overdue",
  "void",
]);

export const invoiceItemTypeEnum = pgEnum("invoice_item_type", [
  "service",
  "product",
]);

export const invoiceAdjustmentTypeEnum = pgEnum("invoice_adjustment_type", [
  "credit",
  "write_off",
]);

export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "draft",
  "ordered",
  "received",
]);

export const paymentAccountStatusEnum = pgEnum("payment_account_status", [
  "pending",
  "active",
  "action_required",
  "disabled",
]);

export const practicePaymentAccounts = pgTable(
  "practice_payment_accounts",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    provider: varchar("provider", { length: 32 })
      .notNull()
      .default("stripe_connect"),
    stripeAccountId: varchar("stripe_account_id", { length: 128 }).notNull(),
    onboardingStatus: paymentAccountStatusEnum("onboarding_status")
      .notNull()
      .default("pending"),
    chargesEnabled: boolean("charges_enabled").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    requirementsCurrentlyDue: jsonb("requirements_currently_due").$type<
      string[]
    >(),
    requirementsDisabledReason: varchar("requirements_disabled_reason", {
      length: 255,
    }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => ({
    practiceProviderUq: uniqueIndex(
      "practice_payment_accounts_practice_provider_uq"
    ).on(table.practiceId, table.provider),
    stripeAccountUq: uniqueIndex(
      "practice_payment_accounts_stripe_account_uq"
    ).on(table.stripeAccountId),
    practiceStatusIdx: index("practice_payment_accounts_status_idx").on(
      table.practiceId,
      table.deletedAt,
      table.onboardingStatus
    ),
  })
);

export const services = pgTable(
  "services",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 32 }),
    category: varchar("category", { length: 128 }),
    defaultPrice: numeric("default_price", { precision: 10, scale: 2 }).notNull(),
    taxable: boolean("taxable").notNull().default(true),
  },
  (table) => ({
    practiceNameIdx: index("services_practice_name_idx").on(
      table.practiceId,
      table.deletedAt,
      table.name
    ),
    defaultPriceNonnegative: check(
      "services_default_price_nonnegative",
      sql`${table.defaultPrice} >= 0`
    ),
  })
);

export const invoices = pgTable(
  "invoices",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    patientId: uuid("patient_id").references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    subtotal: numeric("subtotal", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    tax: numeric("tax", { precision: 10, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 10, scale: 2 }).notNull().default("0"),
    paidAmount: numeric("paid_amount", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    dueDate: date("due_date"),
    isEstimate: boolean("is_estimate").notNull().default(false),
  },
  (table) => ({
    practiceIdx: index("invoices_practice_idx").on(
      table.practiceId,
      table.deletedAt,
      table.createdAt
    ),
    clientIdx: index("invoices_client_idx").on(
      table.practiceId,
      table.clientId,
      table.deletedAt,
      table.createdAt
    ),
    patientIdx: index("invoices_patient_idx").on(
      table.practiceId,
      table.patientId,
      table.clientId,
      table.deletedAt
    ),
    appointmentIdx: index("invoices_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
      table.isEstimate,
      table.status
    ),
    activeAppointmentUq: uniqueIndex("invoices_active_appointment_uq")
      .on(table.practiceId, table.appointmentId)
      .where(
        sql`${table.appointmentId} is not null
          and ${table.isEstimate} = false
          and ${table.status} <> 'void'
          and ${table.deletedAt} is null`
      ),
    visitTargetUq: uniqueIndex("invoices_visit_target_uq").on(
      table.practiceId,
      table.appointmentId,
      table.id
    ),
  })
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    ...baseColumns(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    description: varchar("description", { length: 500 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    total: numeric("total", { precision: 10, scale: 2 }).notNull(),
    // Immutable tax treatment captured when the invoice line is written.
    // Catalog changes must never rewrite historical invoice totals.
    taxable: boolean("taxable").notNull().default(true),
    itemType: invoiceItemTypeEnum("item_type").notNull(),
    itemId: uuid("item_id"),
    // A visit-linked prescription already owns the inventory deduction. This
    // source identity lets billing charge it without dispensing the stock a
    // second time.
    sourcePrescriptionId: uuid("source_prescription_id").references(
      (): AnyPgColumn => prescriptions.id
    ),
    // Durable per-dispensation billing identity. Unlike a prescription, this
    // distinguishes the initial fill from every later clinic-stock refill.
    sourceDispenseChargeId: uuid("source_dispense_charge_id"),
  },
  (table) => ({
    invoiceIdx: index("invoice_items_invoice_idx").on(
      table.invoiceId,
      table.deletedAt
    ),
    itemIdx: index("invoice_items_item_idx").on(
      table.itemType,
      table.deletedAt,
      table.itemId
    ),
    sourcePrescriptionIdx: index("invoice_items_source_prescription_idx").on(
      table.sourcePrescriptionId,
      table.deletedAt
    ),
    sourcePrescriptionInvoiceUq: uniqueIndex(
      "invoice_items_source_prescription_invoice_uq"
    )
      .on(table.invoiceId, table.sourcePrescriptionId)
      .where(
        sql`${table.sourcePrescriptionId} is not null and ${table.deletedAt} is null`
      ),
    sourceDispenseChargeIdx: index(
      "invoice_items_source_dispense_charge_idx"
    ).on(table.sourceDispenseChargeId, table.deletedAt),
    sourceDispenseChargeInvoiceUq: uniqueIndex(
      "invoice_items_source_dispense_charge_invoice_uq"
    )
      .on(table.invoiceId, table.sourceDispenseChargeId)
      .where(
        sql`${table.sourceDispenseChargeId} is not null and ${table.deletedAt} is null`
      ),
    invoiceItemTargetUq: uniqueIndex("invoice_items_invoice_item_target_uq").on(
      table.invoiceId,
      table.id
    ),
  })
);

export const invoiceAdjustments = pgTable(
  "invoice_adjustments",
  {
    ...baseColumns(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    type: invoiceAdjustmentTypeEnum("type").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").references(() => users.id),
    operationKey: varchar("operation_key", { length: 160 }),
    balanceAfter: numeric("balance_after", { precision: 10, scale: 2 }),
  },
  (table) => ({
    invoiceIdx: index("invoice_adjustments_invoice_idx").on(
      table.invoiceId,
      table.deletedAt
    ),
    operationKeyUq: uniqueIndex("invoice_adjustments_operation_key_uq").on(
      table.operationKey
    ),
    operationResultCheck: check(
      "invoice_adjustments_operation_result_check",
      sql`(${table.operationKey} is null and ${table.balanceAfter} is null)
        or (${table.operationKey} is not null and ${table.balanceAfter} is not null and ${table.balanceAfter} >= 0)`
    ),
  })
);

export const products = pgTable(
  "products",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    name: varchar("name", { length: 255 }).notNull(),
    sku: varchar("sku", { length: 64 }),
    category: varchar("category", { length: 128 }),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    taxable: boolean("taxable").notNull().default(true),
    costPrice: numeric("cost_price", { precision: 10, scale: 2 }),
    stockQuantity: integer("stock_quantity").notNull().default(0),
    reorderPoint: integer("reorder_point").default(10),
    lotNumber: varchar("lot_number", { length: 64 }),
    expirationDate: date("expiration_date"),
  },
  (table) => ({
    practiceIdx: index("products_practice_idx").on(
      table.practiceId,
      table.deletedAt
    ),
    practiceNameIdx: index("products_practice_name_idx").on(
      table.practiceId,
      table.deletedAt,
      table.name
    ),
    locationIdx: index("products_location_idx").on(
      table.practiceId,
      table.locationId,
      table.deletedAt
    ),
    skuIdx: index("products_sku_idx").on(table.practiceId, table.sku),
    expirationIdx: index("products_expiration_idx").on(
      table.practiceId,
      table.expirationDate,
      table.deletedAt
    ),
    stockAlertIdx: index("products_stock_alert_idx").on(
      table.practiceId,
      table.deletedAt,
      table.stockQuantity
    ),
    practiceIdUq: uniqueIndex("products_practice_id_uq").on(
      table.practiceId,
      table.id
    ),
  })
);

export const suppliers = pgTable(
  "suppliers",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: varchar("name", { length: 255 }).notNull(),
    contactEmail: varchar("contact_email", { length: 255 }),
    phone: varchar("phone", { length: 32 }),
    address: text("address"),
    notes: text("notes"),
  },
  (table) => ({
    practiceNameIdx: index("suppliers_practice_name_idx").on(
      table.practiceId,
      table.deletedAt,
      table.name
    ),
  })
);

export const purchaseOrders = pgTable("purchase_orders", {
  ...baseColumns(),
  practiceId: uuid("practice_id")
    .notNull()
    .references(() => practices.id),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  status: purchaseOrderStatusEnum("status").notNull().default("draft"),
  total: numeric("total", { precision: 10, scale: 2 }).notNull().default("0"),
});

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "credit_card",
  "debit_card",
  "check",
  "online",
  "other",
]);

export const payments = pgTable(
  "payments",
  {
    ...baseColumns(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    method: paymentMethodEnum("method").notNull(),
    receivedBy: uuid("received_by").references(() => users.id),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    externalId: varchar("external_id", { length: 160 }),
    notes: text("notes"),
  },
  (table) => ({
    invoiceIdx: index("payments_invoice_idx").on(
      table.invoiceId,
      table.deletedAt,
      table.receivedAt
    ),
    externalIdUq: uniqueIndex("payments_external_id_uq").on(table.externalId),
  })
);

// Relations
export const servicesRelations = relations(services, ({ one }) => ({
  practice: one(practices, {
    fields: [services.practiceId],
    references: [practices.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  practice: one(practices, {
    fields: [invoices.practiceId],
    references: [practices.id],
  }),
  client: one(clients, {
    fields: [invoices.clientId],
    references: [clients.id],
  }),
  patient: one(patients, {
    fields: [invoices.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [invoices.appointmentId],
    references: [appointments.id],
  }),
  items: many(invoiceItems),
  payments: many(payments),
  adjustments: many(invoiceAdjustments),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceItems.invoiceId],
    references: [invoices.id],
  }),
  sourcePrescription: one(prescriptions, {
    fields: [invoiceItems.sourcePrescriptionId],
    references: [prescriptions.id],
  }),
}));

export const invoiceAdjustmentsRelations = relations(
  invoiceAdjustments,
  ({ one }) => ({
    invoice: one(invoices, {
      fields: [invoiceAdjustments.invoiceId],
      references: [invoices.id],
    }),
    createdByUser: one(users, {
      fields: [invoiceAdjustments.createdBy],
      references: [users.id],
    }),
  })
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, {
    fields: [payments.invoiceId],
    references: [invoices.id],
  }),
  receivedByUser: one(users, {
    fields: [payments.receivedBy],
    references: [users.id],
  }),
}));

export const practicePaymentAccountsRelations = relations(
  practicePaymentAccounts,
  ({ one }) => ({
    practice: one(practices, {
      fields: [practicePaymentAccounts.practiceId],
      references: [practices.id],
    }),
  })
);

export const productsRelations = relations(products, ({ one }) => ({
  practice: one(practices, {
    fields: [products.practiceId],
    references: [practices.id],
  }),
  location: one(locations, {
    fields: [products.locationId],
    references: [locations.id],
  }),
}));

export const suppliersRelations = relations(suppliers, ({ one }) => ({
  practice: one(practices, {
    fields: [suppliers.practiceId],
    references: [practices.id],
  }),
}));

export const purchaseOrdersRelations = relations(
  purchaseOrders,
  ({ one }) => ({
    practice: one(practices, {
      fields: [purchaseOrders.practiceId],
      references: [practices.id],
    }),
    supplier: one(suppliers, {
      fields: [purchaseOrders.supplierId],
      references: [suppliers.id],
    }),
  })
);
