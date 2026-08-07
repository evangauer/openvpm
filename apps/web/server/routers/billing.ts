import { z } from "zod";
import { eq, and, isNull, desc, sql, inArray, ilike, ne, type SQL } from "drizzle-orm";
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
} from "@openpims/db";
import {
  clinicalDateInput,
  clinicalTextInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { listOffsetInput } from "./pagination";

type BillingDb = Pick<Database, "select" | "insert" | "update">;

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
};

type InvoiceAdjustmentType = "credit" | "write_off";

type PaymentAccountRow = typeof practicePaymentAccounts.$inferSelect;

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

type InvoiceLineInput = {
  description: string;
  quantity: number;
  unitPrice: string;
  itemType: "service" | "product";
  itemId?: string | null;
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
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

async function assertLineItemReferences(
  ctx: BillingContext,
  items: readonly InvoiceLineInput[]
) {
  const serviceIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "service" && item.itemId)
        .map((item) => item.itemId!)
    ),
  ];
  const productIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "product" && item.itemId)
        .map((item) => item.itemId!)
    ),
  ];

  const [serviceRows, productRows] = await Promise.all([
    serviceIds.length === 0
      ? Promise.resolve([])
      : ctx.db
          .select({ id: services.id })
          .from(services)
          .where(
            and(
              inArray(services.id, serviceIds),
              eq(services.practiceId, ctx.practiceId),
              isNull(services.deletedAt)
            )
          ),
    productIds.length === 0
      ? Promise.resolve([])
      : ctx.db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              inArray(products.id, productIds),
              eq(products.practiceId, ctx.practiceId),
              isNull(products.deletedAt)
            )
          ),
  ]);

  if (serviceRows.length !== serviceIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more services were not found",
    });
  }
  if (productRows.length !== productIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more products were not found",
    });
  }
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
        status: z.enum(["draft", "sent", "paid", "overdue", "void"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getInvoiceForPractice(ctx, input.id);
      if (existing.isEstimate && input.status !== "void") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Convert the estimate before changing invoice status.",
        });
      }
      if (existing.status === "void" && input.status !== "void") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot reopen a void invoice.",
        });
      }
      if (existing.status === "void" && input.status === "void") {
        return existing;
      }
      if (existing.status === "draft" && input.status === "paid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Mark the invoice as sent before marking it paid.",
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
      if (input.status === "paid" || input.status === "void") {
        const adjustedCents = await getInvoiceAdjustmentTotalCents(ctx, input.id);
        if (
          input.status === "void" &&
          (moneyToCents(existing.paidAmount) > 0 || adjustedCents > 0)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot void an invoice with payments or adjustments.",
          });
        }
        if (input.status === "paid") {
          updates.paidAmount = centsToMoney(
            Math.max(0, moneyToCents(existing.total) - adjustedCents)
          );
          updateConditions.push(invoiceAdjustmentTotalMatches(adjustedCents));
        }
        if (input.status === "void") {
          updateConditions.push(
            noActivePaymentsForInvoice(),
            noActiveAdjustmentsForInvoice()
          );
        }
      }

      if (input.status === "void") {
        return ctx.db.transaction(async (tx) => {
          const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
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

          if (!existing.isEstimate) {
            const items = await invoiceProductItemsForStock(txCtx, input.id);
            await restoreProductStock(txCtx, items);
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
      if (input.status === "paid" && existing.status !== "paid") {
        await dispatchWebhookEvent(ctx.practiceId, "invoice.paid", {
          id: input.id,
          paidAmount: updates.paidAmount,
          total: existing.total,
          source: "dashboard",
        });
      }
      return invoice!;
    }),

  listServices: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(services)
      .where(
        and(
          eq(services.practiceId, ctx.practiceId),
          isNull(services.deletedAt)
        )
      )
      .orderBy(services.name);
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
      await assertLineItemReferences(ctx, input.items);

      const subtotal = input.items.reduce((sum, item) => {
        return sum + item.quantity * parseFloat(item.unitPrice);
      }, 0);
      // Tax rate is configured per practice (region-aware), not hardcoded.
      const [practice] = await ctx.db
        .select({ taxRatePercent: practices.taxRatePercent })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }

      const taxRate = parseFloat(practice.taxRatePercent ?? "8.00") / 100;
      const tax = Math.round(subtotal * taxRate * 100) / 100;
      const total = Math.round((subtotal + tax) * 100) / 100;

      return ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
        if (input.appointmentId) {
          // Serialize charge capture for one visit so two front-desk tabs
          // cannot both pass the duplicate check and create competing bills.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${input.appointmentId}, 0))`
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
        if (!(input.isEstimate ?? false)) {
          await deductProductStock(txCtx, input.items);
        }

        const [invoice] = await tx
          .insert(invoices)
          .values({
            practiceId: ctx.practiceId,
            clientId: input.clientId,
            patientId: input.patientId ?? null,
            appointmentId: input.appointmentId ?? null,
            status: "draft",
            subtotal: subtotal.toFixed(2),
            tax: tax.toFixed(2),
            total: total.toFixed(2),
            paidAmount: "0.00",
            dueDate: input.dueDate ?? null,
            isEstimate: input.isEstimate ?? false,
          })
          .returning();

        if (input.items.length > 0) {
          await tx.insert(invoiceItems).values(
            input.items.map((item) => ({
              invoiceId: invoice!.id,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              total: (item.quantity * parseFloat(item.unitPrice)).toFixed(2),
              itemType: item.itemType as "service" | "product",
              itemId: item.itemId ?? null,
            }))
          );
        }

        return invoice!;
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
        amount: paymentAmountSchema,
        method: z.enum(["cash", "credit_card", "debit_card", "check", "online", "other"]),
        notes: billingNotesInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const invoice = await getInvoiceForPractice(ctx, input.invoiceId);
      assertCanRecordPayment(invoice);

      const totalCents = moneyToCents(invoice.total);
      const paidBeforeCents = moneyToCents(invoice.paidAmount);
      const adjustedCents = await getInvoiceAdjustmentTotalCents(
        ctx,
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

      const payment = await ctx.db.transaction(async (tx) => {
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
          })
          .returning();

        return createdPayment!;
      });

      if (updates.status === "paid") {
        await dispatchWebhookEvent(ctx.practiceId, "invoice.paid", {
          id: input.invoiceId,
          paymentId: payment.id,
          paidAmount: centsToMoney(paidAfterCents),
          total: invoice.total,
          source: "dashboard",
        });
      }

      // Email the pet owner a receipt (no-op when no email on file; a lost
      // email never fails the payment).
      const receipt = await loadClientReceipt(ctx.db, input.invoiceId, {
        amountPaidCents: amountCents,
        balanceRemainingCents: totalCents - paidAfterCents - adjustedCents,
      });
      if (receipt) {
        await deliverClientReceipt(receipt);
      }

      return payment;
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
        reason: z
          .string()
          .trim()
          .max(BILLING_ADJUSTMENT_REASON_MAX_LENGTH)
          .optional(),
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

      const refundExternalId = `refund:payment:${payment.id}`;
      const [existingRefund] = await ctx.db
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

      const amountCents = input.amount
        ? moneyToCents(input.amount)
        : originalCents;
      if (amountCents <= 0 || amountCents > originalCents) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Refund exceeds the original payment.",
        });
      }

      const invoice = await getInvoiceForPractice(ctx, payment.invoiceId);
      const adjustedCents = await getInvoiceAdjustmentTotalCents(
        ctx,
        payment.invoiceId
      );
      const paidBeforeCents = moneyToCents(invoice.paidAmount);
      const paidAfterCents = paidBeforeCents - amountCents;
      const updates: Record<string, any> = {
        paidAmount: centsToMoney(paidAfterCents),
      };
      if (
        invoice.status === "paid" &&
        paidAfterCents + adjustedCents < moneyToCents(invoice.total)
      ) {
        // A refunded balance reopens the invoice for collection.
        updates.status = "sent";
      }

      const refund = await ctx.db.transaction(async (tx) => {
        const [createdRefund] = await tx
          .insert(payments)
          .values({
            invoiceId: payment.invoiceId,
            amount: centsToMoney(-amountCents),
            method: payment.method,
            receivedBy: ctx.user.id,
            externalId: refundExternalId,
            notes: input.reason
              ? `Refund: ${input.reason}`
              : "Refund of recorded payment",
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

        return createdRefund!;
      });

      await dispatchWebhookEvent(ctx.practiceId, "invoice.refunded", {
        id: payment.invoiceId,
        paymentId: payment.id,
        refundId: refund.id,
        amount: centsToMoney(amountCents),
        paidAmount: centsToMoney(paidAfterCents),
        total: invoice.total,
        source: "dashboard",
      });

      return refund;
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
      const invoice = await getInvoiceForPractice(ctx, input.invoiceId);
      assertCanAdjustInvoice(invoice);

      const adjustedBeforeCents = await getInvoiceAdjustmentTotalCents(
        ctx,
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

      const adjustment = await ctx.db.transaction(async (tx) => {
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
          })
          .returning();

        return createdAdjustment!;
      });

      if (closesInvoice) {
        await dispatchWebhookEvent(ctx.practiceId, "invoice.paid", {
          id: input.invoiceId,
          adjustmentId: adjustment.id,
          adjustmentType: input.type,
          paidAmount: invoice.paidAmount ?? "0.00",
          adjustedAmount: centsToMoney(adjustedAfterCents),
          total: invoice.total,
          source: "dashboard",
        });
      }

      return {
        ...adjustment,
        balanceDue: centsToMoney(balanceCents - amountCents),
      };
    }),

  voidInvoice: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ id: z.string().uuid() }))
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

      const adjustedCents = await getInvoiceAdjustmentTotalCents(ctx, input.id);
      if (moneyToCents(invoice.paidAmount) > 0 || adjustedCents > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot void an invoice with payments or adjustments.",
        });
      }

      const voided = await ctx.db.transaction(async (tx) => {
        const txCtx: BillingContext = { db: tx, practiceId: ctx.practiceId };
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
