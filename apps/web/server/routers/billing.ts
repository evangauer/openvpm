import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  eq,
  and,
  isNull,
  isNotNull,
  desc,
  sql,
  inArray,
  ilike,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  computeStockDeductions,
  type DispensableItem,
} from "@/lib/inventory/dispense";
import { appBaseUrl } from "@/lib/app-url";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import { stripeConfigured } from "@/lib/stripe-config";
import {
  createCheckoutSession,
  createConnectAccount,
  createConnectAccountLink,
  createConnectLoginLink,
  refundStripeCheckoutPayment,
  retrieveConnectAccount,
} from "@/lib/stripe";
import { billingEnforced } from "@/lib/billing/plans";
import {
  centsToMoney,
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import {
  calculateInvoiceTaxTotals,
  InvoiceTaxCalculationError,
} from "@/lib/billing/invoice-tax";
import {
  STRIPE_CONNECT_PROVIDER,
  stripeConnectAccountState,
  stripeConnectApplicationFeeAmount,
} from "@/lib/billing/payment-accounts";
import {
  deliverClientReceipt,
  loadClientReceipt,
} from "@/lib/billing/client-receipts";
import {
  BILLING_ADJUSTMENT_REASON_MAX_LENGTH,
  BILLING_CURRENCY_AMOUNT_PATTERN,
  BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH,
  BILLING_INVOICE_LINE_QUANTITY_MAX,
  BILLING_INVOICE_LINE_QUANTITY_MIN,
  BILLING_INVOICE_MAX_ITEMS,
  BILLING_INVOICE_SEARCH_MAX_LENGTH,
  BILLING_MAX_MONEY_CENTS,
  BILLING_NOTES_MAX_LENGTH,
  BILLING_SERVICE_CATEGORY_MAX_LENGTH,
  BILLING_SERVICE_CODE_MAX_LENGTH,
  BILLING_SERVICE_NAME_MAX_LENGTH,
} from "@/lib/billing/policy";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { POSTGRES_INTEGER_MAX } from "./storage-bounds";
import type { Database } from "@openpims/db/client";
import {
  invoices,
  invoiceAdjustments,
  invoiceItems,
  services,
  products,
  clients,
  patients,
  payments,
  practicePaymentAccounts,
  users,
  practices,
  appointments,
  prescriptions,
  visitCloseouts,
  visitWorkItems,
  dispenseChargeQueue,
  auditLog,
} from "@openpims/db";
import {
  clinicalDateInput,
  clinicalTextInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { listOffsetInput } from "./pagination";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  assertVisitInvoiceReadyForFinancialAction,
  assertVisitReconciliationMutable,
  markCompletedVisitCloseoutPaid,
} from "../visit-billing-integrity";

type BillingDb = Pick<Database, "select" | "insert" | "update" | "execute">;
type ServiceCatalogDb = Pick<Database, "select" | "execute">;

type BillingContext = {
  db: BillingDb;
  practiceId: string;
};

type InvoiceForPayment = {
  id: string;
  total: string | null;
  paidAmount: string | null;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  isEstimate: boolean;
  appointmentId?: string | null;
  dueDate?: string | null;
};

type InvoiceAdjustmentType = "credit" | "write_off";
type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

async function assertInvoiceItemsNotReconciled(
  ctx: BillingContext,
  invoiceId: string
) {
  const rows = await ctx.db.execute(sql`
    select ${visitWorkItems.id}
    from ${visitWorkItems}
    where ${visitWorkItems.practiceId} = ${ctx.practiceId}
      and ${visitWorkItems.invoiceId} = ${invoiceId}
      and ${visitWorkItems.status} = 'charged'
      and ${visitWorkItems.deletedAt} is null
    order by ${visitWorkItems.createdAt}, ${visitWorkItems.id}
    limit 1
  `);
  if (rowsFromExecute<{ id: string }>(rows).length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This invoice has charges confirmed against performed work. Correct the reconciliation before changing or voiding its lines.",
    });
  }
}

const allowedInvoiceStatusTransitions: Record<
  InvoiceStatus,
  readonly InvoiceStatus[]
> = {
  draft: ["sent"],
  sent: ["overdue"],
  overdue: ["sent"],
  paid: [],
  void: [],
};

function canTransitionInvoiceStatus(current: InvoiceStatus, next: InvoiceStatus) {
  return current === next || allowedInvoiceStatusTransitions[current].includes(next);
}

type PaymentAccountRow = typeof practicePaymentAccounts.$inferSelect;

const billingAdminProcedure = protectedProcedure.use(requireRole("admin"));

const invoiceStatusSchema = z.enum([
  "draft",
  "sent",
  "paid",
  "overdue",
  "void",
]);

const currencyAmountSchema = z.string().trim().refine((value) => {
  return BILLING_CURRENCY_AMOUNT_PATTERN.test(value);
}, "Amount must be a valid currency amount.");

const paymentAmountSchema = currencyAmountSchema.refine((value) => {
  return moneyToCents(value) > 0;
}, "Amount must be greater than zero.");

const nonNegativeMoneySchema = currencyAmountSchema;

const optionalServiceTextInput = (label: string, max: number) =>
  optionalClinicalTextInput(label, max).transform(
    (value) => value || undefined
  );

const servicePriceInput = nonNegativeMoneySchema.transform((value) =>
  centsToMoney(moneyToCents(value))
);

const serviceInput = z.object({
  name: clinicalTextInput("Service name", BILLING_SERVICE_NAME_MAX_LENGTH),
  code: optionalServiceTextInput(
    "Service code",
    BILLING_SERVICE_CODE_MAX_LENGTH
  ),
  category: optionalServiceTextInput(
    "Service category",
    BILLING_SERVICE_CATEGORY_MAX_LENGTH
  ),
  defaultPrice: servicePriceInput,
  taxable: z.boolean().default(true),
});

type ServiceSnapshot = z.infer<typeof serviceInput>;

function serviceSnapshotConditions(expected: ServiceSnapshot) {
  return [
    eq(services.name, expected.name),
    expected.code === undefined
      ? isNull(services.code)
      : eq(services.code, expected.code),
    expected.category === undefined
      ? isNull(services.category)
      : eq(services.category, expected.category),
    eq(services.defaultPrice, expected.defaultPrice),
    eq(services.taxable, expected.taxable),
  ];
}

async function lockServiceCatalog(
  database: ServiceCatalogDb,
  practiceId: string
) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`service-catalog:${practiceId}`}::text))`
  );
}

async function assertServiceIdentityAvailable(
  database: ServiceCatalogDb,
  practiceId: string,
  input: ServiceSnapshot,
  excludeId?: string
) {
  const [collision] = await database
    .select({ id: services.id })
    .from(services)
    .where(
      and(
        eq(services.practiceId, practiceId),
        isNull(services.deletedAt),
        excludeId ? ne(services.id, excludeId) : undefined,
        or(
          sql`lower(${services.name}) = lower(${input.name})`,
          input.code
            ? sql`lower(${services.code}) = lower(${input.code})`
            : undefined
        )
      )
    )
    .limit(1);

  if (collision) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "An active service already uses that name or code. Edit or archive it before continuing.",
    });
  }
}

const billingNotesInput = optionalClinicalTextInput(
  "Notes",
  BILLING_NOTES_MAX_LENGTH
);
const invoiceSearchInput = optionalClinicalTextInput(
  "Search",
  BILLING_INVOICE_SEARCH_MAX_LENGTH
);
const invoiceLineInput = z
  .object({
    description: clinicalTextInput(
      "Line item description",
      BILLING_INVOICE_LINE_DESCRIPTION_MAX_LENGTH
    ),
    quantity: z
      .number()
      .int()
      .min(BILLING_INVOICE_LINE_QUANTITY_MIN)
      .max(BILLING_INVOICE_LINE_QUANTITY_MAX),
    unitPrice: nonNegativeMoneySchema,
    itemType: z.enum(["service", "product"]),
    itemId: z.string().uuid().optional(),
    sourcePrescriptionId: z.string().uuid().optional(),
    sourceDispenseChargeId: z.string().uuid().optional(),
  })
  .superRefine((item, ctx) => {
    const totalCents = moneyToCents(item.unitPrice) * item.quantity;
    if (totalCents > BILLING_MAX_MONEY_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unitPrice"],
        message: "Line item total must fit a currency amount.",
      });
    }
    if (
      (item.sourcePrescriptionId || item.sourceDispenseChargeId) &&
      (item.itemType !== "product" || !item.itemId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourcePrescriptionId"],
        message: "A prescription charge must reference its dispensed product.",
      });
    }
    if (item.sourcePrescriptionId && item.sourceDispenseChargeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceDispenseChargeId"],
        message: "Choose one medication dispense source for this line.",
      });
    }
  });

const createInvoiceInput = z
  .object({
    clientId: z.string().uuid(),
    patientId: z.string().uuid().optional(),
    appointmentId: z.string().uuid().optional(),
    items: z
      .array(invoiceLineInput)
      .max(
        BILLING_INVOICE_MAX_ITEMS,
        `Invoices can include at most ${BILLING_INVOICE_MAX_ITEMS} items.`
      ),
    dueDate: clinicalDateInput("Due date").optional(),
    isEstimate: z.boolean().optional().default(false),
  })
  .superRefine((input, ctx) => {
    const subtotalCents = input.items.reduce(
      (sum, item) => sum + moneyToCents(item.unitPrice) * item.quantity,
      0
    );
    if (subtotalCents > BILLING_MAX_MONEY_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Invoice subtotal must fit a currency amount.",
      });
    }
  });

const updateInvoiceItemsInput = z
  .object({
    id: z.string().uuid(),
    expectedUpdatedAt: z.date(),
    items: z
      .array(invoiceLineInput)
      .min(1, "An invoice must include at least one line item.")
      .max(
        BILLING_INVOICE_MAX_ITEMS,
        `Invoices can include at most ${BILLING_INVOICE_MAX_ITEMS} items.`
      ),
  })
  .superRefine((input, ctx) => {
    const subtotalCents = input.items.reduce(
      (sum, item) => sum + moneyToCents(item.unitPrice) * item.quantity,
      0
    );
    if (subtotalCents > BILLING_MAX_MONEY_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Invoice subtotal must fit a currency amount.",
      });
    }
  });

type InvoiceLineInput = {
  description: string;
  quantity: number;
  unitPrice: string;
  itemType: "service" | "product";
  itemId?: string | null;
  sourcePrescriptionId?: string | null;
  sourceDispenseChargeId?: string | null;
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: BillingContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);
  if (!practice) throw practiceNotFound();
}

async function throwServiceMutationMiss(
  ctx: BillingContext,
  serviceId: string
): Promise<never> {
  const [current] = await ctx.db
    .select({ id: services.id })
    .from(services)
    .where(
      and(
        eq(services.id, serviceId),
        eq(services.practiceId, ctx.practiceId),
        isNull(services.deletedAt)
      )
    )
    .limit(1);

  if (current) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Service changed. Refresh and try again.",
    });
  }

  throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
}

async function throwArchivedServiceMutationMiss(
  ctx: BillingContext,
  serviceId: string
): Promise<never> {
  const [current] = await ctx.db
    .select({ id: services.id })
    .from(services)
    .where(
      and(
        eq(services.id, serviceId),
        eq(services.practiceId, ctx.practiceId),
        isNotNull(services.deletedAt)
      )
    )
    .limit(1);

  if (current) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Service changed. Refresh and try again.",
    });
  }

  throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
}

async function getInvoiceForPractice(
  ctx: BillingContext,
  invoiceId: string
): Promise<InvoiceForPayment> {
  const [invoice] = await ctx.db
    .select({
      id: invoices.id,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      status: invoices.status,
      isEstimate: invoices.isEstimate,
      appointmentId: invoices.appointmentId,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.practiceId, ctx.practiceId),
        isNull(invoices.deletedAt)
      )
    )
    .limit(1);

  if (!invoice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
  }

  return invoice;
}

function assertCanRecordPayment(invoice: InvoiceForPayment) {
  if (invoice.isEstimate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Convert the estimate to an invoice before recording payment.",
    });
  }
  if (invoice.status === "void") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot record payment on a void invoice.",
    });
  }
  if (invoice.status === "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Mark the invoice as sent before recording payment.",
    });
  }
  if (invoice.status === "paid") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invoice is already paid.",
    });
  }
}

function assertCanAdjustInvoice(invoice: InvoiceForPayment) {
  if (invoice.isEstimate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Convert the estimate to an invoice before applying an adjustment.",
    });
  }
  if (invoice.status === "void") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot adjust a void invoice.",
    });
  }
  if (invoice.status === "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Mark the invoice as sent before applying an adjustment.",
    });
  }
  if (invoice.status === "paid") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invoice is already paid.",
    });
  }
}

function assertCanConvertEstimate(invoice: InvoiceForPayment) {
  if (!invoice.isEstimate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invoice is not an estimate.",
    });
  }
  if (invoice.status === "void") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot convert a void estimate.",
    });
  }
  if (invoice.status === "paid" || invoice.status === "overdue") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Only draft or sent estimates can be converted.",
    });
  }
  if (moneyToCents(invoice.paidAmount) > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot convert an estimate with payments.",
    });
  }
}

function invoiceItemPracticeScope(ctx: BillingContext): SQL {
  return sql`exists (
    select 1
    from ${invoices}
    where ${invoices.id} = ${invoiceItems.invoiceId}
      and ${invoices.practiceId} = ${ctx.practiceId}
      and ${invoices.deletedAt} is null
  )`;
}

function paymentPracticeScope(ctx: BillingContext): SQL {
  return sql`exists (
    select 1
    from ${invoices}
    where ${invoices.id} = ${payments.invoiceId}
      and ${invoices.practiceId} = ${ctx.practiceId}
      and ${invoices.deletedAt} is null
  )`;
}

function adjustmentPracticeScope(ctx: BillingContext): SQL {
  return sql`exists (
    select 1
    from ${invoices}
    where ${invoices.id} = ${invoiceAdjustments.invoiceId}
      and ${invoices.practiceId} = ${ctx.practiceId}
      and ${invoices.deletedAt} is null
  )`;
}

function noActivePaymentsForInvoice(): SQL {
  return sql`not exists (
    select 1
    from ${payments}
    where ${payments.invoiceId} = ${invoices.id}
      and ${payments.deletedAt} is null
  )`;
}

function noActiveAdjustmentsForInvoice(): SQL {
  return sql`not exists (
    select 1
    from ${invoiceAdjustments}
    where ${invoiceAdjustments.invoiceId} = ${invoices.id}
      and ${invoiceAdjustments.deletedAt} is null
  )`;
}

function invoiceAdjustmentTotalMatches(expectedCents: number): SQL {
  return sql`coalesce((
    select sum(${invoiceAdjustments.amount})
    from ${invoiceAdjustments}
    where ${invoiceAdjustments.invoiceId} = ${invoices.id}
      and ${invoiceAdjustments.deletedAt} is null
  ), 0) = ${centsToMoney(expectedCents)}::numeric`;
}

async function listInvoiceAdjustmentRows(ctx: BillingContext, invoiceId: string) {
  return ctx.db
    .select({
      amount: invoiceAdjustments.amount,
      type: invoiceAdjustments.type,
    })
    .from(invoiceAdjustments)
    .where(
      and(
        eq(invoiceAdjustments.invoiceId, invoiceId),
        adjustmentPracticeScope(ctx),
        isNull(invoiceAdjustments.deletedAt)
      )
    );
}

async function getInvoiceAdjustmentTotalCents(
  ctx: BillingContext,
  invoiceId: string
): Promise<number> {
  const rows = await listInvoiceAdjustmentRows(ctx, invoiceId);
  return rows.reduce((sum, row) => sum + moneyToCents(row.amount), 0);
}

function normalizeRequirements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function serializePaymentAccountStatus(row: PaymentAccountRow | null) {
  if (!row) {
    return {
      status: "not_started" as const,
      enabled: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: [] as string[],
      requirementsDisabledReason: null as string | null,
      lastSyncedAt: null as Date | null,
    };
  }

  return {
    status: row.onboardingStatus,
    enabled:
      row.onboardingStatus === "active" &&
      row.chargesEnabled &&
      row.payoutsEnabled,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    detailsSubmitted: row.detailsSubmitted,
    requirementsCurrentlyDue: normalizeRequirements(
      row.requirementsCurrentlyDue
    ),
    requirementsDisabledReason: row.requirementsDisabledReason,
    lastSyncedAt: row.lastSyncedAt,
  };
}

async function getStripeConnectPaymentAccount(
  ctx: BillingContext
): Promise<PaymentAccountRow | null> {
  const [account] = await ctx.db
    .select()
    .from(practicePaymentAccounts)
    .where(
      and(
        eq(practicePaymentAccounts.practiceId, ctx.practiceId),
        eq(practicePaymentAccounts.provider, STRIPE_CONNECT_PROVIDER),
        isNull(practicePaymentAccounts.deletedAt)
      )
    )
    .limit(1);

  return account ?? null;
}

async function upsertStripeConnectPaymentAccount(
  ctx: BillingContext,
  account: { id: string } & Parameters<typeof stripeConnectAccountState>[0]
) {
  const state = stripeConnectAccountState(account);
  const [row] = await ctx.db
    .insert(practicePaymentAccounts)
    .values({
      practiceId: ctx.practiceId,
      provider: STRIPE_CONNECT_PROVIDER,
      stripeAccountId: account.id,
      onboardingStatus: state.onboardingStatus,
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      detailsSubmitted: state.detailsSubmitted,
      requirementsCurrentlyDue: state.requirementsCurrentlyDue,
      requirementsDisabledReason: state.requirementsDisabledReason,
      lastSyncedAt: state.lastSyncedAt,
    })
    .onConflictDoUpdate({
      target: [
        practicePaymentAccounts.practiceId,
        practicePaymentAccounts.provider,
      ],
      set: {
        stripeAccountId: account.id,
        onboardingStatus: state.onboardingStatus,
        chargesEnabled: state.chargesEnabled,
        payoutsEnabled: state.payoutsEnabled,
        detailsSubmitted: state.detailsSubmitted,
        requirementsCurrentlyDue: state.requirementsCurrentlyDue,
        requirementsDisabledReason: state.requirementsDisabledReason,
        lastSyncedAt: state.lastSyncedAt,
        deletedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

function assertActiveStripeConnectAccount(row: PaymentAccountRow | null) {
  const status = serializePaymentAccountStatus(row);
  if (!status.enabled) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Client card payments require completed Stripe Connect setup for this clinic.",
    });
  }
  return row!;
}

function adjustmentLabel(type: InvoiceAdjustmentType): string {
  return type === "write_off" ? "write-off" : "credit";
}

async function assertClientBelongsToPractice(
  ctx: BillingContext,
  clientId: string
) {
  const [client] = await ctx.db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.practiceId, ctx.practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);

  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }
}

async function assertPatientBelongsToClient(
  ctx: BillingContext,
  patientId: string,
  clientId: string
) {
  const [patient] = await ctx.db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.clientId, clientId),
        eq(patients.practiceId, ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Patient not found for this client",
    });
  }
}

async function assertAppointmentBelongsToClientPatient(
  ctx: BillingContext,
  appointmentId: string,
  clientId: string,
  patientId?: string
) {
  const conditions = [
    eq(appointments.id, appointmentId),
    eq(appointments.practiceId, ctx.practiceId),
    eq(appointments.clientId, clientId),
    isNull(appointments.deletedAt),
  ];
  if (patientId) {
    conditions.push(eq(appointments.patientId, patientId));
  }

  const [appointment] = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(...conditions))
    .limit(1);

  if (!appointment) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Appointment not found for this client and patient.",
    });
  }

  return appointment;
}

async function lockAppointmentForVisitBilling(
  ctx: BillingContext,
  appointmentId: string,
  clientId: string,
  patientId: string | undefined,
  isEstimate: boolean
) {
  const conditions = [
    eq(appointments.id, appointmentId),
    eq(appointments.practiceId, ctx.practiceId),
    eq(appointments.clientId, clientId),
    isNull(appointments.deletedAt),
  ];
  if (patientId) conditions.push(eq(appointments.patientId, patientId));

  const [appointment] = await ctx.db
    .select({ id: appointments.id, status: appointments.status })
    .from(appointments)
    .where(and(...conditions))
    .for("update");
  if (!appointment) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Appointment not found for this client and patient.",
    });
  }
  if (!isEstimate && appointment.status !== "in_exam") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Start the exam before capturing visit charges.",
    });
  }
  if (
    isEstimate &&
    (appointment.status === "checked_out" ||
      appointment.status === "cancelled" ||
      appointment.status === "no_show")
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A terminal appointment cannot receive a new estimate.",
    });
  }
  return appointment;
}

async function assertInvoiceNotCompletedCloseout(
  ctx: BillingContext,
  invoiceId: string
) {
  const [closeout] = await ctx.db
    .select({ id: visitCloseouts.id })
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.invoiceId, invoiceId),
        eq(visitCloseouts.practiceId, ctx.practiceId),
        eq(visitCloseouts.status, "completed"),
        isNull(visitCloseouts.deletedAt)
      )
    )
    .limit(1);
  if (closeout) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This invoice is part of a completed visit. Reconcile it through an attributed closeout amendment.",
    });
  }
}

async function lockAppointmentForInvoiceMutation(
  ctx: BillingContext,
  appointmentId: string | null | undefined
) {
  if (!appointmentId) return;
  const [appointment] = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.practiceId, ctx.practiceId),
        isNull(appointments.deletedAt)
      )
    )
    .for("update");
  if (!appointment) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The linked appointment is no longer available.",
    });
  }
}

async function assertLineItemReferences(
  ctx: BillingContext,
  items: readonly InvoiceLineInput[],
  options: {
    previousItems?: readonly DispensableItem[];
    lockProductsForStock?: boolean;
  } = {}
) {
  const quantitiesFor = (
    source: readonly DispensableItem[],
    itemType: DispensableItem["itemType"]
  ) => {
    const quantities = new Map<string, number>();
    for (const item of source) {
      if (item.itemType !== itemType || !item.itemId) continue;
      quantities.set(
        item.itemId,
        (quantities.get(item.itemId) ?? 0) + item.quantity
      );
    }
    return quantities;
  };

  const serviceQuantities = quantitiesFor(items, "service");
  const productQuantities = quantitiesFor(items, "product");
  const serviceIds = [...serviceQuantities.keys()].sort();
  const productIds = [...productQuantities.keys()].sort();

  // Lock in a stable service-then-product order. The lock and lifecycle check
  // must stay in the invoice transaction so a catalog row cannot be archived
  // after validation but before the invoice lines are written.
  const serviceRows =
    serviceIds.length === 0
      ? []
      : await ctx.db
          .select({
            id: services.id,
            deletedAt: services.deletedAt,
            taxable: services.taxable,
          })
          .from(services)
          .where(
            and(
              inArray(services.id, serviceIds),
              eq(services.practiceId, ctx.practiceId)
            )
          )
          .orderBy(services.id)
          .for("share");

  let productRows: Array<{
    id: string;
    deletedAt: Date | null;
    taxable: boolean;
  }> = [];
  if (productIds.length > 0) {
    const productQuery = ctx.db
      .select({
        id: products.id,
        deletedAt: products.deletedAt,
        taxable: products.taxable,
      })
      .from(products)
      .where(
        and(
          inArray(products.id, productIds),
          eq(products.practiceId, ctx.practiceId)
        )
      )
      .orderBy(products.id);
    productRows = options.lockProductsForStock
      ? await productQuery.for("update")
      : await productQuery.for("share");
  }

  if (serviceRows.length !== serviceIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more services were not found",
    });
  }
  const previousServiceQuantities = quantitiesFor(
    options.previousItems ?? [],
    "service"
  );
  if (
    serviceRows.some(
      (row) =>
        row.deletedAt != null &&
        (serviceQuantities.get(row.id) ?? 0) >
          (previousServiceQuantities.get(row.id) ?? 0)
    )
  ) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more services were not found",
    });
  }
  if (
    productRows.length !== productIds.length ||
    productRows.some((row) => row.deletedAt != null)
  ) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more products were not found",
    });
  }

  return new Map<string, boolean>([
    ...serviceRows.map(
      (row) => [`service:${row.id}`, row.taxable ?? true] as const,
    ),
    ...productRows.map(
      (row) => [`product:${row.id}`, row.taxable ?? true] as const,
    ),
  ]);
}

function invoiceLineTaxable(
  item: Pick<InvoiceLineInput, "itemType" | "itemId">,
  taxabilityByReference: ReadonlyMap<string, boolean>,
): boolean {
  // Ad-hoc lines have no catalog source. Defaulting them to taxable preserves
  // the historical behavior and prevents clients from choosing tax treatment.
  if (!item.itemId) return true;
  const taxable = taxabilityByReference.get(`${item.itemType}:${item.itemId}`);
  if (taxable === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more invoice catalog references were not found",
    });
  }
  return taxable;
}

function invoiceLineTaxTotals(
  items: readonly (Pick<
    InvoiceLineInput,
    "itemType" | "itemId" | "quantity" | "unitPrice"
  > & {
    taxable?: boolean;
  })[],
  taxRatePercent: string,
  taxabilityByReference?: ReadonlyMap<string, boolean>,
) {
  try {
    return calculateInvoiceTaxTotals(
      items.map((item) => ({
        lineTotalCents: moneyToCents(item.unitPrice) * item.quantity,
        taxable:
          item.taxable ??
          invoiceLineTaxable(item, taxabilityByReference ?? new Map()),
      })),
      taxRatePercent,
    );
  } catch (error) {
    if (error instanceof InvoiceTaxCalculationError) {
      throw new TRPCError({
        code:
          error.reason === "invalid_tax_rate"
            ? "PRECONDITION_FAILED"
            : "BAD_REQUEST",
        message: error.message,
      });
    }
    throw error;
  }
}

function stockOwnedItems(
  items: readonly InvoiceLineInput[]
): DispensableItem[] {
  return items
    .filter(
      (item) => !item.sourcePrescriptionId && !item.sourceDispenseChargeId,
    )
    .map((item) => ({
      itemType: item.itemType,
      itemId: item.itemId,
      quantity: item.quantity,
    }));
}

async function assertPrescriptionChargeSources(
  ctx: BillingContext,
  items: readonly InvoiceLineInput[],
  options: {
    appointmentId?: string | null;
    patientId?: string | null;
    currentInvoiceId?: string;
  }
) {
  const sourcedItems = items.filter((item) => item.sourcePrescriptionId);
  const sourceIds = sourcedItems.map((item) => item.sourcePrescriptionId!);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A prescription can appear only once on an invoice.",
    });
  }
  if (!options.appointmentId || !options.patientId) {
    if (sourceIds.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Prescription charges require a visit-linked invoice.",
      });
    }
    return;
  }

  const linkedPrescriptions = await ctx.db
    .select({
      id: prescriptions.id,
      productId: prescriptions.productId,
      quantity: prescriptions.quantity,
    })
    .from(prescriptions)
    .where(
      and(
        eq(prescriptions.appointmentId, options.appointmentId),
        eq(prescriptions.patientId, options.patientId),
        eq(prescriptions.practiceId, ctx.practiceId),
        isNull(prescriptions.deletedAt),
        isNotNull(prescriptions.productId)
      )
    )
    .orderBy(prescriptions.id)
    .for("share");
  const byId = new Map(linkedPrescriptions.map((rx) => [rx.id, rx]));
  const visitProductIds = new Set(
    linkedPrescriptions.map((rx) => rx.productId).filter(Boolean)
  );

  for (const item of items) {
    if (item.itemType !== "product" || !item.itemId) continue;
    if (item.sourceDispenseChargeId) continue;
    if (!item.sourcePrescriptionId) {
      if (visitProductIds.has(item.itemId)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Charge a visit-dispensed medication from its prescription entry so stock is not deducted twice.",
        });
      }
      continue;
    }
    const prescription = byId.get(item.sourcePrescriptionId);
    if (
      !prescription ||
      prescription.productId !== item.itemId ||
      (prescription.quantity !== null && prescription.quantity !== item.quantity)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Prescription charge no longer matches the visit dispensation.",
      });
    }
  }

  if (sourceIds.length > 0) {
    const conditions = [
      inArray(invoiceItems.sourcePrescriptionId, sourceIds),
      isNull(invoiceItems.deletedAt),
      eq(invoices.practiceId, ctx.practiceId),
      ne(invoices.status, "void"),
      isNull(invoices.deletedAt),
    ];
    if (options.currentInvoiceId) {
      conditions.push(ne(invoices.id, options.currentInvoiceId));
    }
    const [alreadyCharged] = await ctx.db
      .select({ id: invoiceItems.id })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
      .where(and(...conditions))
      .limit(1);
    if (alreadyCharged) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A visit prescription has already been charged on another invoice.",
      });
    }
  }
}

type DispenseChargeSource = {
  id: string;
  prescriptionId: string;
  patientId: string;
  clientId: string;
  appointmentId: string | null;
  productId: string;
  quantity: number;
  descriptionSnapshot: string;
  unitPriceSnapshot: string;
  status: "pending" | "invoiced" | "waived";
  invoiceId: string | null;
};

async function assertDispenseChargeSources(
  ctx: BillingContext,
  items: readonly InvoiceLineInput[],
  options: {
    clientId: string;
    patientId?: string | null;
    appointmentId?: string | null;
    currentInvoiceId?: string;
    isEstimate?: boolean;
  },
): Promise<Map<string, DispenseChargeSource>> {
  const sourcedItems = items.filter((item) => item.sourceDispenseChargeId);
  const sourceIds = sourcedItems.map((item) => item.sourceDispenseChargeId!);
  const unsourcedProductIds = items
    .filter(
      (item) =>
        item.itemType === "product" &&
        item.itemId &&
        !item.sourcePrescriptionId &&
        !item.sourceDispenseChargeId,
    )
    .map((item) => item.itemId!);
  if (
    !options.isEstimate &&
    options.patientId &&
    unsourcedProductIds.length > 0
  ) {
    const [unresolvedDispense] = await ctx.db
      .select({ id: dispenseChargeQueue.id })
      .from(dispenseChargeQueue)
      .where(
        and(
          eq(dispenseChargeQueue.practiceId, ctx.practiceId),
          eq(dispenseChargeQueue.patientId, options.patientId),
          inArray(dispenseChargeQueue.productId, unsourcedProductIds),
          inArray(dispenseChargeQueue.status, ["pending", "waived"]),
        ),
      )
      .limit(1);
    if (unresolvedDispense) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Charge this patient's already-dispensed medication from the medication billing queue so inventory is not deducted twice.",
      });
    }
  }
  if (sourceIds.length === 0) return new Map();
  if (options.isEstimate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A dispensed medication can be attached only to an invoice, not an estimate.",
    });
  }
  if (!options.patientId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Dispensed medication charges require their patient.",
    });
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A medication dispense can appear only once on an invoice.",
    });
  }

  const sources = await ctx.db
    .select({
      id: dispenseChargeQueue.id,
      prescriptionId: dispenseChargeQueue.prescriptionId,
      patientId: dispenseChargeQueue.patientId,
      clientId: dispenseChargeQueue.clientId,
      appointmentId: dispenseChargeQueue.appointmentId,
      productId: dispenseChargeQueue.productId,
      quantity: dispenseChargeQueue.quantity,
      descriptionSnapshot: dispenseChargeQueue.descriptionSnapshot,
      unitPriceSnapshot: dispenseChargeQueue.unitPriceSnapshot,
      status: dispenseChargeQueue.status,
      invoiceId: dispenseChargeQueue.invoiceId,
    })
    .from(dispenseChargeQueue)
    .where(
      and(
        eq(dispenseChargeQueue.practiceId, ctx.practiceId),
        inArray(dispenseChargeQueue.id, [...sourceIds].sort()),
      ),
    )
    .orderBy(dispenseChargeQueue.id)
    .for("update");
  if (sources.length !== sourceIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more medication dispenses were not found.",
    });
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const item of sourcedItems) {
    const source = byId.get(item.sourceDispenseChargeId!);
    if (
      !source ||
      source.clientId !== options.clientId ||
      source.patientId !== options.patientId ||
      source.appointmentId !== (options.appointmentId ?? null) ||
      item.itemType !== "product" ||
      item.itemId !== source.productId ||
      item.quantity !== source.quantity ||
      item.description !== source.descriptionSnapshot ||
      moneyToCents(item.unitPrice) !== moneyToCents(source.unitPriceSnapshot)
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Medication charge no longer matches its dispense-time record.",
      });
    }
    if (source.status === "waived") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This medication dispense was waived. Reopen it before charging.",
      });
    }
    if (
      source.status === "invoiced" &&
      source.invoiceId !== options.currentInvoiceId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This medication dispense is already on another invoice.",
      });
    }
  }
  return byId;
}

async function markDispenseChargesInvoiced(
  ctx: BillingContext,
  assignments: readonly {
    chargeId: string;
    invoiceId: string;
    invoiceItemId: string;
  }[],
  actor: { id: string; name: string },
) {
  for (const assignment of assignments) {
    const [updated] = await ctx.db
      .update(dispenseChargeQueue)
      .set({
        status: "invoiced",
        invoiceId: assignment.invoiceId,
        invoiceItemId: assignment.invoiceItemId,
        resolvedBy: actor.id,
        resolvedByName: actor.name,
        resolvedAt: new Date(),
        resolutionReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dispenseChargeQueue.id, assignment.chargeId),
          eq(dispenseChargeQueue.practiceId, ctx.practiceId),
          eq(dispenseChargeQueue.status, "pending"),
          isNull(dispenseChargeQueue.invoiceId),
          isNull(dispenseChargeQueue.invoiceItemId),
        ),
      )
      .returning({
        id: dispenseChargeQueue.id,
        prescriptionId: dispenseChargeQueue.prescriptionId,
        appointmentId: dispenseChargeQueue.appointmentId,
      });
    if (!updated) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Medication charge state changed. Refresh and try again.",
      });
    }
    if (updated.appointmentId) {
      await ctx.db
        .update(visitWorkItems)
        .set({
          status: "charged",
          invoiceId: assignment.invoiceId,
          invoiceItemId: assignment.invoiceItemId,
          noChargeReason: null,
          voidReason: null,
          resolvedBy: actor.id,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(visitWorkItems.practiceId, ctx.practiceId),
            eq(visitWorkItems.appointmentId, updated.appointmentId),
            eq(visitWorkItems.prescriptionId, updated.prescriptionId),
            eq(visitWorkItems.status, "unresolved"),
            isNull(visitWorkItems.deletedAt),
          ),
        );
    }
  }
}

async function reopenInvoiceDispenseCharges(
  ctx: BillingContext,
  invoiceId: string,
) {
  await ctx.db
    .update(dispenseChargeQueue)
    .set({
      status: "pending",
      invoiceId: null,
      invoiceItemId: null,
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
      resolutionReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(dispenseChargeQueue.practiceId, ctx.practiceId),
        eq(dispenseChargeQueue.invoiceId, invoiceId),
        eq(dispenseChargeQueue.status, "invoiced"),
      ),
    );
}

async function lockDispenseChargeWorkflow(
  ctx: BillingContext,
  chargeId: string,
) {
  const [identity] = await ctx.db
    .select({ appointmentId: dispenseChargeQueue.appointmentId })
    .from(dispenseChargeQueue)
    .where(
      and(
        eq(dispenseChargeQueue.id, chargeId),
        eq(dispenseChargeQueue.practiceId, ctx.practiceId),
      ),
    )
    .limit(1);
  if (!identity) return null;
  if (identity.appointmentId) {
    await ctx.db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${identity.appointmentId}, 0))`,
    );
    const [appointment] = await ctx.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, identity.appointmentId),
          eq(appointments.practiceId, ctx.practiceId),
        ),
      )
      .for("update");
    if (!appointment) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The linked appointment is no longer available.",
      });
    }
  }
  const [charge] = await ctx.db
    .select()
    .from(dispenseChargeQueue)
    .where(
      and(
        eq(dispenseChargeQueue.id, chargeId),
        eq(dispenseChargeQueue.practiceId, ctx.practiceId),
      ),
    )
    .limit(1)
    .for("update");
  return charge ?? null;
}

async function deductProductStock(
  ctx: BillingContext,
  items: readonly DispensableItem[]
) {
  const deductions = computeStockDeductions([...items]);
  for (const deduction of deductions) {
    const [product] = await ctx.db
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${deduction.quantity}`,
      })
      .where(
        and(
          eq(products.id, deduction.productId),
          eq(products.practiceId, ctx.practiceId),
          isNull(products.deletedAt),
          sql`${products.stockQuantity} >= ${deduction.quantity}`
        )
      )
      .returning({ id: products.id, stockQuantity: products.stockQuantity });

    if (!product) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Insufficient stock for one or more product invoice lines.",
      });
    }
  }
}

async function invoiceProductItemsForStock(
  ctx: BillingContext,
  invoiceId: string
): Promise<DispensableItem[]> {
  return ctx.db
    .select({
      itemType: invoiceItems.itemType,
      itemId: invoiceItems.itemId,
      quantity: invoiceItems.quantity,
    })
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.invoiceId, invoiceId),
        invoiceItemPracticeScope(ctx),
        isNull(invoiceItems.sourcePrescriptionId),
        isNull(invoiceItems.sourceDispenseChargeId),
        isNull(invoiceItems.deletedAt)
      )
    );
}

async function restoreProductStock(
  ctx: BillingContext,
  items: readonly DispensableItem[]
) {
  const restorations = computeStockDeductions([...items]);
  for (const restoration of restorations) {
    const [product] = await ctx.db
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} + ${restoration.quantity}`,
      })
      .where(
        and(
          eq(products.id, restoration.productId),
          eq(products.practiceId, ctx.practiceId),
          isNull(products.deletedAt),
          sql`${products.stockQuantity} + ${restoration.quantity} <= ${POSTGRES_INTEGER_MAX}`
        )
      )
      .returning({ id: products.id, stockQuantity: products.stockQuantity });

    if (!product) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Unable to restore stock for one or more product invoice lines.",
      });
    }
  }
}

export const billingRouter = createRouter({
  // Region-aware billing config for the practice (tax rate + currency).
  // Available to any authenticated user so invoice forms can preview totals.
  getTaxConfig: protectedProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({
        taxRatePercent: practices.taxRatePercent,
        currency: practices.currency,
        country: practices.country,
        timezone: practices.timezone,
      })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    return {
      taxRatePercent: practice.taxRatePercent ?? "8.00",
      currency: practice.currency ?? "usd",
      country: practice.country ?? "US",
      timezone: practice.timezone ?? null,
    };
  }),

  paymentAccountStatus: protectedProcedure
    .use(requireRole("admin"))
    .query(async ({ ctx }) => {
      const row = await getStripeConnectPaymentAccount(ctx);
      return {
        stripeConfigured: stripeConfigured(),
        connectRequired: billingEnforced(),
        ...serializePaymentAccountStatus(row),
      };
    }),

  createPaymentAccountOnboarding: protectedProcedure
    .use(requireRole("admin"))
    .mutation(async ({ ctx }) => {
      if (!stripeConfigured()) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Stripe is not configured.",
        });
      }

      const [practice] = await ctx.db
        .select({
          id: practices.id,
          name: practices.name,
          email: practices.email,
          country: practices.country,
        })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }

      try {
        const existing = await getStripeConnectPaymentAccount(ctx);
        const account = existing?.stripeAccountId
          ? await retrieveConnectAccount(existing.stripeAccountId)
          : await createConnectAccount({
              practiceId: practice.id,
              email: practice.email,
              country: practice.country,
              businessName: practice.name,
            });

        if (!account) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Stripe Connect setup is unavailable.",
          });
        }

        await upsertStripeConnectPaymentAccount(ctx, account);

        const base = appBaseUrl();
        const link = await createConnectAccountLink({
          accountId: account.id,
          refreshUrl: `${base}/settings?tab=billing&connect=refresh`,
          returnUrl: `${base}/settings?tab=billing&connect=return`,
        });

        if (!isSafeCheckoutRedirectUrl(link?.url)) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Stripe Connect onboarding is unavailable.",
          });
        }

        return { url: link.url };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        console.error("[Stripe Connect] onboarding failed", err);
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Stripe Connect setup is unavailable.",
        });
      }
    }),

  refreshPaymentAccount: protectedProcedure
    .use(requireRole("admin"))
    .mutation(async ({ ctx }) => {
      if (!stripeConfigured()) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Stripe is not configured.",
        });
      }

      const existing = await getStripeConnectPaymentAccount(ctx);
      if (!existing) {
        return {
          stripeConfigured: true,
          connectRequired: billingEnforced(),
          ...serializePaymentAccountStatus(null),
        };
      }

      try {
        const account = await retrieveConnectAccount(existing.stripeAccountId);
        if (!account) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message: "Stripe Connect status is unavailable.",
          });
        }

        const row = await upsertStripeConnectPaymentAccount(ctx, account);
        return {
          stripeConfigured: true,
          connectRequired: billingEnforced(),
          ...serializePaymentAccountStatus(row ?? null),
        };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        console.error("[Stripe Connect] status refresh failed", err);
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Stripe Connect status is unavailable.",
        });
      }
    }),

  openPaymentAccountDashboard: protectedProcedure
    .use(requireRole("admin"))
    .mutation(async ({ ctx }) => {
      const existing = await getStripeConnectPaymentAccount(ctx);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Set up client payments before opening Stripe.",
        });
      }

      try {
        const link = await createConnectLoginLink(existing.stripeAccountId);
        if (isSafeCheckoutRedirectUrl(link?.url)) {
          return { url: link!.url };
        }
      } catch (err) {
        // Login links only exist for Express-dashboard accounts. Accounts
        // with the full Stripe Dashboard sign in to Stripe directly, so fall
        // through to the standard dashboard URL.
        console.warn("[Stripe Connect] no login link for account", err);
      }
      return { url: "https://dashboard.stripe.com/login" };
    }),

  listDispenseChargeQueue: protectedProcedure
    .input(
      z.object({
        status: z.enum(["pending", "invoiced", "waived"]).default("pending"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: listOffsetInput,
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions = and(
        eq(dispenseChargeQueue.practiceId, ctx.practiceId),
        eq(dispenseChargeQueue.status, input.status),
      );
      const [items, countRows] = await Promise.all([
        ctx.db
          .select({
            id: dispenseChargeQueue.id,
            prescriptionEventId: dispenseChargeQueue.prescriptionEventId,
            prescriptionId: dispenseChargeQueue.prescriptionId,
            patientId: dispenseChargeQueue.patientId,
            patientName: patients.name,
            clientId: dispenseChargeQueue.clientId,
            clientFirstName: clients.firstName,
            clientLastName: clients.lastName,
            appointmentId: dispenseChargeQueue.appointmentId,
            productId: dispenseChargeQueue.productId,
            quantity: dispenseChargeQueue.quantity,
            description: dispenseChargeQueue.descriptionSnapshot,
            unitPrice: dispenseChargeQueue.unitPriceSnapshot,
            status: dispenseChargeQueue.status,
            invoiceId: dispenseChargeQueue.invoiceId,
            resolutionReason: dispenseChargeQueue.resolutionReason,
            resolvedByName: dispenseChargeQueue.resolvedByName,
            resolvedAt: dispenseChargeQueue.resolvedAt,
            legacyReview: dispenseChargeQueue.legacyReview,
            createdAt: dispenseChargeQueue.createdAt,
          })
          .from(dispenseChargeQueue)
          .innerJoin(
            patients,
            and(
              eq(dispenseChargeQueue.patientId, patients.id),
              eq(patients.practiceId, ctx.practiceId),
            ),
          )
          .innerJoin(
            clients,
            and(
              eq(dispenseChargeQueue.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
            ),
          )
          .where(conditions)
          .orderBy(
            desc(dispenseChargeQueue.createdAt),
            desc(dispenseChargeQueue.id),
          )
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(dispenseChargeQueue)
          .where(conditions),
      ]);
      return { items, total: Number(countRows[0]?.count ?? 0) };
    }),

  createDispenseChargeInvoice: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        acknowledgeLegacyReview: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        const [sourceIdentity] = await tx
          .select({ appointmentId: dispenseChargeQueue.appointmentId })
          .from(dispenseChargeQueue)
          .where(
            and(
              eq(dispenseChargeQueue.id, input.id),
              eq(dispenseChargeQueue.practiceId, ctx.practiceId),
            ),
          )
          .limit(1);
        if (!sourceIdentity) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Medication dispense not found.",
          });
        }
        if (sourceIdentity.appointmentId) {
          // Match createInvoice's lock order: appointment first, then the
          // dispense row. This prevents duplicate visit invoices and avoids a
          // lock-order inversion when two front-desk tabs charge the same fill.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${sourceIdentity.appointmentId}, 0))`,
          );
          await lockAppointmentForInvoiceMutation(
            txCtx,
            sourceIdentity.appointmentId,
          );
        }
        const [source] = await tx
          .select()
          .from(dispenseChargeQueue)
          .where(
            and(
              eq(dispenseChargeQueue.id, input.id),
              eq(dispenseChargeQueue.practiceId, ctx.practiceId),
            ),
          )
          .limit(1)
          .for("update");
        if (!source) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Medication dispense not found.",
          });
        }
        if (source.status === "invoiced" && source.invoiceId) {
          return { invoiceId: source.invoiceId, replayed: true as const };
        }
        if (source.status === "waived") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This medication dispense was waived. Reopen it before charging.",
          });
        }
        if (source.legacyReview && !input.acknowledgeLegacyReview) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Confirm this legacy dispense should be billed before creating an invoice.",
          });
        }
        const [practice] = await tx
          .select({ taxRatePercent: practices.taxRatePercent })
          .from(practices)
          .where(activePracticeWhere(ctx.practiceId))
          .limit(1);
        if (!practice) throw practiceNotFound();
        const subtotalCents =
          moneyToCents(source.unitPriceSnapshot) * source.quantity;
        const [sourceProduct] = await tx
          .select({ id: products.id, taxable: products.taxable })
          .from(products)
          .where(
            and(
              eq(products.id, source.productId),
              eq(products.practiceId, ctx.practiceId),
            ),
          )
          .limit(1)
          .for("share");
        if (!sourceProduct) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "The dispensed product is no longer available for billing.",
          });
        }
        const newLine = {
          itemType: "product" as const,
          itemId: source.productId,
          quantity: source.quantity,
          unitPrice: source.unitPriceSnapshot,
          taxable: sourceProduct.taxable ?? true,
        };
        let invoiceId: string;
        const [existingVisitInvoice] = source.appointmentId
          ? await tx
              .select({
                id: invoices.id,
                clientId: invoices.clientId,
                patientId: invoices.patientId,
                status: invoices.status,
                subtotal: invoices.subtotal,
                paidAmount: invoices.paidAmount,
              })
              .from(invoices)
              .where(
                and(
                  eq(invoices.practiceId, ctx.practiceId),
                  eq(invoices.appointmentId, source.appointmentId),
                  eq(invoices.isEstimate, false),
                  ne(invoices.status, "void"),
                  isNull(invoices.deletedAt),
                ),
              )
              .limit(1)
              .for("update")
          : [];
        if (existingVisitInvoice) {
          if (
            existingVisitInvoice.clientId !== source.clientId ||
            existingVisitInvoice.patientId !== source.patientId
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "The visit invoice no longer matches this medication dispense.",
            });
          }
          if (
            existingVisitInvoice.status !== "draft" ||
            moneyToCents(existingVisitInvoice.paidAmount) !== 0
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "This visit already has a finalized invoice. Correct that invoice or waive this pending dispense with a reason.",
            });
          }
          const currentItems = await tx
            .select({
              itemType: invoiceItems.itemType,
              itemId: invoiceItems.itemId,
              quantity: invoiceItems.quantity,
              unitPrice: invoiceItems.unitPrice,
              taxable: invoiceItems.taxable,
            })
            .from(invoiceItems)
            .where(
              and(
                eq(invoiceItems.invoiceId, existingVisitInvoice.id),
                invoiceItemPracticeScope(txCtx),
                isNull(invoiceItems.deletedAt),
              ),
            );
          const totals = invoiceLineTaxTotals(
            [...currentItems, newLine],
            practice.taxRatePercent ?? "8.00",
          );
          const [updatedInvoice] = await tx
            .update(invoices)
            .set({
              subtotal: centsToMoney(totals.subtotalCents),
              tax: centsToMoney(totals.taxCents),
              total: centsToMoney(totals.totalCents),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(invoices.id, existingVisitInvoice.id),
                eq(invoices.practiceId, ctx.practiceId),
                eq(invoices.status, "draft"),
                eq(invoices.paidAmount, "0.00"),
                isNull(invoices.deletedAt),
              ),
            )
            .returning({ id: invoices.id });
          if (!updatedInvoice) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Visit invoice changed. Refresh and try again.",
            });
          }
          invoiceId = updatedInvoice.id;
        } else {
          const totals = invoiceLineTaxTotals(
            [newLine],
            practice.taxRatePercent ?? "8.00",
          );
          const [invoice] = await tx
            .insert(invoices)
            .values({
              practiceId: ctx.practiceId,
              clientId: source.clientId,
              patientId: source.patientId,
              appointmentId: source.appointmentId,
              status: "draft",
              subtotal: centsToMoney(totals.subtotalCents),
              tax: centsToMoney(totals.taxCents),
              total: centsToMoney(totals.totalCents),
              paidAmount: "0.00",
              dueDate: null,
              isEstimate: false,
            })
            .returning({ id: invoices.id });
          invoiceId = invoice!.id;
        }
        const invoiceItemId = randomUUID();
        await tx.insert(invoiceItems).values({
          id: invoiceItemId,
          invoiceId,
          description: source.descriptionSnapshot,
          quantity: source.quantity,
          unitPrice: source.unitPriceSnapshot,
          total: centsToMoney(subtotalCents),
          taxable: sourceProduct.taxable ?? true,
          itemType: "product",
          itemId: source.productId,
          sourceDispenseChargeId: source.id,
        });
        await markDispenseChargesInvoiced(
          txCtx,
          [{ chargeId: source.id, invoiceId, invoiceItemId }],
          ctx.user,
        );
        return { invoiceId, replayed: false as const };
      });
      return result;
    }),

  waiveDispenseCharge: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().trim().min(5).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        const charge = await lockDispenseChargeWorkflow(txCtx, input.id);
        if (!charge) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Medication dispense not found.",
          });
        }
        if (charge.status !== "pending") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Medication charge state changed. Refresh and try again.",
          });
        }
        const resolvedAt = new Date();
        if (charge.appointmentId) {
          const [workItem] = await tx
            .select()
            .from(visitWorkItems)
            .where(
              and(
                eq(visitWorkItems.practiceId, ctx.practiceId),
                eq(visitWorkItems.appointmentId, charge.appointmentId),
                eq(visitWorkItems.prescriptionId, charge.prescriptionId),
                isNull(visitWorkItems.deletedAt),
              ),
            )
            .limit(1)
            .for("update");
          if (
            workItem &&
            workItem.status !== "unresolved" &&
            !(
              workItem.status === "no_charge" &&
              workItem.noChargeReason === input.reason
            )
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Correct the visit reconciliation before waiving this medication charge.",
            });
          }
          if (workItem?.status === "unresolved") {
            const [resolvedWork] = await tx
              .update(visitWorkItems)
              .set({
                status: "no_charge",
                invoiceId: null,
                invoiceItemId: null,
                noChargeReason: input.reason,
                voidReason: null,
                resolvedBy: ctx.user.id,
                resolvedAt,
                updatedAt: resolvedAt,
              })
              .where(
                and(
                  eq(visitWorkItems.id, workItem.id),
                  eq(visitWorkItems.practiceId, ctx.practiceId),
                  eq(visitWorkItems.status, "unresolved"),
                  isNull(visitWorkItems.deletedAt),
                ),
              )
              .returning({ id: visitWorkItems.id });
            if (!resolvedWork) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Visit reconciliation changed. Refresh and try again.",
              });
            }
          }
        }
        const [updated] = await tx
          .update(dispenseChargeQueue)
          .set({
            status: "waived",
            invoiceId: null,
            invoiceItemId: null,
            resolvedBy: ctx.user.id,
            resolvedByName: ctx.user.name,
            resolvedAt,
            resolutionReason: input.reason,
            updatedAt: resolvedAt,
          })
          .where(
            and(
              eq(dispenseChargeQueue.id, input.id),
              eq(dispenseChargeQueue.practiceId, ctx.practiceId),
              eq(dispenseChargeQueue.status, "pending"),
            ),
          )
          .returning({ id: dispenseChargeQueue.id });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Medication charge state changed. Refresh and try again.",
          });
        }
        return updated;
      });
    }),

  reopenDispenseCharge: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        const charge = await lockDispenseChargeWorkflow(txCtx, input.id);
        if (!charge) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Medication dispense not found.",
          });
        }
        if (charge.status !== "waived") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Medication charge state changed. Refresh and try again.",
          });
        }
        if (charge.appointmentId) {
          await assertVisitReconciliationMutable(txCtx, charge.appointmentId);
          const [workItem] = await tx
            .select()
            .from(visitWorkItems)
            .where(
              and(
                eq(visitWorkItems.practiceId, ctx.practiceId),
                eq(visitWorkItems.appointmentId, charge.appointmentId),
                eq(visitWorkItems.prescriptionId, charge.prescriptionId),
                isNull(visitWorkItems.deletedAt),
              ),
            )
            .limit(1)
            .for("update");
          if (
            workItem &&
            workItem.status !== "unresolved" &&
            !(
              (workItem.status === "no_charge" &&
                workItem.noChargeReason === charge.resolutionReason) ||
              (workItem.status === "voided" &&
                workItem.voidReason === charge.resolutionReason)
            )
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Correct the visit reconciliation before reopening this medication charge.",
            });
          }
          if (workItem && workItem.status !== "unresolved") {
            await tx.insert(auditLog).values({
              practiceId: ctx.practiceId,
              userId: ctx.user.id,
              action: "reopened",
              entityType: "visit_work_item",
              entityId: workItem.id,
              changes: {
                reason: "Medication charge reopened from billing queue.",
                priorStatus: workItem.status,
                priorInvoiceId: workItem.invoiceId,
                priorInvoiceItemId: workItem.invoiceItemId,
                priorNoChargeReason: workItem.noChargeReason,
                priorVoidReason: workItem.voidReason,
                priorResolvedBy: workItem.resolvedBy,
                priorResolvedAt: workItem.resolvedAt?.toISOString() ?? null,
              },
            });
            const [reopenedWork] = await tx
              .update(visitWorkItems)
              .set({
                status: "unresolved",
                invoiceId: null,
                invoiceItemId: null,
                noChargeReason: null,
                voidReason: null,
                resolvedBy: null,
                resolvedAt: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(visitWorkItems.id, workItem.id),
                  eq(visitWorkItems.practiceId, ctx.practiceId),
                  eq(visitWorkItems.status, workItem.status),
                  isNull(visitWorkItems.deletedAt),
                ),
              )
              .returning({ id: visitWorkItems.id });
            if (!reopenedWork) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Visit reconciliation changed. Refresh and try again.",
              });
            }
          }
        }
        const [updated] = await tx
          .update(dispenseChargeQueue)
          .set({
            status: "pending",
            invoiceId: null,
            invoiceItemId: null,
            resolvedBy: null,
            resolvedByName: null,
            resolvedAt: null,
            resolutionReason: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(dispenseChargeQueue.id, input.id),
              eq(dispenseChargeQueue.practiceId, ctx.practiceId),
              eq(dispenseChargeQueue.status, "waived"),
            ),
          )
          .returning({ id: dispenseChargeQueue.id });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Medication charge state changed. Refresh and try again.",
          });
        }
        return updated;
      });
    }),

  listInvoices: protectedProcedure
    .input(
      z.object({
        status: invoiceStatusSchema.optional(),
        isEstimate: z.boolean().optional(),
        patientId: z.string().uuid().optional(),
        appointmentId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: listOffsetInput,
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions: ReturnType<typeof eq>[] = [
        eq(invoices.practiceId, ctx.practiceId),
        isNull(invoices.deletedAt),
      ];

      if (input.status) {
        conditions.push(eq(invoices.status, input.status));
      }

      if (input.patientId) {
        conditions.push(eq(invoices.patientId, input.patientId));
      }

      if (input.appointmentId) {
        conditions.push(eq(invoices.appointmentId, input.appointmentId));
      }

      if (input.isEstimate !== undefined) {
        conditions.push(eq(invoices.isEstimate, input.isEstimate));
      }

      const [items, countResult] = await Promise.all([
        ctx.db
          .select({
            id: invoices.id,
            status: invoices.status,
            subtotal: invoices.subtotal,
            tax: invoices.tax,
            total: invoices.total,
            paidAmount: invoices.paidAmount,
            adjustedAmount: sql<string>`coalesce((
              select sum(${invoiceAdjustments.amount})
              from ${invoiceAdjustments}
              where ${invoiceAdjustments.invoiceId} = ${invoices.id}
                and ${invoiceAdjustments.deletedAt} is null
            ), 0)`,
            dueDate: invoices.dueDate,
            createdAt: invoices.createdAt,
            updatedAt: invoices.updatedAt,
            isEstimate: invoices.isEstimate,
            clientFirstName: clients.firstName,
            clientLastName: clients.lastName,
            patientName: patients.name,
            appointmentId: invoices.appointmentId,
          })
          .from(invoices)
          .leftJoin(
            clients,
            and(
              eq(invoices.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
              isNull(clients.deletedAt)
            )
          )
          .leftJoin(
            patients,
            and(
              eq(invoices.patientId, patients.id),
              eq(patients.clientId, invoices.clientId),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt)
            )
          )
          .where(and(...conditions))
          .orderBy(desc(invoices.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(invoices)
          .where(and(...conditions)),
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  getInvoice: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          status: invoices.status,
          isEstimate: invoices.isEstimate,
          subtotal: invoices.subtotal,
          tax: invoices.tax,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          dueDate: invoices.dueDate,
          createdAt: invoices.createdAt,
          updatedAt: invoices.updatedAt,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          patientName: patients.name,
        })
        .from(invoices)
        .leftJoin(
          clients,
          and(
            eq(invoices.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(invoices.patientId, patients.id),
            eq(patients.clientId, invoices.clientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .where(
          and(
            eq(invoices.id, input.id),
            eq(invoices.practiceId, ctx.practiceId),
            isNull(invoices.deletedAt)
          )
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }

      const [items, adjustmentRows] = await Promise.all([
        ctx.db
          .select()
          .from(invoiceItems)
          .where(
            and(
              eq(invoiceItems.invoiceId, input.id),
              invoiceItemPracticeScope(ctx),
              isNull(invoiceItems.deletedAt)
            )
          ),
        listInvoiceAdjustmentRows(ctx, input.id),
      ]);
      const adjustedCents = adjustmentRows.reduce(
        (sum, row) => sum + moneyToCents(row.amount),
        0
      );

      return {
        ...invoice,
        items,
        adjustedAmount: centsToMoney(adjustedCents),
        balanceDue: centsToMoney(invoiceBalanceCents(invoice, adjustedCents)),
      };
    }),

  updateInvoiceStatus: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["draft", "sent", "paid", "overdue"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getInvoiceForPractice(ctx, input.id);
      if (input.status === "paid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Record a payment or apply an adjustment to settle this invoice.",
        });
      }
      if (existing.isEstimate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Convert the estimate before changing invoice status.",
        });
      }
      if (existing.status === "void") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot reopen a void invoice.",
        });
      }
      if (!canTransitionInvoiceStatus(existing.status, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot change invoice status from ${existing.status} to ${input.status}.`,
        });
      }
      const updates: Record<string, any> = { status: input.status };
      const updateConditions: SQL[] = [
        eq(invoices.id, input.id),
        eq(invoices.practiceId, ctx.practiceId),
        isNull(invoices.deletedAt),
        eq(invoices.status, existing.status),
        eq(invoices.isEstimate, existing.isEstimate),
        eq(invoices.paidAmount, existing.paidAmount ?? "0"),
      ];
      if (input.status === "sent" && existing.appointmentId) {
        return ctx.db.transaction(async (tx) => {
          const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
          await lockAppointmentForInvoiceMutation(txCtx, existing.appointmentId);
          await assertVisitInvoiceReadyForFinancialAction(
            txCtx,
            existing.appointmentId
          );
          const [invoice] = await tx
            .update(invoices)
            .set(updates)
            .where(and(...updateConditions))
            .returning();

          if (!invoice) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Invoice status changed while updating. Refresh and try again.",
            });
          }

          return invoice!;
        });
      }

      const [invoice] = await ctx.db
        .update(invoices)
        .set(updates)
        .where(and(...updateConditions))
        .returning();
      if (!invoice) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Invoice status changed while updating. Refresh and try again.",
        });
      }
      return invoice!;
    }),

  listServices: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(services)
      .where(
        and(eq(services.practiceId, ctx.practiceId), isNull(services.deletedAt))
      )
      .orderBy(services.name);
  }),

  listArchivedServices: billingAdminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(services)
      .where(
        and(
          eq(services.practiceId, ctx.practiceId),
          isNotNull(services.deletedAt)
        )
      )
      .orderBy(services.name);
  }),

  createService: billingAdminProcedure
    .input(serviceInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const service = await ctx.db.transaction(async (tx) => {
        await lockServiceCatalog(tx, ctx.practiceId);
        await assertServiceIdentityAvailable(tx, ctx.practiceId, input);
        const [created] = await tx
          .insert(services)
          .values({
            practiceId: ctx.practiceId,
            name: input.name,
            code: input.code ?? null,
            category: input.category ?? null,
            defaultPrice: input.defaultPrice,
            taxable: input.taxable,
          })
          .returning();
        return created;
      });
      if (!service) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Service could not be created.",
        });
      }
      return service;
    }),

  updateService: billingAdminProcedure
    .input(
      serviceInput.extend({
        id: z.string().uuid(),
        expected: serviceInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const updated = await ctx.db.transaction(async (tx) => {
        await lockServiceCatalog(tx, ctx.practiceId);
        await assertServiceIdentityAvailable(
          tx,
          ctx.practiceId,
          input,
          input.id
        );
        const [result] = await tx
          .update(services)
          .set({
            name: input.name,
            code: input.code ?? null,
            category: input.category ?? null,
            defaultPrice: input.defaultPrice,
            taxable: input.taxable,
          })
          .where(
            and(
              eq(services.id, input.id),
              eq(services.practiceId, ctx.practiceId),
              isNull(services.deletedAt),
              ...serviceSnapshotConditions(input.expected)
            )
          )
          .returning();
        return result;
      });
      if (!updated) {
        await throwServiceMutationMiss(ctx, input.id);
      }
      return updated;
    }),

  archiveService: billingAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        expected: serviceInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [archived] = await ctx.db
        .update(services)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(services.id, input.id),
            eq(services.practiceId, ctx.practiceId),
            isNull(services.deletedAt),
            ...serviceSnapshotConditions(input.expected)
          )
        )
        .returning({ id: services.id });
      if (!archived) {
        await throwServiceMutationMiss(ctx, input.id);
      }
      return { success: true };
    }),

  restoreService: billingAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        expected: serviceInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const restored = await ctx.db.transaction(async (tx) => {
        await lockServiceCatalog(tx, ctx.practiceId);
        await assertServiceIdentityAvailable(
          tx,
          ctx.practiceId,
          input.expected,
          input.id
        );
        const [result] = await tx
          .update(services)
          .set({ deletedAt: null })
          .where(
            and(
              eq(services.id, input.id),
              eq(services.practiceId, ctx.practiceId),
              isNotNull(services.deletedAt),
              ...serviceSnapshotConditions(input.expected)
            )
          )
          .returning({ id: services.id });
        return result;
      });
      if (!restored) {
        await throwArchivedServiceMutationMiss(ctx, input.id);
      }
      return { success: true };
    }),

  patientsByClient: protectedProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
        })
        .from(patients)
        .where(
          and(
            eq(patients.clientId, input.clientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .orderBy(patients.name);
    }),

  createInvoice: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(createInvoiceInput)
    .mutation(async ({ ctx, input }) => {
      await assertClientBelongsToPractice(ctx, input.clientId);
      if (input.patientId) {
        await assertPatientBelongsToClient(ctx, input.patientId, input.clientId);
      }
      if (input.appointmentId) {
        await assertAppointmentBelongsToClientPatient(
          ctx,
          input.appointmentId,
          input.clientId,
          input.patientId
        );
      }
      // Tax rate is configured per practice (region-aware), not hardcoded.
      const [practice] = await ctx.db
        .select({ taxRatePercent: practices.taxRatePercent })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }

      return ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        if (input.appointmentId) {
          // Serialize charge capture for one visit so two front-desk tabs
          // cannot both pass the duplicate check and create competing bills.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${input.appointmentId}, 0))`
          );
          await lockAppointmentForVisitBilling(
            txCtx,
            input.appointmentId,
            input.clientId,
            input.patientId,
            input.isEstimate ?? false
          );
          const [existingVisitInvoice] = await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.practiceId, ctx.practiceId),
                eq(invoices.appointmentId, input.appointmentId),
                eq(invoices.isEstimate, input.isEstimate ?? false),
                ne(invoices.status, "void"),
                isNull(invoices.deletedAt)
              )
            )
            .limit(1);
          if (existingVisitInvoice) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This visit already has an active invoice. Open it instead of creating a duplicate.",
            });
          }
        }
        const taxabilityByReference = await assertLineItemReferences(
          txCtx,
          input.items,
          { lockProductsForStock: !(input.isEstimate ?? false) },
        );
        await assertPrescriptionChargeSources(txCtx, input.items, {
          appointmentId: input.appointmentId,
          patientId: input.patientId,
        });
        await assertDispenseChargeSources(txCtx, input.items, {
          clientId: input.clientId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          isEstimate: input.isEstimate ?? false,
        });
        if (!(input.isEstimate ?? false)) {
          await deductProductStock(txCtx, stockOwnedItems(input.items));
        }

        const totals = invoiceLineTaxTotals(
          input.items,
          practice.taxRatePercent ?? "8.00",
          taxabilityByReference,
        );

        const [invoice] = await tx
          .insert(invoices)
          .values({
            practiceId: ctx.practiceId,
            clientId: input.clientId,
            patientId: input.patientId ?? null,
            appointmentId: input.appointmentId ?? null,
            status: "draft",
            subtotal: centsToMoney(totals.subtotalCents),
            tax: centsToMoney(totals.taxCents),
            total: centsToMoney(totals.totalCents),
            paidAmount: "0.00",
            dueDate: input.dueDate ?? null,
            isEstimate: input.isEstimate ?? false,
          })
          .returning();

        if (input.items.length > 0) {
          const preparedItems = input.items.map((item) => ({
            id: randomUUID(),
            ...item,
          }));
          await tx.insert(invoiceItems).values(
            preparedItems.map((item) => ({
              id: item.id,
              invoiceId: invoice!.id,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              total: centsToMoney(
                item.quantity * moneyToCents(item.unitPrice),
              ),
              taxable: invoiceLineTaxable(item, taxabilityByReference),
              itemType: item.itemType as "service" | "product",
              itemId: item.itemId ?? null,
              sourcePrescriptionId: item.sourcePrescriptionId ?? null,
              sourceDispenseChargeId: item.sourceDispenseChargeId ?? null,
            })),
          );
          await markDispenseChargesInvoiced(
            txCtx,
            preparedItems
              .filter((item) => item.sourceDispenseChargeId)
              .map((item) => ({
                chargeId: item.sourceDispenseChargeId!,
                invoiceId: invoice!.id,
                invoiceItemId: item.id,
              })),
            ctx.user,
          );
        }

        return invoice!;
      });
    }),

  updateInvoiceItems: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(updateInvoiceItemsInput)
    .mutation(async ({ ctx, input }) => {
      const [practice] = await ctx.db
        .select({ taxRatePercent: practices.taxRatePercent })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }

      return ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.id}, 0))`
        );

        const [existing] = await tx
          .select({
            id: invoices.id,
            status: invoices.status,
            isEstimate: invoices.isEstimate,
            paidAmount: invoices.paidAmount,
            appointmentId: invoices.appointmentId,
            patientId: invoices.patientId,
            clientId: invoices.clientId,
            updatedAt: invoices.updatedAt,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.id, input.id),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt)
            )
          )
          .limit(1);

        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
        }
        if (existing.isEstimate) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Convert or replace the estimate before editing visit invoice charges.",
          });
        }
        if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Invoice changed in another session. Refresh before saving charges.",
          });
        }
        if (existing.status !== "draft" || moneyToCents(existing.paidAmount) > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Only an unpaid draft invoice can have its line items changed.",
          });
        }
        await assertInvoiceItemsNotReconciled(txCtx, input.id);
        if (existing.appointmentId) {
          const [appointment] = await tx
            .select({
              id: appointments.id,
              clientId: appointments.clientId,
              patientId: appointments.patientId,
            })
            .from(appointments)
            .where(
              and(
                eq(appointments.id, existing.appointmentId),
                eq(appointments.practiceId, ctx.practiceId),
                isNull(appointments.deletedAt)
              )
            )
            .limit(1);
          if (!appointment?.clientId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The linked visit is no longer billable.",
            });
          }
          await lockAppointmentForVisitBilling(
            txCtx,
            existing.appointmentId,
            appointment.clientId,
            appointment.patientId ?? undefined,
            false
          );
        }
        const previousItems = await invoiceProductItemsForStock(txCtx, input.id);
        const taxabilityByReference = await assertLineItemReferences(
          txCtx,
          input.items,
          { previousItems, lockProductsForStock: true },
        );
        await assertPrescriptionChargeSources(txCtx, input.items, {
          appointmentId: existing.appointmentId,
          patientId: existing.patientId,
          currentInvoiceId: existing.id,
        });
        await assertDispenseChargeSources(txCtx, input.items, {
          clientId: existing.clientId,
          patientId: existing.patientId,
          appointmentId: existing.appointmentId,
          currentInvoiceId: existing.id,
          isEstimate: existing.isEstimate,
        });
        await restoreProductStock(txCtx, previousItems);
        await deductProductStock(txCtx, stockOwnedItems(input.items));

        const totals = invoiceLineTaxTotals(
          input.items,
          practice.taxRatePercent ?? "8.00",
          taxabilityByReference,
        );

        const [invoice] = await tx
          .update(invoices)
          .set({
            subtotal: centsToMoney(totals.subtotalCents),
            tax: centsToMoney(totals.taxCents),
            total: centsToMoney(totals.totalCents),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(invoices.id, input.id),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt),
              eq(invoices.status, "draft"),
              eq(invoices.isEstimate, existing.isEstimate),
              eq(invoices.paidAmount, existing.paidAmount ?? "0.00"),
              eq(invoices.updatedAt, input.expectedUpdatedAt),
              noActivePaymentsForInvoice(),
              noActiveAdjustmentsForInvoice()
            )
          )
          .returning();

        if (!invoice) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Invoice state changed while saving charges. Refresh and try again.",
          });
        }

        const changedAt = new Date();
        await tx
          .update(invoiceItems)
          .set({ deletedAt: changedAt, updatedAt: changedAt })
          .where(
            and(
              eq(invoiceItems.invoiceId, input.id),
              invoiceItemPracticeScope(txCtx),
              isNull(invoiceItems.deletedAt)
            )
          );

        await reopenInvoiceDispenseCharges(txCtx, input.id);

        const preparedItems = input.items.map((item) => ({
          id: randomUUID(),
          ...item,
        }));
        await tx.insert(invoiceItems).values(
          preparedItems.map((item) => ({
            id: item.id,
            invoiceId: input.id,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: centsToMoney(moneyToCents(item.unitPrice) * item.quantity),
            taxable: invoiceLineTaxable(item, taxabilityByReference),
            itemType: item.itemType,
            itemId: item.itemId ?? null,
            sourcePrescriptionId: item.sourcePrescriptionId ?? null,
            sourceDispenseChargeId: item.sourceDispenseChargeId ?? null,
          })),
        );
        await markDispenseChargesInvoiced(
          txCtx,
          preparedItems
            .filter((item) => item.sourceDispenseChargeId)
            .map((item) => ({
              chargeId: item.sourceDispenseChargeId!,
              invoiceId: input.id,
              invoiceItemId: item.id,
            })),
          ctx.user,
        );

        return invoice;
      });
    }),

  listProducts: protectedProcedure
    .input(
      z.object({
        search: invoiceSearchInput,
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions: SQL[] = [
        eq(products.practiceId, ctx.practiceId),
        isNull(products.deletedAt),
      ];
      if (input.search) {
        conditions.push(ilike(products.name, `%${input.search}%`));
      }

      return ctx.db
        .select()
        .from(products)
        .where(and(...conditions))
        .orderBy(products.name)
        .limit(input.limit);
    }),

  // --- Payments ---

  recordPayment: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        operationId: z.string().uuid(),
        amount: paymentAmountSchema,
        method: z.enum(["cash", "credit_card", "debit_card", "check", "online", "other"]),
        notes: billingNotesInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const operationKey = `dashboard-payment:${ctx.practiceId}:${input.operationId}`;
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`
        );

        const [existingPayment] = await tx
          .select({
            id: payments.id,
            invoiceId: payments.invoiceId,
            amount: payments.amount,
            method: payments.method,
            notes: payments.notes,
            receivedBy: payments.receivedBy,
            receivedAt: payments.receivedAt,
            externalId: payments.externalId,
          })
          .from(payments)
          .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
          .where(
            and(
              eq(payments.externalId, operationKey),
              eq(invoices.practiceId, ctx.practiceId)
            )
          )
          .limit(1);
        if (existingPayment) {
          if (
            existingPayment.invoiceId !== input.invoiceId ||
            moneyToCents(existingPayment.amount) !== moneyToCents(input.amount) ||
            existingPayment.method !== input.method ||
            (existingPayment.notes ?? null) !== (input.notes ?? null)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "This payment operation ID was already used for different details.",
            });
          }
          return { payment: existingPayment, replayed: true as const };
        }

        const invoiceIdentity = await getInvoiceForPractice(txCtx, input.invoiceId);
        await lockAppointmentForInvoiceMutation(
          txCtx,
          invoiceIdentity.appointmentId
        );
        const invoice = invoiceIdentity.appointmentId
          ? await getInvoiceForPractice(txCtx, input.invoiceId)
          : invoiceIdentity;
        assertCanRecordPayment(invoice);
        await assertVisitInvoiceReadyForFinancialAction(
          txCtx,
          invoice.appointmentId
        );
        const totalCents = moneyToCents(invoice.total);
        const paidBeforeCents = moneyToCents(invoice.paidAmount);
        const adjustedCents = await getInvoiceAdjustmentTotalCents(
          txCtx,
          input.invoiceId
        );
        const amountCents = moneyToCents(input.amount);
        const balanceCents = invoiceBalanceCents(invoice, adjustedCents);

        if (amountCents > balanceCents) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Payment exceeds the invoice balance.",
          });
        }

        const paidAfterCents = paidBeforeCents + amountCents;
        const updates: Record<string, any> = {
          paidAmount: centsToMoney(paidAfterCents),
        };
        if (paidAfterCents + adjustedCents >= totalCents) {
          updates.status = "paid";
        }

        const [updatedInvoice] = await tx
          .update(invoices)
          .set(updates)
          .where(
            and(
              eq(invoices.id, input.invoiceId),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt),
              eq(invoices.isEstimate, false),
              eq(invoices.status, invoice.status),
              eq(invoices.paidAmount, invoice.paidAmount ?? "0"),
              invoiceAdjustmentTotalMatches(adjustedCents)
            )
          )
          .returning({ id: invoices.id });

        if (!updatedInvoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Invoice balance changed while recording payment. Refresh and try again.",
          });
        }

        const [createdPayment] = await tx
          .insert(payments)
          .values({
            invoiceId: input.invoiceId,
            amount: input.amount,
            method: input.method,
            receivedBy: ctx.user.id,
            notes: input.notes ?? null,
            externalId: operationKey,
          })
          .returning();

        if (updates.status === "paid") {
          await markCompletedVisitCloseoutPaid(txCtx, {
            appointmentId: invoice.appointmentId,
            invoiceId: invoice.id,
            source: "dashboard_payment",
            userId: ctx.user.id,
            paymentId: createdPayment!.id,
            paymentExternalId: operationKey,
          });
        }

        return {
          payment: createdPayment!,
          replayed: false as const,
          markedPaid: updates.status === "paid",
          invoiceTotal: invoice.total,
          paidAfterCents,
          adjustedCents,
          amountCents,
        };
      });

      if (result.replayed) return result.payment;

      if (result.markedPaid) {
        await dispatchWebhookEvent(ctx.practiceId, "invoice.paid", {
          id: input.invoiceId,
          paymentId: result.payment.id,
          paidAmount: centsToMoney(result.paidAfterCents),
          total: result.invoiceTotal,
          source: "dashboard",
        });
      }

      // Email the pet owner a receipt (no-op when no email on file; a lost
      // email never fails the payment).
      const receipt = await loadClientReceipt(ctx.db, input.invoiceId, {
        amountPaidCents: result.amountCents,
        balanceRemainingCents:
          moneyToCents(result.invoiceTotal) -
          result.paidAfterCents -
          result.adjustedCents,
      });
      if (receipt) {
        await deliverClientReceipt(receipt);
      }

      return result.payment;
    }),

  listPayments: protectedProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await getInvoiceForPractice(ctx, input.invoiceId);
      return ctx.db
        .select({
          id: payments.id,
          amount: payments.amount,
          method: payments.method,
          receivedAt: payments.receivedAt,
          notes: payments.notes,
          receivedByName: users.name,
        })
        .from(payments)
        .leftJoin(
          users,
          and(
            eq(payments.receivedBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .where(
          and(
            eq(payments.invoiceId, input.invoiceId),
            paymentPracticeScope(ctx),
            isNull(payments.deletedAt)
          )
        )
        .orderBy(desc(payments.receivedAt));
    }),

  /**
   * Refund a recorded payment, at most once per payment. Card payments are
   * refunded at Stripe inside the same transaction that records the refund:
   * the unique refund external id is inserted first (a concurrent attempt
   * dies on the index before reaching Stripe) and the Stripe call runs last
   * with that same id as its Stripe idempotency identity (a Stripe failure
   * rolls the local record back, and a later retry cannot move money twice).
   * Recorded as a negative payment row so paid-amount recomputation and AR
   * stay consistent.
   */
  refundPayment: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        paymentId: z.string().uuid(),
        amount: paymentAmountSchema.optional(),
        reason: clinicalTextInput(
          "Refund reason",
          BILLING_ADJUSTMENT_REASON_MAX_LENGTH
        ).min(5, "Explain why the payment is being refunded."),
        dueDate: clinicalDateInput("Due date").optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [payment] = await ctx.db
        .select({
          id: payments.id,
          invoiceId: payments.invoiceId,
          amount: payments.amount,
          method: payments.method,
          externalId: payments.externalId,
        })
        .from(payments)
        .where(
          and(
            eq(payments.id, input.paymentId),
            paymentPracticeScope(ctx),
            isNull(payments.deletedAt)
          )
        )
        .limit(1);

      if (!payment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
      }

      const originalCents = moneyToCents(payment.amount);
      if (originalCents <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only payments can be refunded.",
        });
      }

      const amountCents = input.amount
        ? moneyToCents(input.amount)
        : originalCents;
      if (amountCents <= 0 || amountCents > originalCents) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Refund exceeds the original payment.",
        });
      }

      const refundExternalId = `refund:payment:${payment.id}`;
      const invoiceIdentity = await getInvoiceForPractice(ctx, payment.invoiceId);

      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await lockAppointmentForInvoiceMutation(
          txCtx,
          invoiceIdentity.appointmentId
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${refundExternalId}, 0))`
        );

        const [existingRefund] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(
            and(
              eq(payments.externalId, refundExternalId),
              isNull(payments.deletedAt)
            )
          )
          .limit(1);
        if (existingRefund) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This payment has already been refunded.",
          });
        }

        const invoice = invoiceIdentity.appointmentId
          ? await getInvoiceForPractice(txCtx, payment.invoiceId)
          : invoiceIdentity;
        const adjustedCents = await getInvoiceAdjustmentTotalCents(
          txCtx,
          payment.invoiceId
        );
        const paidBeforeCents = moneyToCents(invoice.paidAmount);
        if (amountCents > paidBeforeCents) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Refund exceeds the amount currently paid on the invoice.",
          });
        }
        const paidAfterCents = paidBeforeCents - amountCents;
        const reopensInvoice =
          invoice.status === "paid" &&
          paidAfterCents + adjustedCents < moneyToCents(invoice.total);
        const [closeout] = invoice.appointmentId
          ? await tx
              .select({
                id: visitCloseouts.id,
                chargeDisposition: visitCloseouts.chargeDisposition,
                revision: visitCloseouts.revision,
              })
              .from(visitCloseouts)
              .where(
                and(
                  eq(visitCloseouts.practiceId, ctx.practiceId),
                  eq(visitCloseouts.appointmentId, invoice.appointmentId),
                  eq(visitCloseouts.invoiceId, invoice.id),
                  eq(visitCloseouts.status, "completed"),
                  isNull(visitCloseouts.deletedAt)
                )
              )
              .limit(1)
              .for("update")
          : [];
        const reopensCompletedPaidCloseout =
          reopensInvoice && closeout?.chargeDisposition === "paid";
        if (reopensCompletedPaidCloseout && !invoice.dueDate && !input.dueDate) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Choose a due date before refunding this paid visit into accounts receivable.",
          });
        }
        const nextStatus = reopensInvoice ? "sent" : invoice.status;
        const updates: Record<string, any> = {
          paidAmount: centsToMoney(paidAfterCents),
          status: nextStatus,
        };
        if (reopensCompletedPaidCloseout && !invoice.dueDate) {
          updates.dueDate = input.dueDate;
        }
        const nextDueDate =
          "dueDate" in updates
            ? (updates.dueDate ?? null)
            : (invoice.dueDate ?? null);

        const [createdRefund] = await tx
          .insert(payments)
          .values({
            invoiceId: payment.invoiceId,
            amount: centsToMoney(-amountCents),
            method: payment.method,
            receivedBy: ctx.user.id,
            externalId: refundExternalId,
            notes: `Refund: ${input.reason}`,
          })
          .returning();

        const [updatedInvoice] = await tx
          .update(invoices)
          .set(updates)
          .where(
            and(
              eq(invoices.id, payment.invoiceId),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt),
              eq(invoices.isEstimate, false),
              eq(invoices.status, invoice.status),
              eq(invoices.paidAmount, invoice.paidAmount ?? "0"),
              invoiceAdjustmentTotalMatches(adjustedCents)
            )
          )
          .returning({ id: invoices.id });

        if (!updatedInvoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Invoice changed while refunding. Refresh and try again.",
          });
        }

        if (reopensCompletedPaidCloseout) {
          const [updatedCloseout] = await tx
            .update(visitCloseouts)
            .set({
              chargeDisposition: "accounts_receivable",
              revision: closeout.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(visitCloseouts.id, closeout.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, "completed"),
                eq(visitCloseouts.chargeDisposition, "paid"),
                eq(visitCloseouts.revision, closeout.revision),
                isNull(visitCloseouts.deletedAt)
              )
            )
            .returning({ id: visitCloseouts.id });
          if (!updatedCloseout) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Visit closeout changed while refunding. Refresh and try again.",
            });
          }
        }

        await tx.insert(auditLog).values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          action: "payment_refunded",
          entityType: "invoice",
          entityId: invoice.id,
          changes: {
            reason: input.reason,
            originalPaymentId: payment.id,
            refundPaymentId: createdRefund!.id,
            amount: centsToMoney(amountCents),
            method: payment.method,
            priorStatus: invoice.status,
            nextStatus,
            priorPaidAmount: centsToMoney(paidBeforeCents),
            nextPaidAmount: centsToMoney(paidAfterCents),
            priorDueDate: invoice.dueDate ?? null,
            nextDueDate,
            closeoutId: closeout?.id ?? null,
            priorChargeDisposition: closeout?.chargeDisposition ?? null,
            nextChargeDisposition: reopensCompletedPaidCloseout
              ? "accounts_receivable"
              : closeout?.chargeDisposition ?? null,
            priorCloseoutRevision: closeout?.revision ?? null,
            nextCloseoutRevision: reopensCompletedPaidCloseout
              ? closeout.revision + 1
              : closeout?.revision ?? null,
          },
        });

        // Real money moves last so any failure above (including the unique
        // refund id) means Stripe was never called; a Stripe failure here
        // rolls back the local record.
        const stripeRefund = await refundStripeCheckoutPayment({
          externalId: payment.externalId,
          amountCents,
          idempotencyKey: refundExternalId,
        }).catch((err) => {
          console.error("[billing] Stripe refund failed:", err);
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "Stripe could not process the refund. Nothing was recorded.",
          });
        });

        if (stripeRefund) {
          await tx
            .update(payments)
            .set({
              notes: `${createdRefund!.notes} (Stripe refund ${stripeRefund.refundId})`,
            })
            .where(eq(payments.id, createdRefund!.id));
        }

        return {
          refund: createdRefund!,
          invoice,
          paidAfterCents,
        };
      });

      await dispatchWebhookEvent(ctx.practiceId, "invoice.refunded", {
        id: payment.invoiceId,
        paymentId: payment.id,
        refundId: result.refund.id,
        amount: centsToMoney(amountCents),
        paidAmount: centsToMoney(result.paidAfterCents),
        total: result.invoice.total,
        source: "dashboard",
      });

      return result.refund;
    }),

  /**
   * Accounts-receivable at a glance: open balance, the overdue slice of it,
   * and cash actually collected this calendar month.
   */
  arSummary: protectedProcedure.query(async ({ ctx }) => {
    const result = await ctx.db.execute(sql`
      with balances as (
        select
          i.status,
          greatest(
            i.total::numeric
              - i.paid_amount::numeric
              - coalesce((
                  select sum(a.amount::numeric)
                  from invoice_adjustments a
                  where a.invoice_id = i.id
                    and a.deleted_at is null
                ), 0),
            0
          ) as balance
        from invoices i
        where i.practice_id = ${ctx.practiceId}
          and i.deleted_at is null
          and i.is_estimate = false
          and i.status in ('sent', 'overdue')
      )
      select
        coalesce((select sum(balance) from balances), 0)::text as "outstanding",
        coalesce((select sum(balance) from balances where status = 'overdue'), 0)::text as "overdue",
        coalesce((
          select sum(p.amount::numeric)
          from payments p
          join invoices pi on pi.id = p.invoice_id
          where pi.practice_id = ${ctx.practiceId}
            and pi.deleted_at is null
            and p.deleted_at is null
            and p.received_at >= date_trunc('month', now())
        ), 0)::text as "collectedThisMonth"
    `);
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] } | null)?.rows ?? []);
    const row = (rows[0] ?? {}) as {
      outstanding?: string;
      overdue?: string;
      collectedThisMonth?: string;
    };
    return {
      outstanding: row.outstanding ?? "0",
      overdue: row.overdue ?? "0",
      collectedThisMonth: row.collectedThisMonth ?? "0",
    };
  }),

  createCardPaymentCheckout: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          status: invoices.status,
          isEstimate: invoices.isEstimate,
          appointmentId: invoices.appointmentId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          patientName: patients.name,
          currency: practices.currency,
        })
        .from(invoices)
        .innerJoin(
          clients,
          and(
            eq(invoices.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(invoices.patientId, patients.id),
            eq(patients.clientId, invoices.clientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          practices,
          and(
            eq(invoices.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            isNull(invoices.deletedAt)
          )
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }

      assertCanRecordPayment(invoice);

      if (invoice.appointmentId) {
        await ctx.db.transaction(async (tx) => {
          const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
          await lockAppointmentForInvoiceMutation(txCtx, invoice.appointmentId);
          const currentInvoice = await getInvoiceForPractice(txCtx, invoice.id);
          assertCanRecordPayment(currentInvoice);
          await assertVisitInvoiceReadyForFinancialAction(
            txCtx,
            currentInvoice.appointmentId
          );
        });
      }

      const adjustedCents = await getInvoiceAdjustmentTotalCents(
        ctx,
        input.invoiceId
      );
      const balanceCents = invoiceBalanceCents(invoice, adjustedCents);

      if (balanceCents <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No balance remaining.",
        });
      }

      const connectedAccount = billingEnforced()
        ? assertActiveStripeConnectAccount(
            await getStripeConnectPaymentAccount(ctx)
          )
        : null;
      const clientName = [invoice.clientFirstName, invoice.clientLastName]
        .filter(Boolean)
        .join(" ");
      const description = invoice.patientName
        ? `Invoice payment for ${invoice.patientName}`
        : "Invoice payment";
      const base = appBaseUrl();
      const result = await createCheckoutSession({
        invoiceId: invoice.id,
        amount: balanceCents,
        clientEmail: invoice.clientEmail,
        clientName,
        description,
        currency: invoice.currency ?? "usd",
        connectedAccountId: connectedAccount?.stripeAccountId,
        applicationFeeAmount: connectedAccount
          ? stripeConnectApplicationFeeAmount(balanceCents)
          : undefined,
        successUrl: `${base}/billing?payment=success&invoice=${invoice.id}`,
        cancelUrl: `${base}/billing?payment=cancelled&invoice=${invoice.id}`,
      });

      const checkoutUrl = result?.url;
      if (!isSafeCheckoutRedirectUrl(checkoutUrl)) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Card payments are not configured.",
        });
      }

      return { url: checkoutUrl };
    }),

  cardPaymentStatus: protectedProcedure.query(async ({ ctx }) => {
    const stripeReady = stripeConfigured();
    const connectRequired = billingEnforced();
    if (!stripeReady) {
      return {
        enabled: false,
        stripeConfigured: false,
        connectRequired,
        status: "not_configured" as const,
      };
    }

    if (!connectRequired) {
      return {
        enabled: true,
        stripeConfigured: true,
        connectRequired: false,
        status: "not_required" as const,
      };
    }

    const row = await getStripeConnectPaymentAccount(ctx);
    return {
      stripeConfigured: true,
      connectRequired: true,
      ...serializePaymentAccountStatus(row),
    };
  }),

  // --- Credits, write-offs, and voids ---

  listAdjustments: protectedProcedure
    .input(z.object({ invoiceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await getInvoiceForPractice(ctx, input.invoiceId);
      return ctx.db
        .select({
          id: invoiceAdjustments.id,
          amount: invoiceAdjustments.amount,
          type: invoiceAdjustments.type,
          reason: invoiceAdjustments.reason,
          createdAt: invoiceAdjustments.createdAt,
          createdByName: users.name,
        })
        .from(invoiceAdjustments)
        .leftJoin(
          users,
          and(
            eq(invoiceAdjustments.createdBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .where(
          and(
            eq(invoiceAdjustments.invoiceId, input.invoiceId),
            adjustmentPracticeScope(ctx),
            isNull(invoiceAdjustments.deletedAt)
          )
        )
        .orderBy(desc(invoiceAdjustments.createdAt));
    }),

  applyInvoiceAdjustment: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        invoiceId: z.string().uuid(),
        operationId: z.string().uuid(),
        type: z.enum(["credit", "write_off"]),
        amount: paymentAmountSchema,
        reason: z
          .string()
          .trim()
          .max(BILLING_ADJUSTMENT_REASON_MAX_LENGTH)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const operationKey = `dashboard-adjustment:${ctx.practiceId}:${input.operationId}`;
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`
        );

        const [existingAdjustment] = await tx
          .select({
            id: invoiceAdjustments.id,
            invoiceId: invoiceAdjustments.invoiceId,
            type: invoiceAdjustments.type,
            amount: invoiceAdjustments.amount,
            reason: invoiceAdjustments.reason,
            createdBy: invoiceAdjustments.createdBy,
            createdAt: invoiceAdjustments.createdAt,
            operationKey: invoiceAdjustments.operationKey,
            balanceAfter: invoiceAdjustments.balanceAfter,
          })
          .from(invoiceAdjustments)
          .innerJoin(invoices, eq(invoiceAdjustments.invoiceId, invoices.id))
          .where(
            and(
              eq(invoiceAdjustments.operationKey, operationKey),
              eq(invoices.practiceId, ctx.practiceId)
            )
          )
          .limit(1);
        if (existingAdjustment) {
          if (
            existingAdjustment.invoiceId !== input.invoiceId ||
            existingAdjustment.type !== input.type ||
            moneyToCents(existingAdjustment.amount) !== moneyToCents(input.amount) ||
            (existingAdjustment.reason ?? null) !== (input.reason ?? null)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This adjustment operation ID was already used for different details.",
            });
          }
          return {
            adjustment: existingAdjustment,
            replayed: true as const,
          };
        }

        const invoiceIdentity = await getInvoiceForPractice(txCtx, input.invoiceId);
        await lockAppointmentForInvoiceMutation(
          txCtx,
          invoiceIdentity.appointmentId
        );
        const invoice = invoiceIdentity.appointmentId
          ? await getInvoiceForPractice(txCtx, input.invoiceId)
          : invoiceIdentity;
        assertCanAdjustInvoice(invoice);
        await assertVisitInvoiceReadyForFinancialAction(
          txCtx,
          invoice.appointmentId
        );
        const adjustedBeforeCents = await getInvoiceAdjustmentTotalCents(
          txCtx,
          input.invoiceId
        );
        const amountCents = moneyToCents(input.amount);
        const balanceCents = invoiceBalanceCents(invoice, adjustedBeforeCents);
        const adjustedAfterCents = adjustedBeforeCents + amountCents;
        const closesInvoice =
          moneyToCents(invoice.paidAmount) + adjustedAfterCents >=
          moneyToCents(invoice.total);

        if (amountCents > balanceCents) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${adjustmentLabel(input.type)} exceeds the invoice balance.`,
          });
        }

        const invoiceUpdates: Record<string, any> = { updatedAt: new Date() };
        if (closesInvoice) {
          invoiceUpdates.status = "paid";
        }

        const [updatedInvoice] = await tx
          .update(invoices)
          .set(invoiceUpdates)
          .where(
            and(
              eq(invoices.id, input.invoiceId),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt),
              eq(invoices.isEstimate, invoice.isEstimate),
              eq(invoices.status, invoice.status),
              eq(invoices.paidAmount, invoice.paidAmount ?? "0"),
              invoiceAdjustmentTotalMatches(adjustedBeforeCents)
            )
          )
          .returning({ id: invoices.id });

        if (!updatedInvoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Invoice balance changed while applying adjustment. Refresh and try again.",
          });
        }

        const [createdAdjustment] = await tx
          .insert(invoiceAdjustments)
          .values({
            invoiceId: input.invoiceId,
            type: input.type,
            amount: input.amount,
            reason: input.reason || null,
            createdBy: ctx.user.id,
            operationKey,
            balanceAfter: centsToMoney(balanceCents - amountCents),
          })
          .returning();

        if (closesInvoice) {
          await markCompletedVisitCloseoutPaid(txCtx, {
            appointmentId: invoice.appointmentId,
            invoiceId: invoice.id,
            source: "dashboard_adjustment",
            userId: ctx.user.id,
            adjustmentId: createdAdjustment!.id,
          });
        }

        return {
          adjustment: createdAdjustment!,
          replayed: false as const,
          closesInvoice,
          invoiceTotal: invoice.total,
          invoicePaidAmount: invoice.paidAmount ?? "0.00",
          adjustedAfterCents,
          balanceDueCents: balanceCents - amountCents,
        };
      });

      if (result.replayed) {
        return {
          ...result.adjustment,
          balanceDue: result.adjustment.balanceAfter ?? "0.00",
        };
      }

      if (result.closesInvoice) {
        await dispatchWebhookEvent(ctx.practiceId, "invoice.paid", {
          id: input.invoiceId,
          adjustmentId: result.adjustment.id,
          adjustmentType: input.type,
          paidAmount: result.invoicePaidAmount,
          adjustedAmount: centsToMoney(result.adjustedAfterCents),
          total: result.invoiceTotal,
          source: "dashboard",
        });
      }

      return {
        ...result.adjustment,
        balanceDue: centsToMoney(result.balanceDueCents),
      };
    }),

  voidInvoice: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(5, "Explain why the invoice is being voided.")
          .max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const invoice = await getInvoiceForPractice(ctx, input.id);
      if (invoice.status === "paid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot void a paid invoice.",
        });
      }
      if (invoice.status === "void") {
        return invoice;
      }

      const voided = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await lockAppointmentForInvoiceMutation(txCtx, invoice.appointmentId);
        await assertInvoiceNotCompletedCloseout(txCtx, input.id);
        const adjustedCents = await getInvoiceAdjustmentTotalCents(
          txCtx,
          input.id
        );
        if (moneyToCents(invoice.paidAmount) > 0 || adjustedCents > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot void an invoice with payments or adjustments.",
          });
        }
        const linkedWork = await tx
          .select({ id: visitWorkItems.id })
          .from(visitWorkItems)
          .where(
            and(
              eq(visitWorkItems.practiceId, ctx.practiceId),
              eq(visitWorkItems.invoiceId, input.id),
              eq(visitWorkItems.status, "charged"),
              isNull(visitWorkItems.deletedAt)
            )
          )
          .for("update");
        const [updated] = await tx
          .update(invoices)
          .set({ status: "void" })
          .where(
            and(
              eq(invoices.id, input.id),
              eq(invoices.practiceId, ctx.practiceId),
              isNull(invoices.deletedAt),
              eq(invoices.status, invoice.status),
              eq(invoices.isEstimate, invoice.isEstimate),
              eq(invoices.paidAmount, invoice.paidAmount ?? "0"),
              noActivePaymentsForInvoice(),
              noActiveAdjustmentsForInvoice()
            )
          )
          .returning();

        if (!updated) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice changed while voiding. Refresh and try again.",
          });
        }

        if (!invoice.isEstimate) {
          const items = await invoiceProductItemsForStock(txCtx, input.id);
          await restoreProductStock(txCtx, items);
        }
        await reopenInvoiceDispenseCharges(txCtx, input.id);
        if (linkedWork.length > 0) {
          await tx
            .update(visitWorkItems)
            .set({
              status: "unresolved",
              invoiceId: null,
              invoiceItemId: null,
              noChargeReason: null,
              voidReason: null,
              resolvedBy: null,
              resolvedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(visitWorkItems.practiceId, ctx.practiceId),
                inArray(
                  visitWorkItems.id,
                  linkedWork.map((work) => work.id)
                ),
                eq(visitWorkItems.status, "charged"),
                eq(visitWorkItems.invoiceId, input.id),
                isNull(visitWorkItems.deletedAt)
              )
            );
        }
        await tx.insert(auditLog).values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          action: "invoice_voided",
          entityType: "invoice",
          entityId: input.id,
          changes: {
            reason: input.reason,
            priorStatus: invoice.status,
            nextStatus: "void",
            isEstimate: invoice.isEstimate,
            restoredInventory: !invoice.isEstimate,
            reopenedVisitWorkItemIds: linkedWork.map((work) => work.id),
          },
        });

        return updated!;
      });

      return voided;
    }),

  // --- Estimates ---

  convertEstimateToInvoice: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await getInvoiceForPractice(ctx, input.id);
      assertCanConvertEstimate(existing);

      const items = await invoiceProductItemsForStock(ctx, input.id);

      return ctx.db.transaction(async (tx) => {
        const [invoice] = await tx
          .update(invoices)
          .set({ isEstimate: false })
          .where(
            and(
              eq(invoices.id, input.id),
              eq(invoices.practiceId, ctx.practiceId),
              eq(invoices.isEstimate, true),
              eq(invoices.status, existing.status),
              eq(invoices.paidAmount, existing.paidAmount ?? "0"),
              isNull(invoices.deletedAt)
            )
          )
          .returning();

        if (!invoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Estimate changed while converting. Refresh and try again.",
          });
        }

        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        await deductProductStock(txCtx, items);

        return invoice;
      });
    }),
});
