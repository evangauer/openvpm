import { z } from "zod";
import { eq, and, isNull, desc, inArray, like, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  soapNotes,
  vaccinationRecords,
  labResults,
  procedures,
  problemList,
  prescriptions,
  drugInteractions,
  patients,
  patientAllergies,
  products,
  users,
  appointments,
  practices,
  captureSessions,
  consentForms,
  consentRequests,
  files,
  visitWorkItems,
  clinicalRecordCorrections,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import {
  hasSoapContent,
  normalizeSoapSection,
  SOAP_SECTION_MAX_LENGTH,
} from "@/lib/records/soap-content";
import { hasUnresolvedSoapTemplatePrompts } from "@/lib/records/soap-templates";
import {
  clinicalDateInput,
  clinicalTextInput,
  compareClinicalDateInputs,
  isOrderedLabReferenceRange,
  labReferenceInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { evaluatePrescriptionSafety } from "@/lib/records/prescription-safety";
import {
  PRESCRIPTION_COUNT_MAX,
  PRESCRIPTION_DOSAGE_MAX_LENGTH,
  PRESCRIPTION_FREQUENCY_MAX_LENGTH,
  PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH,
  PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH,
  PRESCRIPTION_QUANTITY_MIN,
  PRESCRIPTION_REFILLS_MIN,
} from "@/lib/records/prescription-policy";
import {
  LAB_RESULT_VALUE_MAX_LENGTH,
  LAB_TEST_NAME_MAX_LENGTH,
  LAB_UNIT_MAX_LENGTH,
} from "@/lib/records/lab-policy";
import {
  VACCINATION_LOT_NUMBER_MAX_LENGTH,
  VACCINATION_MANUFACTURER_MAX_LENGTH,
  VACCINATION_NAME_MAX_LENGTH,
} from "@/lib/records/vaccination-policy";
import {
  PROBLEM_DESCRIPTION_MAX_LENGTH,
  PROBLEM_STATUSES,
} from "@/lib/records/problem-policy";
import {
  PROCEDURE_ANESTHESIA_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_DURATION_MAX_MINUTES,
  PROCEDURE_NAME_MAX_LENGTH,
  PROCEDURE_NOTES_MAX_LENGTH,
} from "@/lib/records/procedure-policy";
import {
  CAPTURE_TOKEN_TTL_MS,
  CONSENT_TOKEN_TTL_MS,
  generateCaptureToken,
} from "@/lib/consult/tokens";
import {
  CONSENT_BODY_MAX_LENGTH,
  CONSENT_TITLE_MAX_LENGTH,
} from "@/lib/consult/consent-template";
import { CONSENT_FORM_LIBRARY } from "@/lib/consult/consent-form-library";
import { PATIENT_PHOTO_CATEGORY } from "@/lib/records/file-kinds";
import { appBaseUrl } from "@/lib/app-url";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { lockOpenVisitForClinicalAppend } from "@/lib/records/visit-integrity";
import { positiveIntegerColumnInput } from "./storage-bounds";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  CLINICAL_CORRECTION_REASON_MIN_LENGTH,
} from "@/lib/records/clinical-correction-policy";

export { PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH } from "@/lib/records/prescription-policy";
export {
  PROCEDURE_ANESTHESIA_MAX_LENGTH,
  PROCEDURE_DESCRIPTION_MAX_LENGTH,
  PROCEDURE_DURATION_MAX_MINUTES,
  PROCEDURE_NOTES_MAX_LENGTH,
} from "@/lib/records/procedure-policy";

type RecordsDb = Pick<Database, "select" | "insert" | "update" | "execute">;

type RecordsContext = {
  db: RecordsDb;
  practiceId: string;
};

type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

const labStatusValues = ["pending", "completed", "reviewed"] as const;
type LabStatus = (typeof labStatusValues)[number];

const labStatusTransitions: Record<LabStatus, readonly LabStatus[]> = {
  pending: ["pending", "completed"],
  completed: ["completed", "reviewed"],
  reviewed: ["reviewed"],
};

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function practiceSettings(ctx: RecordsContext): Promise<{
  name: string;
  phone: string | null;
  timezone: string | null;
}> {
  const [practice] = await ctx.db
    .select({
      name: practices.name,
      phone: practices.phone,
      timezone: practices.timezone,
    })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }

  return {
    name: practice.name?.trim() || "Veterinary Practice",
    phone: practice.phone ?? null,
    timezone: practice.timezone ?? null,
  };
}

async function practiceTimeZone(ctx: RecordsContext): Promise<string | null> {
  return (await practiceSettings(ctx)).timezone;
}

async function practiceDateInput(ctx: RecordsContext): Promise<string> {
  return formatDateInputForTimeZone(new Date(), await practiceTimeZone(ctx));
}

const createVaccinationInput = z.object({
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  vaccineName: clinicalTextInput("Vaccine name", VACCINATION_NAME_MAX_LENGTH),
  lotNumber: optionalClinicalTextInput(
    "Lot number",
    VACCINATION_LOT_NUMBER_MAX_LENGTH
  ),
  manufacturer: optionalClinicalTextInput(
    "Manufacturer",
    VACCINATION_MANUFACTURER_MAX_LENGTH
  ),
  nextDueDate: clinicalDateInput("Next due date").optional(),
});

const createProblemInput = z.object({
  patientId: z.string().uuid(),
  description: clinicalTextInput(
    "Problem description",
    PROBLEM_DESCRIPTION_MAX_LENGTH
  ),
  status: z.enum(PROBLEM_STATUSES).default("active"),
  onsetDate: clinicalDateInput("Onset date").optional(),
});

const createPrescriptionInput = z
  .object({
    patientId: z.string().uuid(),
    appointmentId: z.string().uuid().optional(),
    operationId: z.string().uuid(),
    medicationName: clinicalTextInput(
      "Medication name",
      PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH
    ),
    dosage: clinicalTextInput("Dosage", PRESCRIPTION_DOSAGE_MAX_LENGTH),
    frequency: clinicalTextInput(
      "Frequency",
      PRESCRIPTION_FREQUENCY_MAX_LENGTH
    ),
    quantity: z
      .number()
      .int()
      .min(PRESCRIPTION_QUANTITY_MIN)
      .max(PRESCRIPTION_COUNT_MAX)
      .optional(),
    productId: z.string().uuid().optional(),
    refillsRemaining: z
      .number()
      .int()
      .min(PRESCRIPTION_REFILLS_MIN)
      .max(PRESCRIPTION_COUNT_MAX)
      .default(0),
    startDate: clinicalDateInput("Start date"),
    endDate: clinicalDateInput("End date").optional(),
    instructions: optionalClinicalTextInput(
      "Prescription instructions",
      PRESCRIPTION_INSTRUCTIONS_MAX_LENGTH
    ),
    acknowledgeSafetyWarnings: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (
      input.endDate &&
      compareClinicalDateInputs(input.endDate, input.startDate) < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after start date.",
      });
    }
  });

const createLabResultInput = z
  .object({
    patientId: z.string().uuid(),
    appointmentId: z.string().uuid().optional(),
    testName: clinicalTextInput("Test name", LAB_TEST_NAME_MAX_LENGTH),
    resultValue: optionalClinicalTextInput(
      "Result value",
      LAB_RESULT_VALUE_MAX_LENGTH
    ),
    unit: optionalClinicalTextInput("Unit", LAB_UNIT_MAX_LENGTH),
    referenceRangeLow: labReferenceInput("Reference range low").optional(),
    referenceRangeHigh: labReferenceInput("Reference range high").optional(),
    status: z.enum(labStatusValues).default("pending"),
  })
  .superRefine((input, ctx) => {
    if (
      !isOrderedLabReferenceRange(
        input.referenceRangeLow,
        input.referenceRangeHigh
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["referenceRangeHigh"],
        message: "Reference range high must be greater than or equal to low.",
      });
    }
  });

async function assertPatientBelongsToPractice(
  ctx: RecordsContext,
  patientId: string
) {
  const [patient] = await ctx.db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }

  return patient;
}

async function assertAppointmentBelongsToPatient(
  ctx: RecordsContext,
  appointmentId: string,
  patientId: string
) {
  const [appointment] = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.patientId, patientId),
        eq(appointments.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(appointments.deletedAt)
      )
    )
    .limit(1);

  if (!appointment) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Appointment not found",
    });
  }

  return appointment;
}

async function lockOpenAppointmentForClinicalWork(
  ctx: RecordsContext,
  appointmentId: string,
  patientId: string,
  workLabel: string
) {
  const visit = await lockOpenVisitForClinicalAppend(ctx.db as Database, {
    practiceId: ctx.practiceId,
    appointmentId,
    patientId,
  });
  if (!visit.ok && visit.reason === "appointment_not_found") {
    throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
  }
  if (!visit.ok && visit.reason === "visit_not_open") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Start the exam before recording visit-linked ${workLabel}.`,
    });
  }
  if (!visit.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Clinical handoff is finalized. Use an attributed amendment before changing visit ${workLabel}.`,
    });
  }
}

type VisitWorkSource =
  | { vaccinationRecordId: string }
  | { labResultId: string }
  | { procedureId: string }
  | { prescriptionId: string };

/** Atomic, idempotent registration. Labels and clinical details deliberately
 * remain on the source record so the reconciliation ledger is PII-safe. */
async function registerVisitWorkItem(
  ctx: RecordsContext,
  appointmentId: string,
  source: VisitWorkSource
) {
  if ("vaccinationRecordId" in source) {
    await ctx.db.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, vaccination_record_id)
      values (${ctx.practiceId}, ${appointmentId}, ${source.vaccinationRecordId})
      on conflict do nothing
    `);
  } else if ("labResultId" in source) {
    await ctx.db.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, lab_result_id)
      values (${ctx.practiceId}, ${appointmentId}, ${source.labResultId})
      on conflict do nothing
    `);
  } else if ("procedureId" in source) {
    await ctx.db.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, procedure_id)
      values (${ctx.practiceId}, ${appointmentId}, ${source.procedureId})
      on conflict do nothing
    `);
  } else {
    await ctx.db.execute(sql`
      insert into ${visitWorkItems}
        (practice_id, appointment_id, prescription_id)
      values (${ctx.practiceId}, ${appointmentId}, ${source.prescriptionId})
      on conflict do nothing
    `);
  }
}

/**
 * The patient's open visit right now: the most recent checked-in/in-exam
 * appointment. Capture sessions and consent requests minted while a visit is
 * open stamp it, so their artifacts attach to that visit; with no open visit
 * they stay patient-only.
 */
async function findActiveVisitId(
  ctx: RecordsContext,
  patientId: string
): Promise<string | null> {
  const [visit] = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.practiceId, ctx.practiceId),
        eq(appointments.patientId, patientId),
        inArray(appointments.status, ["checked_in", "in_exam"]),
        isNull(appointments.deletedAt)
      )
    )
    .orderBy(desc(appointments.startTime))
    .limit(1);
  return visit?.id ?? null;
}

async function assessPrescriptionSafety(
  ctx: RecordsContext,
  patientId: string,
  medicationName: string
) {
  const [allergies, activePrescriptions, interactions] = await Promise.all([
    ctx.db
      .select({
        allergen: patientAllergies.allergen,
        severity: patientAllergies.severity,
        reaction: patientAllergies.reaction,
      })
      .from(patientAllergies)
      .where(
        and(
          eq(patientAllergies.patientId, patientId),
          activePracticePredicate(ctx.practiceId),
          sql`exists (
            select 1
            from ${patients}
            where ${patients.id} = ${patientAllergies.patientId}
              and ${patients.practiceId} = ${ctx.practiceId}
              and ${patients.deletedAt} is null
          )`,
          isNull(patientAllergies.deletedAt)
        )
      ),
    ctx.db
      .select({
        medicationName: prescriptions.medicationName,
      })
      .from(prescriptions)
      .where(
        and(
          eq(prescriptions.practiceId, ctx.practiceId),
          eq(prescriptions.patientId, patientId),
          eq(prescriptions.status, "active"),
          activePracticePredicate(ctx.practiceId),
          isNull(prescriptions.deletedAt)
        )
      ),
    ctx.db
      .select({
        drugA: drugInteractions.drugA,
        drugB: drugInteractions.drugB,
        severity: drugInteractions.severity,
        description: drugInteractions.description,
      })
      .from(drugInteractions)
      .where(isNull(drugInteractions.deletedAt)),
  ]);

  return evaluatePrescriptionSafety({
    medicationName,
    allergies,
    activePrescriptions,
    interactions,
  });
}

async function assertDispensedProductBelongsToPractice(
  ctx: RecordsContext,
  productId: string
) {
  const [product] = await ctx.db
    .select({
      id: products.id,
      name: products.name,
      stockQuantity: products.stockQuantity,
    })
    .from(products)
    .where(
      and(
        eq(products.id, productId),
        eq(products.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(products.deletedAt)
      )
    )
    .limit(1);

  if (!product) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Product not found" });
  }

  return product;
}

async function deductDispensedProductStock(
  ctx: RecordsContext,
  productId: string,
  quantity: number
) {
  const [product] = await ctx.db
    .update(products)
    .set({
      stockQuantity: sql`${products.stockQuantity} - ${quantity}`,
    })
    .where(
      and(
        eq(products.id, productId),
        eq(products.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(products.deletedAt),
        sql`${products.stockQuantity} >= ${quantity}`
      )
    )
    .returning({ id: products.id, stockQuantity: products.stockQuantity });

  if (!product) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Insufficient stock for the dispensed prescription quantity.",
    });
  }
}

async function getProblemStatusForUpdate(
  ctx: RecordsContext,
  id: string
): Promise<{ status: ProblemStatus; resolvedDate: string | null }> {
  const [problem] = await ctx.db
    .select({
      status: problemList.status,
      resolvedDate: problemList.resolvedDate,
    })
    .from(problemList)
    .where(
      and(
        eq(problemList.id, id),
        eq(problemList.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(problemList.deletedAt)
      )
    )
    .limit(1);

  if (!problem) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Problem not found" });
  }

  return problem;
}

async function getLabStatusForUpdate(
  ctx: RecordsContext,
  id: string
): Promise<{ status: LabStatus }> {
  const [result] = await ctx.db
    .select({ status: labResults.status })
    .from(labResults)
    .where(
      and(
        eq(labResults.id, id),
        eq(labResults.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(labResults.deletedAt)
      )
    )
    .limit(1);

  if (!result) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Lab result not found",
    });
  }

  return result;
}

function assertLabStatusTransition(current: LabStatus, next: LabStatus) {
  if (labStatusTransitions[current].includes(next)) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Cannot change lab result status from ${current} to ${next}.`,
  });
}

export const recordsRouter = createRouter({
  settings: protectedProcedure.query(async ({ ctx }) => practiceSettings(ctx)),

  // SOAP Notes
  listSoapNotes: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: soapNotes.id,
          patientId: soapNotes.patientId,
          appointmentId: soapNotes.appointmentId,
          subjective: soapNotes.subjective,
          objective: soapNotes.objective,
          assessment: soapNotes.assessment,
          plan: soapNotes.plan,
          authorName: users.name,
          imported: soapNotes.imported,
          createdAt: soapNotes.createdAt,
          correctionId: clinicalRecordCorrections.id,
          correctionAction: clinicalRecordCorrections.action,
          correctionReason: clinicalRecordCorrections.reason,
          correctedAt: clinicalRecordCorrections.createdAt,
          correctedBy: clinicalRecordCorrections.correctedBy,
          correctedByName: clinicalRecordCorrections.correctedByName,
        })
        .from(soapNotes)
        .leftJoin(
          users,
          and(
            eq(soapNotes.authorId, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .leftJoin(
          clinicalRecordCorrections,
          and(
            eq(clinicalRecordCorrections.soapNoteId, soapNotes.id),
            eq(clinicalRecordCorrections.practiceId, ctx.practiceId)
          )
        )
        .where(
          and(
            eq(soapNotes.patientId, input.patientId),
            eq(soapNotes.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(soapNotes.deletedAt)
          )
        )
        .orderBy(desc(soapNotes.createdAt));
    }),

  markSoapNoteEnteredInError: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        recordId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(CLINICAL_CORRECTION_REASON_MIN_LENGTH)
          .max(CLINICAL_CORRECTION_REASON_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [source] = await tx
          .select({
            id: soapNotes.id,
            patientId: soapNotes.patientId,
            appointmentId: soapNotes.appointmentId,
          })
          .from(soapNotes)
          .where(
            and(
              eq(soapNotes.id, input.recordId),
              eq(soapNotes.patientId, input.patientId),
              eq(soapNotes.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(soapNotes.deletedAt)
            )
          )
          .limit(1);

        if (!source) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Clinical record not found",
          });
        }

        const [created] = await tx
          .insert(clinicalRecordCorrections)
          .values({
            practiceId: ctx.practiceId,
            recordType: "soap_note",
            action: "entered_in_error",
            soapNoteId: source.id,
            patientId: source.patientId,
            appointmentId: source.appointmentId,
            reason: input.reason,
            correctedBy: ctx.user.id,
            correctedByName: ctx.user.name,
          })
          .onConflictDoNothing()
          .returning();
        if (created) return created;

        const [existing] = await tx
          .select()
          .from(clinicalRecordCorrections)
          .where(
            and(
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
              eq(clinicalRecordCorrections.soapNoteId, source.id)
            )
          )
          .limit(1);
        if (existing) return existing;

        throw new TRPCError({
          code: "CONFLICT",
          message: "Clinical correction changed; refresh and retry.",
        });
      })
    ),

  createSoapNote: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        subjective: optionalClinicalTextInput(
          "SOAP subjective",
          SOAP_SECTION_MAX_LENGTH
        ),
        objective: optionalClinicalTextInput(
          "SOAP objective",
          SOAP_SECTION_MAX_LENGTH
        ),
        assessment: optionalClinicalTextInput(
          "SOAP assessment",
          SOAP_SECTION_MAX_LENGTH
        ),
        plan: optionalClinicalTextInput("SOAP plan", SOAP_SECTION_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const normalizedNote = {
        subjective: normalizeSoapSection(input.subjective),
        objective: normalizeSoapSection(input.objective),
        assessment: normalizeSoapSection(input.assessment),
        plan: normalizeSoapSection(input.plan),
      };
      if (!hasSoapContent(normalizedNote)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "SOAP note must include at least one section.",
        });
      }
      if (hasUnresolvedSoapTemplatePrompts(normalizedNote)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Replace or delete every SOAP template prompt before saving.",
        });
      }
      await assertPatientBelongsToPractice(ctx, input.patientId);
      await lockOpenAppointmentForClinicalWork(
        ctx,
        input.appointmentId,
        input.patientId,
        "SOAP documentation"
      );
      const [note] = await ctx.db
        .insert(soapNotes)
        .values({
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          ...normalizedNote,
          authorId: ctx.user.id,
          practiceId: ctx.practiceId,
        })
        .returning();
      await dispatchWebhookEvent(ctx.practiceId, "soap_note.created", {
        id: note!.id,
        patientId: note!.patientId,
        appointmentId: note!.appointmentId,
        authorId: note!.authorId,
        source: "dashboard",
      });
      return note!;
    }),

  // Vaccinations
  listVaccinations: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: vaccinationRecords.id,
          vaccineName: vaccinationRecords.vaccineName,
          lotNumber: vaccinationRecords.lotNumber,
          manufacturer: vaccinationRecords.manufacturer,
          administeredAt: vaccinationRecords.administeredAt,
          nextDueDate: vaccinationRecords.nextDueDate,
          administeredByName: users.name,
        })
        .from(vaccinationRecords)
        .leftJoin(
          users,
          and(
            eq(vaccinationRecords.administeredBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .where(
          and(
            eq(vaccinationRecords.patientId, input.patientId),
            eq(vaccinationRecords.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(vaccinationRecords.deletedAt)
          )
        )
        .orderBy(desc(vaccinationRecords.administeredAt));
    }),

  createVaccination: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(createVaccinationInput)
    .mutation(async ({ ctx, input }) => {
      const record = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await assertPatientBelongsToPractice(txCtx, input.patientId);
        if (input.appointmentId) {
          await lockOpenAppointmentForClinicalWork(
            txCtx,
            input.appointmentId,
            input.patientId,
            "vaccination"
          );
        }
        const [created] = await tx
          .insert(vaccinationRecords)
          .values({
            ...input,
            administeredBy: ctx.user.id,
            practiceId: ctx.practiceId,
          })
          .returning();
        if (created?.appointmentId) {
          await registerVisitWorkItem(txCtx, created.appointmentId, {
            vaccinationRecordId: created.id,
          });
        }
        return created!;
      });
      await dispatchWebhookEvent(ctx.practiceId, "vaccination.recorded", {
        id: record.id,
        patientId: record.patientId,
        vaccineName: record.vaccineName,
        administeredBy: record.administeredBy,
        source: "dashboard",
      });
      return record;
    }),

  // Problem List
  listProblems: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(problemList)
        .where(
          and(
            eq(problemList.patientId, input.patientId),
            eq(problemList.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(problemList.deletedAt)
          )
        )
        .orderBy(desc(problemList.createdAt));
    }),

  createProblem: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(createProblemInput)
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      const [problem] = await ctx.db
        .insert(problemList)
        .values({
          ...input,
          practiceId: ctx.practiceId,
        })
        .returning();
      await dispatchWebhookEvent(ctx.practiceId, "problem.created", {
        id: problem!.id,
        patientId: problem!.patientId,
        status: problem!.status,
        source: "dashboard",
      });
      return problem!;
    }),

  updateProblemStatus: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(PROBLEM_STATUSES),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getProblemStatusForUpdate(ctx, input.id);
      const resolvedDate =
        input.status === "resolved"
          ? existing.status === "resolved"
            ? existing.resolvedDate
            : await practiceDateInput(ctx)
          : null;
      const [problem] = await ctx.db
        .update(problemList)
        .set({
          status: input.status,
          resolvedDate,
        })
        .where(
          and(
            eq(problemList.id, input.id),
            eq(problemList.practiceId, ctx.practiceId),
            eq(problemList.status, existing.status),
            activePracticePredicate(ctx.practiceId),
            sql`${problemList.resolvedDate} is not distinct from ${existing.resolvedDate}`,
            isNull(problemList.deletedAt)
          )
        )
        .returning();
      if (!problem) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Problem changed while updating. Refresh and try again.",
        });
      }
      return problem;
    }),

  // Prescriptions
  listPrescriptions: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: prescriptions.id,
          appointmentId: prescriptions.appointmentId,
          medicationName: prescriptions.medicationName,
          dosage: prescriptions.dosage,
          frequency: prescriptions.frequency,
          quantity: prescriptions.quantity,
          refillsRemaining: prescriptions.refillsRemaining,
          productId: prescriptions.productId,
          productName: products.name,
          productStockQuantity: products.stockQuantity,
          startDate: prescriptions.startDate,
          endDate: prescriptions.endDate,
          status: prescriptions.status,
          instructions: prescriptions.instructions,
          prescriberName: users.name,
          createdAt: prescriptions.createdAt,
        })
        .from(prescriptions)
        .leftJoin(
          users,
          and(
            eq(prescriptions.prescribedBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
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
            eq(prescriptions.patientId, input.patientId),
            eq(prescriptions.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(prescriptions.deletedAt)
          )
        )
        .orderBy(desc(prescriptions.createdAt));
    }),

  checkPrescriptionSafety: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        medicationName: clinicalTextInput(
          "Medication name",
          PRESCRIPTION_MEDICATION_NAME_MAX_LENGTH
        ),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      return assessPrescriptionSafety(
        ctx,
        input.patientId,
        input.medicationName
      );
    }),

  createPrescription: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(createPrescriptionInput)
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        const operationKey = `dashboard-prescription:${ctx.practiceId}:${input.operationId}`;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`
        );

        const [existing] = await tx
          .select({
            id: prescriptions.id,
            practiceId: prescriptions.practiceId,
            patientId: prescriptions.patientId,
            appointmentId: prescriptions.appointmentId,
            medicationName: prescriptions.medicationName,
            dosage: prescriptions.dosage,
            frequency: prescriptions.frequency,
            quantity: prescriptions.quantity,
            productId: prescriptions.productId,
            refillsRemaining: prescriptions.refillsRemaining,
            startDate: prescriptions.startDate,
            endDate: prescriptions.endDate,
            status: prescriptions.status,
            instructions: prescriptions.instructions,
            prescribedBy: prescriptions.prescribedBy,
            operationId: prescriptions.operationId,
            createdAt: prescriptions.createdAt,
          })
          .from(prescriptions)
          .where(
            and(
              eq(prescriptions.practiceId, ctx.practiceId),
              eq(prescriptions.operationId, input.operationId)
            )
          )
          .limit(1);
        if (existing) {
          if (
            existing.patientId !== input.patientId ||
            (existing.appointmentId ?? null) !== (input.appointmentId ?? null) ||
            existing.medicationName !== input.medicationName ||
            existing.dosage !== input.dosage ||
            existing.frequency !== input.frequency ||
            (existing.quantity ?? null) !== (input.quantity ?? null) ||
            (existing.productId ?? null) !== (input.productId ?? null) ||
            existing.refillsRemaining !== input.refillsRemaining ||
            existing.startDate !== input.startDate ||
            (existing.endDate ?? null) !== (input.endDate ?? null) ||
            (existing.instructions ?? null) !== (input.instructions ?? null)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This prescription operation ID was already used for different details.",
            });
          }
          if (existing.appointmentId) {
            await registerVisitWorkItem(txCtx, existing.appointmentId, {
              prescriptionId: existing.id,
            });
          }
          return { rx: existing, replayed: true as const };
        }

        await assertPatientBelongsToPractice(txCtx, input.patientId);
        if (input.appointmentId) {
          await assertAppointmentBelongsToPatient(
            txCtx,
            input.appointmentId,
            input.patientId
          );
        }
        const safety = await assessPrescriptionSafety(
          txCtx,
          input.patientId,
          input.medicationName
        );
        if (input.productId) {
          const product = await assertDispensedProductBelongsToPractice(
            txCtx,
            input.productId
          );
          if (!input.quantity || input.quantity <= 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Enter a dispensed quantity before linking inventory stock.",
            });
          }
          if (product.stockQuantity < input.quantity) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Insufficient stock for the dispensed prescription quantity.",
            });
          }
        }

        if (safety.requiresOverride && !input.acknowledgeSafetyWarnings) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Prescription has allergy or interaction warnings that require clinician acknowledgement.",
          });
        }

        if (input.appointmentId) {
          await lockOpenAppointmentForClinicalWork(
            txCtx,
            input.appointmentId,
            input.patientId,
            "prescriptions"
          );
        }

        if (input.productId && input.quantity && input.quantity > 0) {
          await deductDispensedProductStock(
            txCtx,
            input.productId,
            input.quantity
          );
        }

        const [rx] = await tx
          .insert(prescriptions)
          .values({
            patientId: input.patientId,
            appointmentId: input.appointmentId,
            medicationName: input.medicationName,
            dosage: input.dosage,
            frequency: input.frequency,
            quantity: input.quantity,
            productId: input.productId,
            refillsRemaining: input.refillsRemaining,
            startDate: input.startDate,
            endDate: input.endDate,
            instructions: input.instructions,
            prescribedBy: ctx.user.id,
            practiceId: ctx.practiceId,
            operationId: input.operationId,
          })
          .returning();
        if (rx?.appointmentId) {
          await registerVisitWorkItem(txCtx, rx.appointmentId, {
            prescriptionId: rx.id,
          });
        }
        return { rx: rx!, replayed: false as const };
      });
      if (!result.replayed) {
        await dispatchWebhookEvent(ctx.practiceId, "prescription.created", {
          id: result.rx.id,
          patientId: result.rx.patientId,
          appointmentId: result.rx.appointmentId,
          medicationName: result.rx.medicationName,
          prescribedBy: result.rx.prescribedBy,
          productId: result.rx.productId,
          source: "dashboard",
        });
      }
      return result.rx;
    }),

  // Lab Results
  listLabResults: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: labResults.id,
          testName: labResults.testName,
          resultValue: labResults.resultValue,
          unit: labResults.unit,
          referenceRangeLow: labResults.referenceRangeLow,
          referenceRangeHigh: labResults.referenceRangeHigh,
          status: labResults.status,
          orderedByName: users.name,
          createdAt: labResults.createdAt,
        })
        .from(labResults)
        .leftJoin(
          users,
          and(
            eq(labResults.orderedBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .where(
          and(
            eq(labResults.patientId, input.patientId),
            eq(labResults.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(labResults.deletedAt)
          )
        )
        .orderBy(desc(labResults.createdAt));
      return rows;
    }),

  createLabResult: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(createLabResultInput)
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await assertPatientBelongsToPractice(txCtx, input.patientId);
        if (input.appointmentId) {
          await lockOpenAppointmentForClinicalWork(
            txCtx,
            input.appointmentId,
            input.patientId,
            "lab work"
          );
        }
        const [created] = await tx
          .insert(labResults)
          .values({
            ...input,
            orderedBy: ctx.user.id,
            practiceId: ctx.practiceId,
          })
          .returning();
        if (created?.appointmentId) {
          await registerVisitWorkItem(txCtx, created.appointmentId, {
            labResultId: created.id,
          });
        }
        return created!;
      });
      await dispatchWebhookEvent(ctx.practiceId, "lab_result.created", {
        id: result.id,
        patientId: result.patientId,
        testName: result.testName,
        status: result.status,
        orderedBy: result.orderedBy,
        source: "dashboard",
      });
      return result;
    }),

  updateLabResultStatus: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(labStatusValues),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await getLabStatusForUpdate(ctx, input.id);
      assertLabStatusTransition(existing.status, input.status);
      const [result] = await ctx.db
        .update(labResults)
        .set({
          status: input.status,
          ...(input.status === "reviewed"
            ? { reviewedBy: ctx.user.id }
            : {}),
        })
        .where(
          and(
            eq(labResults.id, input.id),
            eq(labResults.practiceId, ctx.practiceId),
            eq(labResults.status, existing.status),
            activePracticePredicate(ctx.practiceId),
            isNull(labResults.deletedAt)
          )
        )
        .returning();
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Lab result changed while updating. Refresh and try again.",
        });
      }
      return result;
    }),

  // Procedures
  listProcedures: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: procedures.id,
          name: procedures.name,
          description: procedures.description,
          performedByName: users.name,
          anesthesiaUsed: procedures.anesthesiaUsed,
          durationMinutes: procedures.durationMinutes,
          notes: procedures.notes,
          createdAt: procedures.createdAt,
        })
        .from(procedures)
        .leftJoin(
          users,
          and(
            eq(procedures.performedBy, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .where(
          and(
            eq(procedures.patientId, input.patientId),
            eq(procedures.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(procedures.deletedAt)
          )
        )
        .orderBy(desc(procedures.createdAt));
    }),

  createProcedure: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
        name: clinicalTextInput("Procedure name", PROCEDURE_NAME_MAX_LENGTH),
        description: optionalClinicalTextInput(
          "Procedure description",
          PROCEDURE_DESCRIPTION_MAX_LENGTH
        ),
        anesthesiaUsed: optionalClinicalTextInput(
          "Anesthesia used",
          PROCEDURE_ANESTHESIA_MAX_LENGTH
        ),
        durationMinutes: positiveIntegerColumnInput
          .max(PROCEDURE_DURATION_MAX_MINUTES)
          .optional(),
        notes: optionalClinicalTextInput(
          "Procedure notes",
          PROCEDURE_NOTES_MAX_LENGTH
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const procedure = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await assertPatientBelongsToPractice(txCtx, input.patientId);
        if (input.appointmentId) {
          await lockOpenAppointmentForClinicalWork(
            txCtx,
            input.appointmentId,
            input.patientId,
            "procedures"
          );
        }
        const [created] = await tx
          .insert(procedures)
          .values({
            ...input,
            performedBy: ctx.user.id,
            practiceId: ctx.practiceId,
          })
          .returning();
        if (created?.appointmentId) {
          await registerVisitWorkItem(txCtx, created.appointmentId, {
            procedureId: created.id,
          });
        }
        return created!;
      });
      await dispatchWebhookEvent(ctx.practiceId, "procedure.created", {
        id: procedure.id,
        patientId: procedure.patientId,
        appointmentId: procedure.appointmentId,
        name: procedure.name,
        performedBy: procedure.performedBy,
        source: "dashboard",
      });
      return procedure;
    }),

  // In-consult QR photo capture. Staff mint a short-lived capture link for a
  // patient; the QR opens a no-login mobile page (app/capture/[token]) whose
  // uploads land in the files table linked to this patient. Role gate mirrors
  // patient management (patients.addAllergy): all staff except viewers.
  createCaptureSession: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      const appointmentId = input.appointmentId
        ? (
            await assertAppointmentBelongsToPatient(
              ctx,
              input.appointmentId,
              input.patientId
            )
          ).id
        : await findActiveVisitId(ctx, input.patientId);
      const token = generateCaptureToken();
      const expiresAt = new Date(Date.now() + CAPTURE_TOKEN_TTL_MS);
      await ctx.db
        .insert(captureSessions)
        .values({
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          createdBy: ctx.user.id,
          appointmentId,
          token,
          expiresAt,
        })
        .returning();
      return {
        token,
        url: `${appBaseUrl()}/capture/${token}`,
        expiresAt,
        appointmentId,
      };
    }),

  /**
   * Photos attached to a patient via capture links, newest first. Photos
   * only: without the category + mime filters, signed consent PDFs (also
   * patient files) leak into the capture grid as broken images.
   */
  listCaptureFiles: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      return ctx.db
        .select({
          id: files.id,
          fileName: files.fileName,
          fileUrl: files.fileUrl,
          mimeType: files.mimeType,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(
          and(
            eq(files.practiceId, ctx.practiceId),
            eq(files.entityType, "patient"),
            eq(files.entityId, input.patientId),
            eq(files.category, PATIENT_PHOTO_CATEGORY),
            like(files.mimeType, "image/%"),
            activePracticePredicate(ctx.practiceId),
            isNull(files.deletedAt)
          )
        )
        .orderBy(desc(files.createdAt))
        .limit(50);
    }),

  /**
   * Everything attached to a patient (photos, signed consents, documents),
   * newest first, for the patient Documents tab. Optionally narrowed to one
   * visit for the per-appointment documents view. Signed consents join back
   * to their request so the UI can say what was signed and by whom.
   */
  listPatientFiles: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      if (input.appointmentId) {
        await assertAppointmentBelongsToPatient(
          ctx,
          input.appointmentId,
          input.patientId
        );
      }
      return ctx.db
        .select({
          id: files.id,
          fileName: files.fileName,
          fileUrl: files.fileUrl,
          mimeType: files.mimeType,
          fileSizeBytes: files.fileSizeBytes,
          category: files.category,
          appointmentId: files.appointmentId,
          createdAt: files.createdAt,
          consentTitle: consentRequests.title,
          consentSignerName: consentRequests.signerName,
          consentSignedAt: consentRequests.signedAt,
        })
        .from(files)
        .leftJoin(
          consentRequests,
          and(
            eq(consentRequests.fileId, files.id),
            isNull(consentRequests.deletedAt)
          )
        )
        .where(
          and(
            eq(files.practiceId, ctx.practiceId),
            eq(files.entityType, "patient"),
            eq(files.entityId, input.patientId),
            input.appointmentId
              ? eq(files.appointmentId, input.appointmentId)
              : undefined,
            activePracticePredicate(ctx.practiceId),
            isNull(files.deletedAt)
          )
        )
        .orderBy(desc(files.createdAt))
        .limit(200);
    }),

  /**
   * The practice's consent form library, seeded from the starter set on
   * first read. The insert is idempotent (unique practice+slug, conflicts
   * ignored), so concurrent first reads cannot duplicate forms and
   * practices that predate the library pick it up with no data migration.
   */
  listConsentForms: protectedProcedure.query(async ({ ctx }) => {
    const formColumns = {
      id: consentForms.id,
      slug: consentForms.slug,
      title: consentForms.title,
      body: consentForms.body,
      sortOrder: consentForms.sortOrder,
    };
    const listForms = () =>
      ctx.db
        .select(formColumns)
        .from(consentForms)
        .where(
          and(
            eq(consentForms.practiceId, ctx.practiceId),
            eq(consentForms.isActive, true),
            activePracticePredicate(ctx.practiceId),
            isNull(consentForms.deletedAt)
          )
        )
        .orderBy(consentForms.sortOrder)
        .limit(100);

    const existing = await listForms();
    if (existing.length > 0) return existing;

    await ctx.db
      .insert(consentForms)
      .values(
        CONSENT_FORM_LIBRARY.map((form) => ({
          practiceId: ctx.practiceId,
          slug: form.slug,
          title: form.title,
          body: form.body,
          sortOrder: form.sortOrder,
        }))
      )
      .onConflictDoNothing();
    return listForms();
  }),

  // E-sign consent dispatch. Same capability-link model as capture sessions:
  // staff mint a short-lived signing link for a patient, the QR opens the
  // no-login /sign/[token] page, and the signed PDF lands in files. Every
  // dispatch is bound to a form from the practice library ("what are they
  // signing?"); the sent copy is snapshotted here so form edits never
  // change what someone already signed. Role gate mirrors
  // createCaptureSession.
  createConsentRequest: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
        formId: z.string().uuid(),
        title: z.string().trim().min(1).max(CONSENT_TITLE_MAX_LENGTH).optional(),
        bodyText: z.string().trim().min(1).max(CONSENT_BODY_MAX_LENGTH).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      const [form] = await ctx.db
        .select({
          id: consentForms.id,
          title: consentForms.title,
          body: consentForms.body,
        })
        .from(consentForms)
        .where(
          and(
            eq(consentForms.id, input.formId),
            eq(consentForms.practiceId, ctx.practiceId),
            eq(consentForms.isActive, true),
            isNull(consentForms.deletedAt)
          )
        )
        .limit(1);
      if (!form) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Consent form not found",
        });
      }
      const appointmentId = input.appointmentId
        ? (
            await assertAppointmentBelongsToPatient(
              ctx,
              input.appointmentId,
              input.patientId
            )
          ).id
        : await findActiveVisitId(ctx, input.patientId);
      const token = generateCaptureToken();
      const expiresAt = new Date(Date.now() + CONSENT_TOKEN_TTL_MS);
      const [created] = await ctx.db
        .insert(consentRequests)
        .values({
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          createdBy: ctx.user.id,
          appointmentId,
          formId: form.id,
          token,
          expiresAt,
          title: input.title ?? form.title,
          bodyText: input.bodyText ?? form.body,
        })
        .returning({ id: consentRequests.id });
      return {
        id: created!.id,
        token,
        url: `${appBaseUrl()}/sign/${token}`,
        expiresAt,
        appointmentId,
      };
    }),

  /** Consent requests for a patient, newest first (tokens never leave here). */
  listConsents: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx, input.patientId);
      return ctx.db
        .select({
          id: consentRequests.id,
          title: consentRequests.title,
          status: consentRequests.status,
          signerName: consentRequests.signerName,
          signedAt: consentRequests.signedAt,
          expiresAt: consentRequests.expiresAt,
          createdAt: consentRequests.createdAt,
          fileId: consentRequests.fileId,
          fileUrl: files.fileUrl,
        })
        .from(consentRequests)
        .leftJoin(
          files,
          and(eq(files.id, consentRequests.fileId), isNull(files.deletedAt))
        )
        .where(
          and(
            eq(consentRequests.practiceId, ctx.practiceId),
            eq(consentRequests.patientId, input.patientId),
            activePracticePredicate(ctx.practiceId),
            isNull(consentRequests.deletedAt)
          )
        )
        .orderBy(desc(consentRequests.createdAt))
        .limit(50);
    }),
});
