import { and, desc, eq, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Database } from "@openpims/db/client";
import {
  clients,
  invoiceItems,
  invoices,
  patients,
  practices,
  wellnessEnrollments,
  wellnessPlans,
} from "@openpims/db";
import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import {
  calculateInvoiceTaxTotals,
  InvoiceTaxCalculationError,
} from "@/lib/billing/invoice-tax";
import { computeNextBillingDate } from "@/lib/wellness/billing";

export interface GeneratedWellnessInvoice {
  enrollmentId: string;
  invoiceId: string;
  nextBillingDate: string;
  amount: string;
}

export interface GenerateDueWellnessInvoicesResult {
  generated: number;
  invoices: GeneratedWellnessInvoice[];
}

function wellnessInvoiceTaxTotals(
  subtotalCents: number,
  taxRatePercent: string,
) {
  try {
    return calculateInvoiceTaxTotals(
      [{ lineTotalCents: subtotalCents, taxable: true }],
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

export async function generateDueWellnessInvoices(opts: {
  db: Database;
  practiceId: string;
  asOf: string;
  enrollmentIds?: string[];
}): Promise<GenerateDueWellnessInvoicesResult> {
  if (opts.enrollmentIds && opts.enrollmentIds.length === 0) {
    return { generated: 0, invoices: [] };
  }

  return opts.db.transaction(async (tx) => {
    const [practice] = await tx
      .select({ taxRatePercent: practices.taxRatePercent })
      .from(practices)
      .where(and(eq(practices.id, opts.practiceId), isNull(practices.deletedAt)))
      .limit(1);
    if (!practice) {
      return { generated: 0, invoices: [] };
    }

    const conditions: SQL[] = [
      eq(wellnessEnrollments.practiceId, opts.practiceId),
      eq(wellnessEnrollments.status, "active" as const),
      isNull(wellnessEnrollments.deletedAt),
      lte(wellnessEnrollments.nextBillingDate, opts.asOf),
      eq(wellnessPlans.practiceId, opts.practiceId),
      eq(wellnessPlans.active, true),
      isNull(wellnessPlans.deletedAt),
      eq(clients.practiceId, opts.practiceId),
      isNull(clients.deletedAt),
    ];
    if (opts.enrollmentIds?.length) {
      conditions.push(inArray(wellnessEnrollments.id, opts.enrollmentIds));
    }

    const dueRows = await tx
      .select({
        enrollmentId: wellnessEnrollments.id,
        clientId: wellnessEnrollments.clientId,
        patientId: patients.id,
        patientName: patients.name,
        planName: wellnessPlans.name,
        price: wellnessPlans.price,
        billingInterval: wellnessPlans.billingInterval,
        nextBillingDate: wellnessEnrollments.nextBillingDate,
      })
      .from(wellnessEnrollments)
      .innerJoin(
        wellnessPlans,
        and(
          eq(wellnessEnrollments.planId, wellnessPlans.id),
          eq(wellnessPlans.practiceId, opts.practiceId),
          eq(wellnessPlans.active, true),
          isNull(wellnessPlans.deletedAt)
        )
      )
      .innerJoin(
        clients,
        and(
          eq(wellnessEnrollments.clientId, clients.id),
          eq(clients.practiceId, opts.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .leftJoin(
        patients,
        and(
          eq(wellnessEnrollments.patientId, patients.id),
          eq(patients.clientId, wellnessEnrollments.clientId),
          eq(patients.practiceId, opts.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .where(and(...conditions))
      .orderBy(wellnessEnrollments.nextBillingDate, desc(wellnessEnrollments.createdAt));

    const generated: GeneratedWellnessInvoice[] = [];
    for (const row of dueRows) {
      const subtotalCents = moneyToCents(row.price);
      // Wellness plans do not expose a separate tax category, so preserve the
      // historical all-taxable behavior and persist it on the invoice line.
      const totals = wellnessInvoiceTaxTotals(
        subtotalCents,
        practice.taxRatePercent ?? "8.00",
      );
      const subtotal = centsToMoney(totals.subtotalCents);
      const tax = centsToMoney(totals.taxCents);
      const total = centsToMoney(totals.totalCents);
      const nextBillingDate = computeNextBillingDate(
        row.nextBillingDate,
        row.billingInterval
      );

      const [invoice] = await tx
        .insert(invoices)
        .values({
          practiceId: opts.practiceId,
          clientId: row.clientId,
          patientId: row.patientId ?? null,
          status: "sent",
          subtotal,
          tax,
          total,
          paidAmount: "0.00",
          dueDate: row.nextBillingDate,
          isEstimate: false,
        })
        .returning({ id: invoices.id });

      await tx.insert(invoiceItems).values({
        invoiceId: invoice!.id,
        description: wellnessInvoiceDescription(row.planName, row.patientName),
        quantity: 1,
        unitPrice: subtotal,
        total: subtotal,
        taxable: true,
        itemType: "service",
        itemId: null,
      });

      const [updated] = await tx
        .update(wellnessEnrollments)
        .set({ nextBillingDate })
        .where(
          and(
            eq(wellnessEnrollments.id, row.enrollmentId),
            eq(wellnessEnrollments.practiceId, opts.practiceId),
            eq(wellnessEnrollments.status, "active" as const),
            eq(wellnessEnrollments.nextBillingDate, row.nextBillingDate),
            isNull(wellnessEnrollments.deletedAt)
          )
        )
        .returning({ nextBillingDate: wellnessEnrollments.nextBillingDate });

      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Wellness enrollment billing state changed; retry the run.",
        });
      }

      generated.push({
        enrollmentId: row.enrollmentId,
        invoiceId: invoice!.id,
        nextBillingDate: updated.nextBillingDate,
        amount: total,
      });
    }

    return { generated: generated.length, invoices: generated };
  });
}

function wellnessInvoiceDescription(
  planName: string,
  patientName: string | null
): string {
  return patientName
    ? `Wellness plan: ${planName} (${patientName})`
    : `Wellness plan: ${planName}`;
}
