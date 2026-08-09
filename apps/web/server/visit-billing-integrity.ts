import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Database } from "@openpims/db/client";
import {
  invoiceItems,
  invoices,
  auditLog,
  clinicalRecordCorrections,
  labResults,
  prescriptions,
  procedures,
  vaccinationRecords,
  visitCloseouts,
  visitWorkItems,
} from "@openpims/db";
import { rowsFromExecute } from "@/lib/db/execute-rows";

type VisitBillingDb = Pick<
  Database,
  "select" | "insert" | "update" | "execute" | "transaction"
>;

export type VisitBillingContext = {
  db: VisitBillingDb;
  practiceId: string;
};

export async function markCompletedVisitCloseoutPaid(
  ctx: VisitBillingContext,
  input: {
    appointmentId: string | null | undefined;
    invoiceId: string;
    source: "dashboard_payment" | "dashboard_adjustment" | "stripe" | "stripe_connect";
    userId?: string | null;
    paymentId?: string | null;
    adjustmentId?: string | null;
    paymentExternalId?: string | null;
  }
) {
  if (!input.appointmentId) return null;

  const [closeout] = await ctx.db
    .select({
      id: visitCloseouts.id,
      chargeDisposition: visitCloseouts.chargeDisposition,
      revision: visitCloseouts.revision,
    })
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.practiceId, ctx.practiceId),
        eq(visitCloseouts.appointmentId, input.appointmentId),
        eq(visitCloseouts.invoiceId, input.invoiceId),
        eq(visitCloseouts.status, "completed"),
        isNull(visitCloseouts.deletedAt)
      )
    )
    .limit(1)
    .for("update");

  if (!closeout || closeout.chargeDisposition !== "accounts_receivable") {
    return null;
  }

  const nextRevision = closeout.revision + 1;
  const [updatedCloseout] = await ctx.db
    .update(visitCloseouts)
    .set({
      chargeDisposition: "paid",
      revision: nextRevision,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(visitCloseouts.id, closeout.id),
        eq(visitCloseouts.practiceId, ctx.practiceId),
        eq(visitCloseouts.status, "completed"),
        eq(visitCloseouts.chargeDisposition, "accounts_receivable"),
        eq(visitCloseouts.revision, closeout.revision),
        isNull(visitCloseouts.deletedAt)
      )
    )
    .returning({ id: visitCloseouts.id });
  if (!updatedCloseout) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Visit closeout changed while settling payment. Retry the operation.",
    });
  }

  await ctx.db.insert(auditLog).values({
    practiceId: ctx.practiceId,
    userId: input.userId ?? null,
    action: "visit_closeout_settled",
    entityType: "visit_closeout",
    entityId: closeout.id,
    changes: {
      invoiceId: input.invoiceId,
      source: input.source,
      paymentId: input.paymentId ?? null,
      adjustmentId: input.adjustmentId ?? null,
      paymentExternalId: input.paymentExternalId ?? null,
      priorChargeDisposition: "accounts_receivable",
      nextChargeDisposition: "paid",
      priorRevision: closeout.revision,
      nextRevision,
    },
  });

  return { closeoutId: closeout.id, priorRevision: closeout.revision, nextRevision };
}

/**
 * Re-materialize source rows that arrived through a trusted non-dashboard path.
 * Callers intentionally invoke this only for an open visit; historical closed
 * visits must not acquire new unresolved work after the fact.
 */
export async function syncVisitWorkItems(ctx: VisitBillingContext, appointmentId: string) {
  await ctx.db.transaction(async (tx) => {
    // Correction and materialization serialize on the same source row. This
    // lock statement intentionally precedes the INSERT so READ COMMITTED takes
    // a fresh snapshot for the correction exclusion after any lock wait.
    await tx.execute(sql`
      select ${vaccinationRecords.id}
      from ${vaccinationRecords}
      where ${vaccinationRecords.practiceId} = ${ctx.practiceId}
        and ${vaccinationRecords.appointmentId} = ${appointmentId}
        and ${vaccinationRecords.deletedAt} is null
      order by ${vaccinationRecords.id}
      for update
    `);
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(
          'lab-result-source:' || ${ctx.practiceId}::text || ':' || lab_source.id::text,
          0
        )
      )
      from (
        select ${labResults.id} as id
        from ${labResults}
        where ${labResults.practiceId} = ${ctx.practiceId}
          and ${labResults.appointmentId} = ${appointmentId}
          and ${labResults.deletedAt} is null
        order by ${labResults.id}
      ) as lab_source
    `);
    await tx.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, vaccination_record_id)
      select ${vaccinationRecords.practiceId}, ${vaccinationRecords.appointmentId}, ${vaccinationRecords.id}
      from ${vaccinationRecords}
      where ${vaccinationRecords.practiceId} = ${ctx.practiceId}
        and ${vaccinationRecords.appointmentId} = ${appointmentId}
        and ${vaccinationRecords.deletedAt} is null
        and not exists (
          select 1
          from ${clinicalRecordCorrections} as vaccination_correction
          where vaccination_correction.practice_id = ${ctx.practiceId}
            and vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}
        )
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, lab_result_id)
      select ${labResults.practiceId}, ${labResults.appointmentId}, ${labResults.id}
      from ${labResults}
      where ${labResults.practiceId} = ${ctx.practiceId}
        and ${labResults.appointmentId} = ${appointmentId}
        and ${labResults.deletedAt} is null
        and not exists (
          select 1
          from ${clinicalRecordCorrections} as lab_correction
          where lab_correction.practice_id = ${ctx.practiceId}
            and lab_correction.lab_result_id = ${labResults.id}
        )
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, procedure_id)
      select ${procedures.practiceId}, ${procedures.appointmentId}, ${procedures.id}
      from ${procedures}
      where ${procedures.practiceId} = ${ctx.practiceId}
        and ${procedures.appointmentId} = ${appointmentId}
        and ${procedures.deletedAt} is null
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, prescription_id)
      select ${prescriptions.practiceId}, ${prescriptions.appointmentId}, ${prescriptions.id}
      from ${prescriptions}
      where ${prescriptions.practiceId} = ${ctx.practiceId}
        and ${prescriptions.appointmentId} = ${appointmentId}
        and ${prescriptions.deletedAt} is null
      on conflict do nothing
    `);
  });
}

export async function assertNoUnresolvedVisitWork(
  ctx: VisitBillingContext,
  appointmentId: string,
  message = "Resolve every performed vaccination, lab, procedure, and prescription as charged, no charge, or void/corrected before checkout."
) {
  const rows = await ctx.db.execute(sql`
    select ${visitWorkItems.id}
    from ${visitWorkItems}
    left join ${invoiceItems}
      on ${invoiceItems.id} = ${visitWorkItems.invoiceItemId}
    left join ${invoices}
      on ${invoices.id} = ${visitWorkItems.invoiceId}
      and ${invoices.practiceId} = ${ctx.practiceId}
      and ${invoices.appointmentId} = ${appointmentId}
    where ${visitWorkItems.practiceId} = ${ctx.practiceId}
      and ${visitWorkItems.appointmentId} = ${appointmentId}
      and (
        ${visitWorkItems.status} = 'unresolved'
        or (
          ${visitWorkItems.status} = 'charged'
          and (
            ${invoiceItems.id} is null
            or ${invoiceItems.deletedAt} is not null
            or ${invoices.id} is null
            or ${invoices.deletedAt} is not null
            or ${invoices.status} = 'void'
          )
        )
      )
      and ${visitWorkItems.deletedAt} is null
    order by ${visitWorkItems.createdAt}, ${visitWorkItems.id}
    limit 1
  `);
  if (rowsFromExecute<{ id: string }>(rows).length > 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
}

/**
 * Financial actions are stable only after the clinical handoff is signed and
 * all performed work has an explicit billing disposition.
 */
export async function assertVisitInvoiceReadyForFinancialAction(
  ctx: VisitBillingContext,
  appointmentId: string | null | undefined
) {
  if (!appointmentId) return;

  const [closeout] = await ctx.db
    .select({ status: visitCloseouts.status })
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.practiceId, ctx.practiceId),
        eq(visitCloseouts.appointmentId, appointmentId),
        isNull(visitCloseouts.deletedAt)
      )
    )
    .limit(1);

  if (closeout?.status !== "clinical_finalized" && closeout?.status !== "completed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Finalize the clinical handoff before sending or collecting this visit invoice.",
    });
  }

  if (closeout.status === "clinical_finalized") {
    await syncVisitWorkItems(ctx, appointmentId);
  }
  await assertNoUnresolvedVisitWork(
    ctx,
    appointmentId,
    "Resolve every performed vaccination, lab, procedure, and prescription before sending or collecting this visit invoice."
  );
}

/**
 * Once a visit invoice is sent, its reconciliations make checkout/payment
 * stable. Corrections go through the audited invoice-void transaction, which
 * reopens every linked work item atomically.
 */
export async function assertVisitReconciliationMutable(
  ctx: VisitBillingContext,
  appointmentId: string
) {
  const [invoice] = await ctx.db
    .select({ status: invoices.status })
    .from(invoices)
    .where(
      and(
        eq(invoices.practiceId, ctx.practiceId),
        eq(invoices.appointmentId, appointmentId),
        eq(invoices.isEstimate, false),
        ne(invoices.status, "void"),
        isNull(invoices.deletedAt)
      )
    )
    .limit(1);

  if (invoice && invoice.status !== "draft") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Void the finalized visit invoice with a reason before reopening its reconciled work.",
    });
  }
}
