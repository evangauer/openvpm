import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import type { Database } from "@openpims/db/client";
import {
  appointments,
  appointmentTypes,
  clients,
  invoiceAdjustments,
  invoiceItems,
  invoices,
  patients,
  practices,
  prescriptions,
  products,
  soapNotes,
  visitCloseouts,
  users,
} from "@openpims/db";
import {
  CLOSEOUT_DIAGNOSIS_MAX_LENGTH,
  CLOSEOUT_FOLLOW_UP_NOTES_MAX_LENGTH,
  CLOSEOUT_INSTRUCTIONS_MAX_LENGTH,
  CLOSEOUT_REASON_MAX_LENGTH,
  CLOSEOUT_WARNING_SIGNS_MAX_LENGTH,
  trimmedOrNull,
} from "@/lib/encounters/closeout-policy";
import {
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import { canTransitionAppointmentStatus } from "@/lib/scheduling/appointment-status";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";

type EncounterDb = Pick<Database, "select" | "insert" | "update">;

type EncounterContext = {
  db: EncounterDb;
  practiceId: string;
};

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .nullable()
    .optional()
    .transform((value) => trimmedOrNull(value));

const clinicalDraftInput = z.object({
  appointmentId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  diagnosisSummary: optionalText("Diagnosis summary", CLOSEOUT_DIAGNOSIS_MAX_LENGTH),
  dischargeInstructions: optionalText(
    "Discharge instructions",
    CLOSEOUT_INSTRUCTIONS_MAX_LENGTH
  ),
  warningSigns: optionalText("Warning signs", CLOSEOUT_WARNING_SIGNS_MAX_LENGTH),
  noInstructionsReason: optionalText(
    "No-instructions reason",
    CLOSEOUT_REASON_MAX_LENGTH
  ),
  prescriptionDisposition: z.enum(["prescribed", "not_needed"]).nullable(),
  followUpDisposition: z.enum(["none", "needed", "scheduled"]).nullable(),
  followUpNotes: optionalText(
    "Follow-up notes",
    CLOSEOUT_FOLLOW_UP_NOTES_MAX_LENGTH
  ),
  followUpAppointmentId: z.string().uuid().nullable(),
  followUpDueDate: clinicalDateInput("Follow-up due date")
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  followUpAssignedTo: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  documentationExceptionReason: optionalText(
    "Documentation exception",
    CLOSEOUT_REASON_MAX_LENGTH
  ),
});

const finalizeClinicalInput = clinicalDraftInput.superRefine((input, ctx) => {
  const hasInstructions = Boolean(input.dischargeInstructions);
  const hasNoInstructionsReason = Boolean(input.noInstructionsReason);
  if (hasInstructions === hasNoInstructionsReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dischargeInstructions"],
      message:
        "Enter owner instructions or explain why no instructions are needed.",
    });
  }
  if (!input.prescriptionDisposition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prescriptionDisposition"],
      message: "Confirm whether this visit produced a prescription.",
    });
  }
  if (!input.followUpDisposition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["followUpDisposition"],
      message: "Choose a follow-up disposition.",
    });
    return;
  }
  if (
    input.followUpDisposition === "scheduled" &&
    !input.followUpAppointmentId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["followUpAppointmentId"],
      message: "Choose the scheduled follow-up appointment.",
    });
  }
  if (
    input.followUpDisposition === "needed" &&
    (!input.followUpDueDate || !input.followUpAssignedTo)
  ) {
    if (!input.followUpDueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpDueDate"],
        message: "Choose when the follow-up is due.",
      });
    }
    if (!input.followUpAssignedTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["followUpAssignedTo"],
        message: "Assign a staff member to own the follow-up.",
      });
    }
  }
  if (
    input.followUpDisposition !== "needed" &&
    (input.followUpDueDate || input.followUpAssignedTo)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["followUpDueDate"],
      message: "Due date and assignee are only used when follow-up is needed.",
    });
  }
});

const completeVisitInput = z
  .object({
    appointmentId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    chargeDisposition: z.enum(["paid", "accounts_receivable", "no_charge"]),
    noChargeReason: optionalText("No-charge reason", CLOSEOUT_REASON_MAX_LENGTH),
    handoffMethod: z.enum(["print", "verbal", "declined"]),
  })
  .superRefine((input, ctx) => {
    if (input.chargeDisposition === "no_charge" && !input.noChargeReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["noChargeReason"],
        message: "Explain why this visit has no charge.",
      });
    }
    if (input.chargeDisposition !== "no_charge" && input.noChargeReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["noChargeReason"],
        message: "A no-charge reason is only used for no-charge visits.",
      });
    }
  });

const reopenClinicalInput = z.object({
  appointmentId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .min(5, "Explain why the finalized handoff needs correction.")
    .max(CLOSEOUT_REASON_MAX_LENGTH),
});

const resolveNeededFollowUpInput = z
  .object({
    appointmentId: z.string().uuid(),
    expectedRevision: z.number().int().min(1),
    resolution: z.enum(["scheduled", "completed", "not_needed"]),
    resolutionAppointmentId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    notes: optionalText("Follow-up resolution notes", CLOSEOUT_REASON_MAX_LENGTH),
  })
  .superRefine((input, ctx) => {
    if (input.resolution === "scheduled" && !input.resolutionAppointmentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolutionAppointmentId"],
        message: "Choose the scheduled follow-up appointment.",
      });
    }
    if (
      input.resolution !== "scheduled" &&
      input.resolutionAppointmentId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolutionAppointmentId"],
        message: "Only scheduled resolutions can link an appointment.",
      });
    }
    if (input.resolution !== "scheduled" && !input.notes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message: "Document how the follow-up obligation was resolved.",
      });
    }
  });

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1 from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function lockAppointment(
  ctx: EncounterContext,
  appointmentId: string
) {
  const [appointment] = await ctx.db
    .select({
      id: appointments.id,
      status: appointments.status,
      startTime: appointments.startTime,
      patientId: appointments.patientId,
      clientId: appointments.clientId,
      requiresDoctor: appointmentTypes.requiresDoctor,
      practiceTimezone: practices.timezone,
    })
    .from(appointments)
    .innerJoin(
      practices,
      and(
        eq(appointments.practiceId, practices.id),
        eq(practices.id, ctx.practiceId),
        isNull(practices.deletedAt)
      )
    )
    .leftJoin(
      appointmentTypes,
      and(
        eq(appointments.typeId, appointmentTypes.id),
        eq(appointmentTypes.practiceId, ctx.practiceId),
        isNull(appointmentTypes.deletedAt)
      )
    )
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(appointments.deletedAt)
      )
    )
    .limit(1)
    .for("update", { of: appointments });

  if (!appointment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
  }
  if (!appointment.patientId || !appointment.clientId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Attach a patient and client before closing this visit.",
    });
  }

  const [patient] = await ctx.db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, appointment.patientId),
        eq(patients.clientId, appointment.clientId),
        eq(patients.practiceId, ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);
  if (!patient) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The appointment patient and client no longer match.",
    });
  }
  return { ...appointment, patientId: appointment.patientId, clientId: appointment.clientId };
}

async function getCloseoutRow(ctx: EncounterContext, appointmentId: string) {
  const [closeout] = await ctx.db
    .select()
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.appointmentId, appointmentId),
        eq(visitCloseouts.practiceId, ctx.practiceId),
        isNull(visitCloseouts.deletedAt)
      )
    )
    .limit(1);
  return closeout ?? null;
}

function assertOpenForClinical(status: string) {
  if (status !== "in_exam") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Start the exam before preparing the clinical closeout.",
    });
  }
}

function sameClinicalPayload(
  row: typeof visitCloseouts.$inferSelect,
  input: z.infer<typeof clinicalDraftInput>
) {
  return (
    row.diagnosisSummary === input.diagnosisSummary &&
    row.dischargeInstructions === input.dischargeInstructions &&
    row.warningSigns === input.warningSigns &&
    row.noInstructionsReason === input.noInstructionsReason &&
    row.prescriptionDisposition === input.prescriptionDisposition &&
    row.followUpDisposition === input.followUpDisposition &&
    row.followUpNotes === input.followUpNotes &&
    row.followUpAppointmentId === input.followUpAppointmentId &&
    row.followUpDueDate === input.followUpDueDate &&
    row.followUpAssignedTo === input.followUpAssignedTo &&
    row.documentationExceptionReason === input.documentationExceptionReason
  );
}

function clinicalDraftValues(input: z.infer<typeof clinicalDraftInput>) {
  return {
    diagnosisSummary: input.diagnosisSummary,
    dischargeInstructions: input.dischargeInstructions,
    warningSigns: input.warningSigns,
    noInstructionsReason: input.noInstructionsReason,
    prescriptionDisposition: input.prescriptionDisposition,
    followUpDisposition: input.followUpDisposition,
    followUpNotes: input.followUpNotes,
    followUpAppointmentId: input.followUpAppointmentId,
    followUpDueDate: input.followUpDueDate,
    followUpAssignedTo: input.followUpAssignedTo,
    documentationExceptionReason: input.documentationExceptionReason,
  };
}

function assertAmendmentAppointmentState(
  appointmentStatus: string,
  closeoutStatus: (typeof visitCloseouts.$inferSelect)["status"]
) {
  const isOpenFinalizedVisit =
    closeoutStatus === "clinical_finalized" && appointmentStatus === "in_exam";
  const isCompletedVisit =
    closeoutStatus === "completed" && appointmentStatus === "checked_out";
  if (!isOpenFinalizedVisit && !isCompletedVisit) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The signed clinical handoff and appointment state no longer match. Refresh before amending.",
    });
  }
}

async function appointmentInvoiceRows(
  ctx: EncounterContext,
  appointmentId: string,
  patientId: string,
  clientId: string,
  lock = false
) {
  const query = ctx.db
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.appointmentId, appointmentId),
        eq(invoices.patientId, patientId),
        eq(invoices.clientId, clientId),
        eq(invoices.practiceId, ctx.practiceId),
        eq(invoices.isEstimate, false),
        ne(invoices.status, "void"),
        isNull(invoices.deletedAt)
      )
    )
    .orderBy(desc(invoices.createdAt));
  return lock ? query.for("update") : query;
}

async function invoiceReadiness(
  ctx: EncounterContext,
  row: Awaited<ReturnType<typeof appointmentInvoiceRows>>[number]
) {
  const [[itemsSummary], [adjustmentsSummary]] = await Promise.all([
    ctx.db
      .select({ itemCount: sql<number>`count(*)::int` })
      .from(invoiceItems)
      .where(
        and(
          eq(invoiceItems.invoiceId, row.id),
          isNull(invoiceItems.deletedAt)
        )
      ),
    ctx.db
      .select({
        adjustedAmount: sql<string>`coalesce(sum(${invoiceAdjustments.amount}), 0)::text`,
      })
      .from(invoiceAdjustments)
      .where(
        and(
          eq(invoiceAdjustments.invoiceId, row.id),
          isNull(invoiceAdjustments.deletedAt)
        )
      ),
  ]);
  const adjustedAmount = adjustmentsSummary?.adjustedAmount ?? "0";
  const adjustedCents = moneyToCents(adjustedAmount);
  return {
    ...row,
    itemCount: itemsSummary?.itemCount ?? 0,
    adjustedAmount,
    balanceDueCents: invoiceBalanceCents(row, adjustedCents),
  };
}

export const encountersRouter = createRouter({
  listPendingFollowUps: protectedProcedure.query(async ({ ctx }) =>
    ctx.db
      .select({
        closeoutId: visitCloseouts.id,
        appointmentId: visitCloseouts.appointmentId,
        closeoutStatus: visitCloseouts.status,
        revision: visitCloseouts.revision,
        dueDate: visitCloseouts.followUpDueDate,
        assignedTo: visitCloseouts.followUpAssignedTo,
        assigneeName: visitCloseouts.followUpAssigneeName,
        followUpNotes: visitCloseouts.followUpNotes,
        resolution: visitCloseouts.followUpResolution,
        resolutionAppointmentId:
          visitCloseouts.followUpResolutionAppointmentId,
        resolutionScheduledAt: visitCloseouts.followUpResolutionScheduledAt,
        resolutionNotes: visitCloseouts.followUpResolutionNotes,
        resolvedAt: visitCloseouts.followUpResolvedAt,
        resolvedBy: visitCloseouts.followUpResolvedBy,
        resolverName: visitCloseouts.followUpResolverName,
        patientId: patients.id,
        patientName: patients.name,
        clientId: clients.id,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        visitStartedAt: appointments.startTime,
      })
      .from(visitCloseouts)
      .innerJoin(
        appointments,
        and(
          eq(visitCloseouts.appointmentId, appointments.id),
          eq(appointments.practiceId, ctx.practiceId),
          isNull(appointments.deletedAt)
        )
      )
      .innerJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .innerJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(visitCloseouts.practiceId, ctx.practiceId),
          eq(visitCloseouts.followUpDisposition, "needed"),
          inArray(visitCloseouts.status, ["clinical_finalized", "completed"]),
          isNull(visitCloseouts.followUpResolvedAt),
          activePracticePredicate(ctx.practiceId),
          isNull(visitCloseouts.deletedAt)
        )
      )
      .orderBy(asc(visitCloseouts.followUpDueDate), asc(visitCloseouts.createdAt))
  ),

  getCloseout: protectedProcedure
    .input(z.object({ appointmentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [appointment] = await ctx.db
        .select({
          id: appointments.id,
          patientId: appointments.patientId,
          clientId: appointments.clientId,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
        })
        .from(appointments)
        .innerJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);
      if (!appointment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
      }

      const [
        closeout,
        linkedSoapRows,
        medications,
        followUpAppointments,
        followUpAssignees,
      ] = await Promise.all([
          getCloseoutRow(ctx, input.appointmentId),
          ctx.db
            .select({ id: soapNotes.id })
            .from(soapNotes)
            .where(
              and(
                eq(soapNotes.appointmentId, input.appointmentId),
                eq(soapNotes.practiceId, ctx.practiceId),
                isNull(soapNotes.deletedAt)
              )
            ),
          ctx.db
            .select({
              id: prescriptions.id,
              medicationName: prescriptions.medicationName,
              dosage: prescriptions.dosage,
              frequency: prescriptions.frequency,
              instructions: prescriptions.instructions,
              quantity: prescriptions.quantity,
              productId: prescriptions.productId,
              productName: products.name,
              productUnitPrice: products.unitPrice,
            })
            .from(prescriptions)
            .leftJoin(
              products,
              and(
                eq(prescriptions.productId, products.id),
                eq(products.practiceId, ctx.practiceId),
                isNull(products.deletedAt)
              )
            )
            .where(
              and(
                eq(prescriptions.appointmentId, input.appointmentId),
                eq(prescriptions.practiceId, ctx.practiceId),
                isNull(prescriptions.deletedAt)
              )
            )
            .orderBy(desc(prescriptions.createdAt)),
          appointment.patientId && appointment.clientId
            ? ctx.db
                .select({
                  id: appointments.id,
                  startTime: appointments.startTime,
                  status: appointments.status,
                })
                .from(appointments)
                .where(
                  and(
                    eq(appointments.patientId, appointment.patientId),
                    eq(appointments.clientId, appointment.clientId),
                    eq(appointments.practiceId, ctx.practiceId),
                    gt(appointments.startTime, new Date()),
                    inArray(appointments.status, ["scheduled", "confirmed"]),
                    isNull(appointments.deletedAt)
                  )
                )
                .orderBy(appointments.startTime)
                .limit(25)
            : Promise.resolve([]),
          ctx.db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              role: users.role,
            })
            .from(users)
            .where(
              and(
                eq(users.practiceId, ctx.practiceId),
                inArray(users.role, [
                  "admin",
                  "veterinarian",
                  "technician",
                  "front_desk",
                ]),
                activePracticePredicate(ctx.practiceId),
                isNull(users.deletedAt)
              )
            )
            .orderBy(asc(users.name), asc(users.email))
            .limit(100),
        ]);

      const rawInvoices =
        appointment.patientId && appointment.clientId
          ? await appointmentInvoiceRows(
              ctx,
              input.appointmentId,
              appointment.patientId,
              appointment.clientId
            )
          : [];
      const invoiceSummaries = await Promise.all(
        rawInvoices.map((invoice) => invoiceReadiness(ctx, invoice))
      );

      return {
        closeout,
        practice: {
          name: appointment.practiceName,
          phone: appointment.practicePhone,
          timezone: appointment.practiceTimezone,
        },
        linkedSoapCount: linkedSoapRows.length,
        medications,
        followUpAppointments,
        followUpAssignees,
        invoices: invoiceSummaries,
      };
    }),

  saveDraft: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(clinicalDraftInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const txCtx: EncounterContext = { db: tx, practiceId: ctx.practiceId };
        const appointment = await lockAppointment(txCtx, input.appointmentId);
        const existing = await getCloseoutRow(txCtx, input.appointmentId);

        if (existing?.amendmentDraft) {
          assertAmendmentAppointmentState(appointment.status, existing.status);
          if (existing.revision !== input.expectedRevision) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Closeout changed in another session. Refresh before saving.",
            });
          }
          const [saved] = await tx
            .update(visitCloseouts)
            .set({
              amendmentDraft: {
                ...existing.amendmentDraft,
                ...clinicalDraftValues(input),
              },
              revision: existing.revision + 1,
            })
            .where(
              and(
                eq(visitCloseouts.id, existing.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, existing.status),
                eq(visitCloseouts.revision, existing.revision),
                sql`${visitCloseouts.amendmentDraft} is not null`,
                isNull(visitCloseouts.deletedAt)
              )
            )
            .returning();
          if (!saved) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Closeout changed; refresh and retry.",
            });
          }
          return saved;
        }

        if (existing && existing.status !== "draft") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Clinical closeout is signed. Start an attributed amendment before editing it.",
          });
        }
        assertOpenForClinical(appointment.status);
        const revision = existing?.revision ?? 0;
        if (revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Closeout changed in another session. Refresh before saving.",
          });
        }
        const values = {
          ...clinicalDraftValues(input),
          revision: revision + 1,
        };
        if (existing) {
          const [saved] = await tx
            .update(visitCloseouts)
            .set(values)
            .where(
              and(
                eq(visitCloseouts.id, existing.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, "draft"),
                eq(visitCloseouts.revision, revision),
                isNull(visitCloseouts.deletedAt)
              )
            )
            .returning();
          if (!saved) {
            throw new TRPCError({ code: "CONFLICT", message: "Closeout changed; refresh and retry." });
          }
          return saved;
        }
        const [saved] = await tx
          .insert(visitCloseouts)
          .values({
            ...values,
            practiceId: ctx.practiceId,
            appointmentId: input.appointmentId,
          })
          .returning();
        return saved!;
      })
    ),

  finalizeClinical: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(finalizeClinicalInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const txCtx: EncounterContext = { db: tx, practiceId: ctx.practiceId };
        const appointment = await lockAppointment(txCtx, input.appointmentId);
        if (
          appointment.requiresDoctor !== 0 &&
          ctx.user.role !== "veterinarian"
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "A veterinarian must finalize instructions for a doctor-required visit.",
          });
        }
        const existing = await getCloseoutRow(txCtx, input.appointmentId);
        const amendmentDraft = existing?.amendmentDraft ?? null;
        if (amendmentDraft && existing) {
          assertAmendmentAppointmentState(appointment.status, existing.status);
        } else if (existing && existing.status !== "draft") {
          if (sameClinicalPayload(existing, input)) return existing;
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Clinical closeout is signed. Start an attributed amendment before replacing it.",
          });
        } else {
          assertOpenForClinical(appointment.status);
        }
        const revision = existing?.revision ?? 0;
        if (revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Closeout changed in another session. Refresh before finalizing.",
          });
        }

        const [soap] = await tx
          .select({ id: soapNotes.id })
          .from(soapNotes)
          .where(
            and(
              eq(soapNotes.appointmentId, input.appointmentId),
              eq(soapNotes.practiceId, ctx.practiceId),
              isNull(soapNotes.deletedAt)
            )
          )
          .limit(1);
        if (!soap && !input.documentationExceptionReason) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Link a SOAP note or document why one is not required.",
          });
        }

        const medicationSnapshot = await tx
          .select({
            prescriptionId: prescriptions.id,
            medicationName: prescriptions.medicationName,
            dosage: prescriptions.dosage,
            frequency: prescriptions.frequency,
            instructions: prescriptions.instructions,
            quantity: prescriptions.quantity,
          })
          .from(prescriptions)
          .where(
            and(
              eq(prescriptions.appointmentId, input.appointmentId),
              eq(prescriptions.patientId, appointment.patientId),
              eq(prescriptions.practiceId, ctx.practiceId),
              eq(prescriptions.status, "active"),
              isNull(prescriptions.deletedAt)
            )
          )
          .orderBy(prescriptions.createdAt);
        if (
          input.prescriptionDisposition === "prescribed" &&
          medicationSnapshot.length === 0
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Create and link the visit prescription before finalizing.",
          });
        }
        if (
          input.prescriptionDisposition === "not_needed" &&
          medicationSnapshot.length > 0
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This visit has linked prescriptions. Confirm that prescriptions were provided.",
          });
        }

        let followUpScheduledAt: Date | null = null;
        let followUpAssigneeName: string | null = null;
        if (input.followUpDisposition === "scheduled") {
          const [followUp] = await tx
            .select({
              id: appointments.id,
              startTime: appointments.startTime,
            })
            .from(appointments)
            .where(
              and(
                eq(appointments.id, input.followUpAppointmentId!),
                eq(appointments.patientId, appointment.patientId),
                eq(appointments.clientId, appointment.clientId),
                eq(appointments.practiceId, ctx.practiceId),
                gt(appointments.startTime, new Date()),
                inArray(appointments.status, ["scheduled", "confirmed"]),
                isNull(appointments.deletedAt)
              )
            )
            .limit(1);
          if (!followUp) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The selected follow-up appointment is no longer available.",
            });
          }
          followUpScheduledAt = followUp.startTime;
        } else if (input.followUpDisposition === "needed") {
          const today = formatDateInputForTimeZone(
            new Date(),
            appointment.practiceTimezone
          );
          if (!input.followUpDueDate || input.followUpDueDate < today) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Follow-up due date cannot be before today.",
            });
          }
          const [assignee] = await tx
            .select({ name: users.name, email: users.email })
            .from(users)
            .where(
              and(
                eq(users.id, input.followUpAssignedTo!),
                eq(users.practiceId, ctx.practiceId),
                inArray(users.role, [
                  "admin",
                  "veterinarian",
                  "technician",
                  "front_desk",
                ]),
                activePracticePredicate(ctx.practiceId),
                isNull(users.deletedAt)
              )
            )
            .limit(1);
          if (!assignee) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The assigned follow-up owner is no longer active.",
            });
          }
          followUpAssigneeName = assignee.name?.trim() || assignee.email;
        }

        const now = new Date();
        const preserveFollowUpResolution = Boolean(
          amendmentDraft &&
            existing &&
            input.followUpDisposition === "needed" &&
            existing.followUpDisposition === "needed" &&
            existing.followUpDueDate === input.followUpDueDate &&
            existing.followUpAssignedTo === input.followUpAssignedTo
        );
        const values = {
          ...clinicalDraftValues(input),
          followUpAppointmentId:
            input.followUpDisposition === "scheduled"
              ? input.followUpAppointmentId
              : null,
          followUpScheduledAt,
          followUpDueDate:
            input.followUpDisposition === "needed"
              ? input.followUpDueDate
              : null,
          followUpAssignedTo:
            input.followUpDisposition === "needed"
              ? input.followUpAssignedTo
              : null,
          followUpAssigneeName,
          followUpResolution: preserveFollowUpResolution
            ? existing?.followUpResolution ?? null
            : null,
          followUpResolutionAppointmentId: preserveFollowUpResolution
            ? existing?.followUpResolutionAppointmentId ?? null
            : null,
          followUpResolutionScheduledAt: preserveFollowUpResolution
            ? existing?.followUpResolutionScheduledAt ?? null
            : null,
          followUpResolutionNotes: preserveFollowUpResolution
            ? existing?.followUpResolutionNotes ?? null
            : null,
          followUpResolvedAt: preserveFollowUpResolution
            ? existing?.followUpResolvedAt ?? null
            : null,
          followUpResolvedBy: preserveFollowUpResolution
            ? existing?.followUpResolvedBy ?? null
            : null,
          followUpResolverName: preserveFollowUpResolution
            ? existing?.followUpResolverName ?? null
            : null,
          medicationSnapshot,
          status:
            amendmentDraft && existing
              ? existing.status
              : ("clinical_finalized" as const),
          clinicalFinalizedAt: now,
          clinicalFinalizedBy: ctx.user.id,
          clinicalFinalizerName: ctx.user.name,
          revision: revision + 1,
        };
        if (existing && amendmentDraft) {
          if (
            !existing.clinicalFinalizedAt ||
            !existing.clinicalFinalizedBy ||
            !existing.clinicalFinalizerName ||
            !existing.prescriptionDisposition ||
            !existing.followUpDisposition
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "The signed handoff is incomplete and cannot be superseded safely.",
            });
          }
          const priorVersion = {
            priorRevision: amendmentDraft.baseRevision,
            reason: amendmentDraft.reason,
            reopenedAt: amendmentDraft.reopenedAt,
            reopenedBy: amendmentDraft.reopenedBy,
            reopenedByName: amendmentDraft.reopenedByName,
            clinicalFinalizedAt: existing.clinicalFinalizedAt.toISOString(),
            clinicalFinalizedBy: existing.clinicalFinalizedBy,
            clinicalFinalizerName: existing.clinicalFinalizerName,
            diagnosisSummary: existing.diagnosisSummary,
            dischargeInstructions: existing.dischargeInstructions,
            warningSigns: existing.warningSigns,
            noInstructionsReason: existing.noInstructionsReason,
            prescriptionDisposition: existing.prescriptionDisposition,
            medicationSnapshot: existing.medicationSnapshot,
            followUpDisposition: existing.followUpDisposition,
            followUpNotes: existing.followUpNotes,
            followUpAppointmentId: existing.followUpAppointmentId,
            followUpScheduledAt:
              existing.followUpScheduledAt?.toISOString() ?? null,
            followUpDueDate: existing.followUpDueDate,
            followUpAssignedTo: existing.followUpAssignedTo,
            followUpAssigneeName: existing.followUpAssigneeName,
            followUpResolution: existing.followUpResolution,
            followUpResolutionAppointmentId:
              existing.followUpResolutionAppointmentId,
            followUpResolutionScheduledAt:
              existing.followUpResolutionScheduledAt?.toISOString() ?? null,
            followUpResolutionNotes: existing.followUpResolutionNotes,
            followUpResolvedAt:
              existing.followUpResolvedAt?.toISOString() ?? null,
            followUpResolvedBy: existing.followUpResolvedBy,
            followUpResolverName: existing.followUpResolverName,
            documentationExceptionReason: existing.documentationExceptionReason,
          };
          const [finalized] = await tx
            .update(visitCloseouts)
            .set({
              ...values,
              amendmentHistory: [
                ...existing.amendmentHistory,
                priorVersion,
              ],
              amendmentDraft: null,
            })
            .where(
              and(
                eq(visitCloseouts.id, existing.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, existing.status),
                eq(visitCloseouts.revision, revision),
                sql`${visitCloseouts.amendmentDraft} is not null`,
                isNull(visitCloseouts.deletedAt)
              )
            )
            .returning();
          if (!finalized) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Closeout changed; refresh and retry.",
            });
          }
          return finalized;
        }
        if (existing) {
          const [finalized] = await tx
            .update(visitCloseouts)
            .set(values)
            .where(
              and(
                eq(visitCloseouts.id, existing.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, "draft"),
                eq(visitCloseouts.revision, revision),
                isNull(visitCloseouts.deletedAt)
              )
            )
            .returning();
          if (!finalized) {
            throw new TRPCError({ code: "CONFLICT", message: "Closeout changed; refresh and retry." });
          }
          return finalized;
        }
        const [finalized] = await tx
          .insert(visitCloseouts)
          .values({
            ...values,
            practiceId: ctx.practiceId,
            appointmentId: input.appointmentId,
          })
          .returning();
        return finalized!;
      })
    ),

  reopenClinical: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(reopenClinicalInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const txCtx: EncounterContext = { db: tx, practiceId: ctx.practiceId };
        const appointment = await lockAppointment(txCtx, input.appointmentId);
        const closeout = await getCloseoutRow(txCtx, input.appointmentId);
        if (
          closeout?.amendmentDraft?.baseRevision === input.expectedRevision &&
          closeout.amendmentDraft.reopenedBy === ctx.user.id &&
          closeout.amendmentDraft.reason === input.reason
        ) {
          assertAmendmentAppointmentState(appointment.status, closeout.status);
          return closeout;
        }
        if (
          !closeout ||
          (closeout.status !== "clinical_finalized" &&
            closeout.status !== "completed")
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Only a signed clinical handoff can be amended.",
          });
        }
        assertAmendmentAppointmentState(appointment.status, closeout.status);
        if (closeout.amendmentDraft) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "An attributed amendment is already in progress. Refresh to continue it.",
          });
        }
        if (closeout.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Closeout changed in another session. Refresh before amending.",
          });
        }
        if (
          !closeout.clinicalFinalizedAt ||
          !closeout.clinicalFinalizedBy ||
          !closeout.clinicalFinalizerName ||
          !closeout.prescriptionDisposition ||
          !closeout.followUpDisposition
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "The finalized handoff is incomplete and cannot be amended safely.",
          });
        }

        const amendmentDraft = {
          baseRevision: closeout.revision,
          reason: input.reason,
          reopenedAt: new Date().toISOString(),
          reopenedBy: ctx.user.id,
          reopenedByName: ctx.user.name,
          diagnosisSummary: closeout.diagnosisSummary,
          dischargeInstructions: closeout.dischargeInstructions,
          warningSigns: closeout.warningSigns,
          noInstructionsReason: closeout.noInstructionsReason,
          prescriptionDisposition: closeout.prescriptionDisposition,
          followUpDisposition: closeout.followUpDisposition,
          followUpNotes: closeout.followUpNotes,
          followUpAppointmentId: closeout.followUpAppointmentId,
          followUpDueDate: closeout.followUpDueDate ?? null,
          followUpAssignedTo: closeout.followUpAssignedTo ?? null,
          documentationExceptionReason: closeout.documentationExceptionReason,
        };
        const [reopened] = await tx
          .update(visitCloseouts)
          .set({
            amendmentDraft,
            revision: closeout.revision + 1,
          })
          .where(
            and(
              eq(visitCloseouts.id, closeout.id),
              eq(visitCloseouts.practiceId, ctx.practiceId),
              eq(visitCloseouts.status, closeout.status),
              eq(visitCloseouts.revision, closeout.revision),
              sql`${visitCloseouts.amendmentDraft} is null`,
              isNull(visitCloseouts.deletedAt)
            )
          )
          .returning();
        if (!reopened) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Closeout changed while reopening. Refresh and try again.",
          });
        }
        return reopened;
      })
    ),

  resolveNeededFollowUp: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(resolveNeededFollowUpInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const txCtx: EncounterContext = { db: tx, practiceId: ctx.practiceId };
        const appointment = await lockAppointment(txCtx, input.appointmentId);
        const closeout = await getCloseoutRow(txCtx, input.appointmentId);
        if (
          !closeout ||
          (closeout.status !== "clinical_finalized" &&
            closeout.status !== "completed") ||
          closeout.followUpDisposition !== "needed"
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This signed handoff has no pending follow-up obligation.",
          });
        }
        assertAmendmentAppointmentState(appointment.status, closeout.status);

        if (closeout.followUpResolvedAt) {
          if (
            closeout.followUpResolution === input.resolution &&
            closeout.followUpResolutionAppointmentId ===
              input.resolutionAppointmentId &&
            closeout.followUpResolutionNotes === input.notes
          ) {
            return closeout;
          }
          throw new TRPCError({
            code: "CONFLICT",
            message: "This follow-up obligation is already resolved.",
          });
        }
        if (closeout.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Closeout changed in another session. Refresh before resolving follow-up.",
          });
        }

        let resolutionScheduledAt: Date | null = null;
        if (input.resolution === "scheduled") {
          const [followUp] = await tx
            .select({ id: appointments.id, startTime: appointments.startTime })
            .from(appointments)
            .where(
              and(
                eq(appointments.id, input.resolutionAppointmentId!),
                eq(appointments.patientId, appointment.patientId),
                eq(appointments.clientId, appointment.clientId),
                eq(appointments.practiceId, ctx.practiceId),
                gt(appointments.startTime, new Date()),
                inArray(appointments.status, ["scheduled", "confirmed"]),
                isNull(appointments.deletedAt)
              )
            )
            .limit(1);
          if (!followUp) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The selected follow-up appointment is no longer available.",
            });
          }
          resolutionScheduledAt = followUp.startTime;
        }

        const now = new Date();
        const [resolved] = await tx
          .update(visitCloseouts)
          .set({
            followUpResolution: input.resolution,
            followUpResolutionAppointmentId:
              input.resolution === "scheduled"
                ? input.resolutionAppointmentId
                : null,
            followUpResolutionScheduledAt: resolutionScheduledAt,
            followUpResolutionNotes: input.notes,
            followUpResolvedAt: now,
            followUpResolvedBy: ctx.user.id,
            followUpResolverName: ctx.user.name,
            revision: closeout.revision + 1,
          })
          .where(
            and(
              eq(visitCloseouts.id, closeout.id),
              eq(visitCloseouts.practiceId, ctx.practiceId),
              eq(visitCloseouts.status, closeout.status),
              eq(visitCloseouts.followUpDisposition, "needed"),
              eq(visitCloseouts.revision, closeout.revision),
              isNull(visitCloseouts.followUpResolvedAt),
              isNull(visitCloseouts.deletedAt)
            )
          )
          .returning();
        if (!resolved) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Follow-up changed; refresh and retry.",
          });
        }
        return resolved;
      })
    ),

  completeVisit: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(completeVisitInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const txCtx: EncounterContext = { db: tx, practiceId: ctx.practiceId };
        const appointment = await lockAppointment(txCtx, input.appointmentId);
        const closeout = await getCloseoutRow(txCtx, input.appointmentId);

        if (appointment.status === "checked_out") {
          if (
            closeout?.status === "completed" &&
            closeout.chargeDisposition === input.chargeDisposition &&
            closeout.handoffMethod === input.handoffMethod &&
            closeout.noChargeReason === input.noChargeReason
          ) {
            return { closeout, appointment };
          }
          throw new TRPCError({
            code: "CONFLICT",
            message: "This visit is already checked out. Refresh to view its saved closeout.",
          });
        }
        if (!canTransitionAppointmentStatus(appointment.status, "checked_out")) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This appointment is not ready for checkout.",
          });
        }
        if (!closeout || closeout.status !== "clinical_finalized") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Finalize the clinical handoff before completing the visit.",
          });
        }
        if (closeout.amendmentDraft) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Finish the attributed clinical amendment before completing the visit.",
          });
        }
        if (closeout.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Closeout changed in another session. Refresh before completing the visit.",
          });
        }

        const invoiceRows = await appointmentInvoiceRows(
          txCtx,
          input.appointmentId,
          appointment.patientId,
          appointment.clientId,
          true
        );
        if (invoiceRows.length > 1) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "This visit has multiple active invoices. Resolve them before checkout.",
          });
        }
        const invoice = invoiceRows[0]
          ? await invoiceReadiness(txCtx, invoiceRows[0])
          : null;
        let invoiceId: string | null = null;
        if (input.chargeDisposition === "no_charge") {
          if (invoice) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Void or resolve the active visit invoice before marking no charge.",
            });
          }
        } else {
          if (!invoice || invoice.itemCount < 1) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Save at least one visit charge before checkout.",
            });
          }
          if (
            input.chargeDisposition === "paid" &&
            (invoice.status !== "paid" || invoice.balanceDueCents !== 0)
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "The visit invoice is not fully paid.",
            });
          }
          if (
            input.chargeDisposition === "accounts_receivable" &&
            (!["sent", "overdue"].includes(invoice.status) ||
              !invoice.dueDate ||
              invoice.balanceDueCents <= 0)
          ) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Pay-later visits need a sent invoice, due date, and open balance.",
            });
          }
          invoiceId = invoice.id;
        }

        const now = new Date();
        const [completed] = await tx
          .update(visitCloseouts)
          .set({
            status: "completed",
            chargeDisposition: input.chargeDisposition,
            invoiceId,
            noChargeReason:
              input.chargeDisposition === "no_charge"
                ? input.noChargeReason
                : null,
            handoffMethod: input.handoffMethod,
            completedAt: now,
            completedBy: ctx.user.id,
            revision: closeout.revision + 1,
          })
          .where(
            and(
              eq(visitCloseouts.id, closeout.id),
              eq(visitCloseouts.practiceId, ctx.practiceId),
              eq(visitCloseouts.status, "clinical_finalized"),
              eq(visitCloseouts.revision, closeout.revision),
              isNull(visitCloseouts.deletedAt)
            )
          )
          .returning();
        if (!completed) {
          throw new TRPCError({ code: "CONFLICT", message: "Closeout changed; refresh and retry." });
        }
        const [checkedOut] = await tx
          .update(appointments)
          .set({ status: "checked_out" })
          .where(
            and(
              eq(appointments.id, input.appointmentId),
              eq(appointments.practiceId, ctx.practiceId),
              eq(appointments.status, appointment.status),
              isNull(appointments.deletedAt)
            )
          )
          .returning();
        if (!checkedOut) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Appointment changed; the closeout was not completed.",
          });
        }
        return { closeout: completed, appointment: checkedOut };
      })
    ),
});
