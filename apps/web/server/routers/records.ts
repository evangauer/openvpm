import { z } from "zod";
import { createHash } from "node:crypto";
import {
  eq,
  and,
  isNull,
  desc,
  inArray,
  like,
  sql,
  or,
  gte,
  ne,
  asc,
  getTableColumns,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  soapNotes,
  vaccinationRecords,
  labResults,
  labResultEvents,
  labResultReplacements,
  procedures,
  problemList,
  prescriptions,
  prescriptionEvents,
  dispenseChargeQueue,
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
  soapNoteAddenda,
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
import {
  addFinalizedSoapAddendum,
  createFinalizedAppointmentSoapNote,
  discardAppointmentSoapDraft,
  finalizeAppointmentSoapDraft,
  getAppointmentSoapDraft,
  saveAppointmentSoapDraft,
  SoapLifecycleError,
} from "@/lib/records/soap-lifecycle";
import {
  effectivePrescriptionStatus,
  PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH,
  PRESCRIPTION_LIFECYCLE_REASON_MIN_LENGTH,
  type PrescriptionEventType,
  type PrescriptionStatus,
} from "@/lib/records/prescription-lifecycle";

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
const labResultFlagValues = ["unknown", "normal", "abnormal", "critical"] as const;
const labFollowUpStatusValues = ["not_required", "open", "completed"] as const;

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

function activeLabResultPredicate(practiceId: string) {
  return sql`not exists (
    select 1
    from ${clinicalRecordCorrections} as lab_correction
    where lab_correction.practice_id = ${practiceId}
      and lab_correction.lab_result_id = ${labResults.id}
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

function practiceTodayExpression(practiceId: string) {
  return sql<string>`(
    now() at time zone coalesce(
      (
        select nullif(btrim(${practices.timezone}), '')
        from ${practices}
        where ${practices.id} = ${practiceId}
          and ${practices.deletedAt} is null
      ),
      'UTC'
    )
  )::date`;
}

function effectivePrescriptionStatusExpression(practiceId: string) {
  return sql<PrescriptionStatus>`case
    when ${prescriptions.status} = 'active'
      and ${prescriptions.endDate} is not null
      and ${prescriptions.endDate} < ${practiceTodayExpression(practiceId)}
    then 'expired'::prescription_status
    else ${prescriptions.status}
  end`;
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
    status: z.enum(["pending", "completed"]).default("pending"),
    resultFlag: z.enum(labResultFlagValues).default("unknown"),
    operationId: z.string().uuid(),
    replacesLabResultId: z.string().uuid().optional(),
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
    if (input.status === "completed" && !input.resultValue?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultValue"],
        message: "A result value is required before a lab result can be completed.",
      });
    }
    if (input.replacesLabResultId && !input.resultValue?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultValue"],
        message:
          "A fresh result value is required when replacing an entered-in-error lab result.",
      });
    }
    if (
      input.status === "pending" &&
      (input.resultValue != null ||
        input.unit != null ||
        input.referenceRangeLow != null ||
        input.referenceRangeHigh != null ||
        input.resultFlag !== "unknown")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Pending lab results cannot carry partial values. Complete the result when values are available.",
      });
    }
  });

type LabEventType =
  | "created"
  | "completed"
  | "reviewed"
  | "follow_up_assigned"
  | "follow_up_reassigned"
  | "follow_up_completed";

function labOperationHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function lockLabOperation(ctx: RecordsContext, operationId: string) {
  await ctx.db.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${`${ctx.practiceId}:${operationId}`}, 0)
    )`,
  );
}

async function lockLabResultSource(ctx: RecordsContext, resultId: string) {
  await ctx.db.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${`lab-result-source:${ctx.practiceId}:${resultId}`}, 0)
    )`,
  );
}

async function assertLabReplacementReplay(
  ctx: RecordsContext,
  expected: {
    sourceLabResultId: string;
    replacementLabResultId: string;
    operationId: string;
    payloadHash: string;
  },
) {
  const [link] = await ctx.db
    .select({
      sourceLabResultId: labResultReplacements.sourceLabResultId,
      replacementLabResultId: labResultReplacements.replacementLabResultId,
      operationPayloadHash: labResultReplacements.operationPayloadHash,
      correctionRecordType: clinicalRecordCorrections.recordType,
      correctionLabResultId: clinicalRecordCorrections.labResultId,
    })
    .from(labResultReplacements)
    .innerJoin(
      clinicalRecordCorrections,
      and(
        eq(clinicalRecordCorrections.id, labResultReplacements.correctionId),
        eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
      ),
    )
    .where(
      and(
        eq(labResultReplacements.practiceId, ctx.practiceId),
        eq(labResultReplacements.operationId, expected.operationId),
      ),
    )
    .limit(1);
  if (
    !link ||
    link.sourceLabResultId !== expected.sourceLabResultId ||
    link.replacementLabResultId !== expected.replacementLabResultId ||
    link.operationPayloadHash !== expected.payloadHash ||
    link.correctionRecordType !== "lab_result" ||
    link.correctionLabResultId !== expected.sourceLabResultId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Replacement creation evidence is missing or conflicts with this operation. Refresh the chart.",
    });
  }
}

async function getLabOperationReplay(
  ctx: RecordsContext,
  operationId: string,
  expected: {
    resultId?: string;
    eventTypes: readonly LabEventType[];
    payloadHash: string;
  },
) {
  const [event] = await ctx.db
    .select({
      labResultId: labResultEvents.labResultId,
      eventType: labResultEvents.eventType,
      operationPayloadHash: labResultEvents.operationPayloadHash,
    })
    .from(labResultEvents)
    .where(
      and(
        eq(labResultEvents.practiceId, ctx.practiceId),
        eq(labResultEvents.operationId, operationId),
      ),
    )
    .limit(1);
  if (!event) return null;
  if (
    (expected.resultId && event.labResultId !== expected.resultId) ||
    !expected.eventTypes.includes(event.eventType) ||
    event.operationPayloadHash !== expected.payloadHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This lab operation id was already used for different clinical evidence.",
    });
  }
  return getLabStatusForUpdate(ctx, event.labResultId);
}

function labMutationResultForRole(
  result: typeof labResults.$inferSelect,
  role: string,
) {
  if (role !== "front_desk") return result;
  return {
    id: result.id,
    patientId: result.patientId,
    followUpStatus: result.followUpStatus,
    followUpAssignedTo: result.followUpAssignedTo,
    followUpCompletedAt: result.followUpCompletedAt,
  };
}

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
          or(
            isNull(prescriptions.endDate),
            gte(
              prescriptions.endDate,
              practiceTodayExpression(ctx.practiceId),
            )
          ),
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
      unitPrice: products.unitPrice,
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

async function createDispenseChargeWork(
  ctx: RecordsContext,
  input: {
    prescriptionEventId: string;
    prescriptionId: string;
    patientId: string;
    appointmentId?: string | null;
    productId: string;
    quantity: number;
    medicationName: string;
  },
) {
  const [[patient], product] = await Promise.all([
    ctx.db
      .select({ clientId: patients.clientId })
      .from(patients)
      .where(
        and(
          eq(patients.id, input.patientId),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .for("share"),
    assertDispensedProductBelongsToPractice(ctx, input.productId),
  ]);
  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }
  const description = `${product.name} — ${input.medicationName}`.slice(0, 500);
  await ctx.db.insert(dispenseChargeQueue).values({
    practiceId: ctx.practiceId,
    prescriptionEventId: input.prescriptionEventId,
    prescriptionId: input.prescriptionId,
    patientId: input.patientId,
    clientId: patient.clientId,
    appointmentId: input.appointmentId ?? null,
    productId: input.productId,
    quantity: input.quantity,
    descriptionSnapshot: description,
    unitPriceSnapshot: product.unitPrice,
  });
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

type LockedPrescription = {
  id: string;
  patientId: string;
  productId: string | null;
  quantity: number | null;
  refillsRemaining: number;
  status: PrescriptionStatus;
  endDate: string | null;
  medicationName: string;
};

async function lockPrescriptionForLifecycle(
  ctx: RecordsContext,
  prescriptionId: string
): Promise<LockedPrescription> {
  const [prescription] = await ctx.db
    .select({
      id: prescriptions.id,
      patientId: prescriptions.patientId,
      productId: prescriptions.productId,
      quantity: prescriptions.quantity,
      refillsRemaining: prescriptions.refillsRemaining,
      status: prescriptions.status,
      endDate: prescriptions.endDate,
      medicationName: prescriptions.medicationName,
    })
    .from(prescriptions)
    .where(
      and(
        eq(prescriptions.id, prescriptionId),
        eq(prescriptions.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(prescriptions.deletedAt)
      )
    )
    .limit(1)
    .for("update");

  if (!prescription) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Prescription not found" });
  }
  return prescription;
}

async function lifecycleOperationReplay(
  ctx: RecordsContext,
  input: {
    prescriptionId: string;
    operationId: string;
    eventTypes: PrescriptionEventType[];
    reason: string | null;
    appointmentId?: string | null;
  }
) {
  const [event] = await ctx.db
    .select()
    .from(prescriptionEvents)
    .where(
      and(
        eq(prescriptionEvents.practiceId, ctx.practiceId),
        eq(prescriptionEvents.operationId, input.operationId)
      )
    )
    .limit(1);
  if (!event) return null;
  if (event.prescriptionId !== input.prescriptionId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This prescription operation ID was already used for another change.",
    });
  }

  const [prescription] = await ctx.db
    .select()
    .from(prescriptions)
    .where(
      and(
        eq(prescriptions.id, input.prescriptionId),
        eq(prescriptions.practiceId, ctx.practiceId),
        isNull(prescriptions.deletedAt)
      )
    )
    .limit(1);
  if (!prescription) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Prescription not found" });
  }
  const expectedEventType =
    input.eventTypes.length === 2
      ? prescription.productId
        ? "refill_dispensed"
        : "refill_authorized"
      : input.eventTypes[0];
  if (
    event.eventType !== expectedEventType ||
    (event.reason ?? null) !== input.reason
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This prescription operation ID was already used for different details.",
    });
  }
  if (event.eventType === "refill_dispensed") {
    const [charge] = await ctx.db
      .select({ appointmentId: dispenseChargeQueue.appointmentId })
      .from(dispenseChargeQueue)
      .where(
        and(
          eq(dispenseChargeQueue.practiceId, ctx.practiceId),
          eq(dispenseChargeQueue.prescriptionEventId, event.id),
        ),
      )
      .limit(1);
    if (!charge || charge.appointmentId !== (input.appointmentId ?? null)) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This prescription operation ID was already used for different visit details.",
      });
    }
  }
  return { prescription, event, replayed: true as const };
}

const prescriptionLifecycleReasonInput = z
  .string()
  .trim()
  .min(
    PRESCRIPTION_LIFECYCLE_REASON_MIN_LENGTH,
    "Explain the prescription lifecycle change."
  )
  .max(PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH);

async function transitionPrescription(
  ctx: RecordsContext & { user: { id: string; name: string } },
  input: {
    id: string;
    operationId: string;
    reason: string;
    targetStatus: "completed" | "cancelled";
  }
) {
  const eventType = input.targetStatus;
  return (ctx.db as Database).transaction(async (tx) => {
    const txCtx = { db: tx, practiceId: ctx.practiceId };
    const operationKey = `prescription-lifecycle:${ctx.practiceId}:${input.operationId}`;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`
    );
    const replay = await lifecycleOperationReplay(txCtx, {
      prescriptionId: input.id,
      operationId: input.operationId,
      eventTypes: [eventType],
      reason: input.reason,
    });
    if (replay) return replay;

    const prescription = await lockPrescriptionForLifecycle(txCtx, input.id);
    const today = await practiceDateInput(txCtx);
    const effectiveStatus = effectivePrescriptionStatus({
      status: prescription.status,
      endDate: prescription.endDate,
      today,
    });
    if (effectiveStatus !== "active") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Prescription is already ${effectiveStatus}.`,
      });
    }

    const [updated] = await tx
      .update(prescriptions)
      .set({ status: input.targetStatus, updatedAt: new Date() })
      .where(
        and(
          eq(prescriptions.id, prescription.id),
          eq(prescriptions.practiceId, ctx.practiceId),
          eq(prescriptions.status, "active"),
          isNull(prescriptions.deletedAt)
        )
      )
      .returning();
    if (!updated) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Prescription changed while updating. Refresh and try again.",
      });
    }

    const [event] = await tx
      .insert(prescriptionEvents)
      .values({
        practiceId: ctx.practiceId,
        prescriptionId: prescription.id,
        patientId: prescription.patientId,
        productId: prescription.productId,
        quantity: prescription.quantity,
        eventType,
        statusBefore: "active",
        statusAfter: input.targetStatus,
        refillsBefore: prescription.refillsRemaining,
        refillsAfter: prescription.refillsRemaining,
        reason: input.reason,
        actorId: ctx.user.id,
        actorName: ctx.user.name,
        operationId: input.operationId,
      })
      .returning();
    return { prescription: updated, event: event!, replayed: false as const };
  });
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
) {
  const [result] = await ctx.db
    .select(getTableColumns(labResults))
    .from(labResults)
    .where(
      and(
        eq(labResults.id, id),
        eq(labResults.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        activeLabResultPredicate(ctx.practiceId),
        isNull(labResults.deletedAt),
      ),
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

const soapSectionsInput = {
  subjective: optionalClinicalTextInput(
    "SOAP subjective",
    SOAP_SECTION_MAX_LENGTH,
  ),
  objective: optionalClinicalTextInput(
    "SOAP objective",
    SOAP_SECTION_MAX_LENGTH,
  ),
  assessment: optionalClinicalTextInput(
    "SOAP assessment",
    SOAP_SECTION_MAX_LENGTH,
  ),
  plan: optionalClinicalTextInput("SOAP plan", SOAP_SECTION_MAX_LENGTH),
};

function rethrowSoapLifecycleError(error: unknown): never {
  if (error instanceof SoapLifecycleError) {
    throw new TRPCError({ code: error.code, message: error.message });
  }
  throw error;
}

export const recordsRouter = createRouter({
  settings: protectedProcedure.query(async ({ ctx }) => practiceSettings(ctx)),

  // SOAP Notes
  listSoapNotes: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const notes = await ctx.db
        .select({
          id: soapNotes.id,
          patientId: soapNotes.patientId,
          appointmentId: soapNotes.appointmentId,
          subjective: soapNotes.subjective,
          objective: soapNotes.objective,
          assessment: soapNotes.assessment,
          plan: soapNotes.plan,
          authorId: soapNotes.authorId,
          authorName: soapNotes.authorName,
          status: soapNotes.status,
          revision: soapNotes.revision,
          finalizedAt: soapNotes.finalizedAt,
          finalizedBy: soapNotes.finalizedBy,
          finalizerName: soapNotes.finalizerName,
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

      if (notes.length === 0) return [];
      const addenda = await ctx.db
        .select({
          id: soapNoteAddenda.id,
          soapNoteId: soapNoteAddenda.soapNoteId,
          authorId: soapNoteAddenda.authorId,
          authorName: soapNoteAddenda.authorName,
          content: soapNoteAddenda.content,
          createdAt: soapNoteAddenda.createdAt,
        })
        .from(soapNoteAddenda)
        .where(
          and(
            eq(soapNoteAddenda.practiceId, ctx.practiceId),
            inArray(
              soapNoteAddenda.soapNoteId,
              notes.map((note) => note.id),
            ),
          ),
        )
        .orderBy(asc(soapNoteAddenda.createdAt), asc(soapNoteAddenda.id));
      const addendaByNote = new Map<string, typeof addenda>();
      for (const addendum of addenda) {
        const list = addendaByNote.get(addendum.soapNoteId) ?? [];
        list.push(addendum);
        addendaByNote.set(addendum.soapNoteId, list);
      }
      return notes.map((note) => ({
        ...note,
        addenda: addendaByNote.get(note.id) ?? [],
      }));
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
        const sourcePredicate = and(
          eq(soapNotes.id, input.recordId),
          eq(soapNotes.patientId, input.patientId),
          eq(soapNotes.practiceId, ctx.practiceId),
          eq(soapNotes.status, "finalized"),
          activePracticePredicate(ctx.practiceId),
          isNull(soapNotes.deletedAt),
        );
        const [sourceIdentity] = await tx
          .select({
            id: soapNotes.id,
            patientId: soapNotes.patientId,
            appointmentId: soapNotes.appointmentId,
          })
          .from(soapNotes)
          .where(sourcePredicate)
          .limit(1);

        if (!sourceIdentity) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Clinical record not found",
          });
        }

        // The closeout path locks the appointment before reading SOAP state.
        // Use the same order so correction and closeout cannot sign through
        // one another based on different views of the chart.
        if (sourceIdentity.appointmentId) {
          await tx
            .select({ id: appointments.id })
            .from(appointments)
            .where(
              and(
                eq(appointments.id, sourceIdentity.appointmentId),
                eq(appointments.practiceId, ctx.practiceId),
              ),
            )
            .limit(1)
            .for("update");
        }

        const [source] = await tx
          .select({
            id: soapNotes.id,
            patientId: soapNotes.patientId,
            appointmentId: soapNotes.appointmentId,
          })
          .from(soapNotes)
          .where(sourcePredicate)
          .limit(1)
          .for("update");
        if (!source) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "SOAP note changed while the correction was being recorded. Refresh and retry.",
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
        ...soapSectionsInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let note;
      try {
        note = await ctx.db.transaction((tx) =>
          createFinalizedAppointmentSoapNote(tx as unknown as Database, {
            practiceId: ctx.practiceId,
            patientId: input.patientId,
            appointmentId: input.appointmentId,
            actor: { id: ctx.user.id, name: ctx.user.name },
            sections: input,
          }),
        );
      } catch (error) {
        rethrowSoapLifecycleError(error);
      }
      const dispatch = () =>
        dispatchWebhookEvent(ctx.practiceId, "soap_note.created", {
          id: note.id,
          patientId: note.patientId,
          appointmentId: note.appointmentId,
          authorId: note.authorId,
          source: "dashboard",
        });
      if (ctx.postCommitEffect) {
        ctx.postCommitEffect(async () => dispatch());
      } else {
        await dispatch();
      }
      return note;
    }),

  getSoapDraft: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) =>
      getAppointmentSoapDraft(ctx.db, {
        practiceId: ctx.practiceId,
        ...input,
      }),
    ),

  saveSoapDraft: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        noteId: z.string().uuid().optional(),
        expectedRevision: z.number().int().min(0),
        ...soapSectionsInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.transaction((tx) =>
          saveAppointmentSoapDraft(tx as unknown as Database, {
            practiceId: ctx.practiceId,
            ...input,
            actor: { id: ctx.user.id, name: ctx.user.name },
            sections: input,
          }),
        );
      } catch (error) {
        rethrowSoapLifecycleError(error);
      }
    }),

  finalizeSoapNote: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        noteId: z.string().uuid(),
        expectedRevision: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let result;
      try {
        result = await ctx.db.transaction((tx) =>
          finalizeAppointmentSoapDraft(tx as unknown as Database, {
            practiceId: ctx.practiceId,
            ...input,
            actor: { id: ctx.user.id, name: ctx.user.name },
          }),
        );
      } catch (error) {
        rethrowSoapLifecycleError(error);
      }
      if (result.outcome === "finalized" && result.transitioned) {
        const note = result.note;
        const dispatch = () =>
          dispatchWebhookEvent(ctx.practiceId, "soap_note.created", {
            id: note.id,
            patientId: note.patientId,
            appointmentId: note.appointmentId,
            authorId: note.authorId,
            source: "dashboard",
          });
        if (ctx.postCommitEffect) {
          ctx.postCommitEffect(async () => dispatch());
        } else {
          await dispatch();
        }
      }
      return result;
    }),

  discardSoapDraft: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid(),
        noteId: z.string().uuid(),
        expectedRevision: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.transaction((tx) =>
          discardAppointmentSoapDraft(tx as unknown as Database, {
            practiceId: ctx.practiceId,
            ...input,
          }),
        );
      } catch (error) {
        rethrowSoapLifecycleError(error);
      }
    }),

  addSoapNoteAddendum: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        noteId: z.string().uuid(),
        operationId: z.string().uuid(),
        content: z.string().trim().min(1).max(SOAP_SECTION_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.transaction((tx) =>
          addFinalizedSoapAddendum(tx as unknown as Database, {
            practiceId: ctx.practiceId,
            ...input,
            actor: { id: ctx.user.id, name: ctx.user.name },
          }),
        );
      } catch (error) {
        rethrowSoapLifecycleError(error);
      }
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
          correctionId: clinicalRecordCorrections.id,
          correctionAction: clinicalRecordCorrections.action,
          correctionReason: clinicalRecordCorrections.reason,
          correctedAt: clinicalRecordCorrections.createdAt,
          correctedBy: clinicalRecordCorrections.correctedBy,
          correctedByName: clinicalRecordCorrections.correctedByName,
        })
        .from(vaccinationRecords)
        .leftJoin(
          users,
          and(
            eq(vaccinationRecords.administeredBy, users.id),
            eq(users.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          clinicalRecordCorrections,
          and(
            eq(
              clinicalRecordCorrections.vaccinationRecordId,
              vaccinationRecords.id
            ),
            eq(clinicalRecordCorrections.practiceId, ctx.practiceId)
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

  markVaccinationEnteredInError: protectedProcedure
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
            id: vaccinationRecords.id,
            patientId: vaccinationRecords.patientId,
            appointmentId: vaccinationRecords.appointmentId,
          })
          .from(vaccinationRecords)
          .where(
            and(
              eq(vaccinationRecords.id, input.recordId),
              eq(vaccinationRecords.patientId, input.patientId),
              eq(vaccinationRecords.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(vaccinationRecords.deletedAt)
            )
          )
          .limit(1)
          .for("update", { of: vaccinationRecords });

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
            recordType: "vaccination_record",
            action: "entered_in_error",
            vaccinationRecordId: source.id,
            patientId: source.patientId,
            appointmentId: source.appointmentId,
            reason: input.reason,
            correctedBy: ctx.user.id,
            correctedByName: ctx.user.name,
          })
          .onConflictDoNothing()
          .returning();

        if (created) {
          // Only unresolved work can be voided here. Charged or waived work—and
          // every invoice/payment row—remain untouched for financial audit.
          await tx
            .update(visitWorkItems)
            .set({
              status: "voided",
              voidReason: input.reason,
              resolvedBy: ctx.user.id,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(visitWorkItems.practiceId, ctx.practiceId),
                eq(visitWorkItems.vaccinationRecordId, source.id),
                eq(visitWorkItems.status, "unresolved"),
                isNull(visitWorkItems.invoiceId),
                isNull(visitWorkItems.invoiceItemId),
                isNull(visitWorkItems.deletedAt)
              )
            );
          return created;
        }

        const [existing] = await tx
          .select()
          .from(clinicalRecordCorrections)
          .where(
            and(
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
              eq(clinicalRecordCorrections.vaccinationRecordId, source.id)
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
          effectiveStatus: effectivePrescriptionStatusExpression(
            ctx.practiceId,
          ),
          instructions: prescriptions.instructions,
          prescriberName: users.name,
          createdAt: prescriptions.createdAt,
        })
        .from(prescriptions)
        .leftJoin(
          users,
          and(
            eq(prescriptions.prescribedBy, users.id),
            eq(users.practiceId, ctx.practiceId)
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

  listPrescriptionEvents: protectedProcedure
    .input(z.object({ prescriptionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: prescriptionEvents.id,
          eventType: prescriptionEvents.eventType,
          productId: prescriptionEvents.productId,
          quantity: prescriptionEvents.quantity,
          statusBefore: prescriptionEvents.statusBefore,
          statusAfter: prescriptionEvents.statusAfter,
          refillsBefore: prescriptionEvents.refillsBefore,
          refillsAfter: prescriptionEvents.refillsAfter,
          reason: prescriptionEvents.reason,
          actorName: prescriptionEvents.actorName,
          createdAt: prescriptionEvents.createdAt,
          dispenseChargeId: dispenseChargeQueue.id,
          dispenseChargeStatus: dispenseChargeQueue.status,
          dispenseChargeInvoiceId: dispenseChargeQueue.invoiceId,
        })
        .from(prescriptionEvents)
        .leftJoin(
          dispenseChargeQueue,
          and(
            eq(dispenseChargeQueue.prescriptionEventId, prescriptionEvents.id),
            eq(dispenseChargeQueue.practiceId, ctx.practiceId)
          )
        )
        .where(
          and(
            eq(prescriptionEvents.practiceId, ctx.practiceId),
            eq(prescriptionEvents.prescriptionId, input.prescriptionId),
            activePracticePredicate(ctx.practiceId)
          )
        )
        .orderBy(desc(prescriptionEvents.createdAt), desc(prescriptionEvents.id));
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
          const [createdEvent] = await tx
            .select({
              refillsAfter: prescriptionEvents.refillsAfter,
            })
            .from(prescriptionEvents)
            .where(
              and(
                eq(prescriptionEvents.practiceId, ctx.practiceId),
                eq(prescriptionEvents.prescriptionId, existing.id),
                eq(prescriptionEvents.eventType, "created"),
              ),
            )
            .limit(1);
          if (
            !createdEvent ||
            existing.patientId !== input.patientId ||
            (existing.appointmentId ?? null) !== (input.appointmentId ?? null) ||
            existing.medicationName !== input.medicationName ||
            existing.dosage !== input.dosage ||
            existing.frequency !== input.frequency ||
            (existing.quantity ?? null) !== (input.quantity ?? null) ||
            (existing.productId ?? null) !== (input.productId ?? null) ||
            createdEvent.refillsAfter !== input.refillsRemaining ||
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
        const [createdEvent] = await tx
          .insert(prescriptionEvents)
          .values({
            practiceId: ctx.practiceId,
            prescriptionId: rx!.id,
            patientId: rx!.patientId,
            productId: rx!.productId,
            quantity: rx!.quantity,
            eventType: "created",
            statusBefore: null,
            statusAfter: "active",
            refillsBefore: null,
            refillsAfter: rx!.refillsRemaining,
            reason: null,
            actorId: ctx.user.id,
            actorName: ctx.user.name,
            operationId: input.operationId,
          })
          .returning({ id: prescriptionEvents.id });
        if (rx!.productId && rx!.quantity) {
          await createDispenseChargeWork(txCtx, {
            prescriptionEventId: createdEvent!.id,
            prescriptionId: rx!.id,
            patientId: rx!.patientId,
            appointmentId: rx!.appointmentId,
            productId: rx!.productId,
            quantity: rx!.quantity,
            medicationName: rx!.medicationName,
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

  recordPrescriptionRefill: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
        note: z
          .string()
          .trim()
          .max(PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx = { db: tx, practiceId: ctx.practiceId };
        const operationKey = `prescription-lifecycle:${ctx.practiceId}:${input.operationId}`;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`
        );
        const replay = await lifecycleOperationReplay(txCtx, {
          prescriptionId: input.id,
          operationId: input.operationId,
          eventTypes: ["refill_dispensed", "refill_authorized"],
          reason: input.note?.trim() || null,
          appointmentId: input.appointmentId,
        });
        if (replay) return replay;

        const prescription = await lockPrescriptionForLifecycle(txCtx, input.id);
        if (input.appointmentId) {
          await assertAppointmentBelongsToPatient(
            txCtx,
            input.appointmentId,
            prescription.patientId,
          );
          await lockOpenAppointmentForClinicalWork(
            txCtx,
            input.appointmentId,
            prescription.patientId,
            "prescriptions",
          );
        }
        const today = await practiceDateInput(txCtx);
        const effectiveStatus = effectivePrescriptionStatus({
          status: prescription.status,
          endDate: prescription.endDate,
          today,
        });
        if (effectiveStatus !== "active") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Prescription is ${effectiveStatus}; a refill cannot be recorded.`,
          });
        }
        if (prescription.refillsRemaining < 1) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Prescription has no remaining refills.",
          });
        }
        if (prescription.productId && !prescription.quantity) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This prescription links clinic inventory without a positive dispensing quantity. Correct the prescription before recording a refill.",
          });
        }

        const eventType = prescription.productId
          ? "refill_dispensed"
          : "refill_authorized";
        if (prescription.productId && prescription.quantity) {
          await assertDispensedProductBelongsToPractice(
            txCtx,
            prescription.productId
          );
          await deductDispensedProductStock(
            txCtx,
            prescription.productId,
            prescription.quantity
          );
        }
        const [updated] = await tx
          .update(prescriptions)
          .set({
            refillsRemaining: sql`${prescriptions.refillsRemaining} - 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(prescriptions.id, prescription.id),
              eq(prescriptions.practiceId, ctx.practiceId),
              eq(prescriptions.status, "active"),
              eq(prescriptions.refillsRemaining, prescription.refillsRemaining),
              isNull(prescriptions.deletedAt)
            )
          )
          .returning();
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Prescription changed while dispensing. Refresh and try again.",
          });
        }
        const [event] = await tx
          .insert(prescriptionEvents)
          .values({
            practiceId: ctx.practiceId,
            prescriptionId: prescription.id,
            patientId: prescription.patientId,
            productId: prescription.productId,
            quantity: prescription.quantity,
            eventType,
            statusBefore: "active",
            statusAfter: "active",
            refillsBefore: prescription.refillsRemaining,
            refillsAfter: prescription.refillsRemaining - 1,
            reason: input.note || null,
            actorId: ctx.user.id,
            actorName: ctx.user.name,
            operationId: input.operationId,
          })
          .returning();
        if (
          event?.eventType === "refill_dispensed" &&
          event.productId &&
          event.quantity
        ) {
          await createDispenseChargeWork(txCtx, {
            prescriptionEventId: event.id,
            prescriptionId: prescription.id,
            patientId: prescription.patientId,
            appointmentId: input.appointmentId,
            productId: event.productId,
            quantity: event.quantity,
            medicationName: prescription.medicationName,
          });
        }
        return { prescription: updated, event: event!, replayed: false as const };
      });
      if (!result.replayed) {
        const webhookEvent =
          result.event.eventType === "refill_dispensed"
            ? "prescription.refill_dispensed"
            : "prescription.refill_authorized";
        await dispatchWebhookEvent(ctx.practiceId, webhookEvent, {
          id: result.prescription.id,
          patientId: result.prescription.patientId,
          productId: result.prescription.productId,
          quantity: result.prescription.quantity,
          refillsRemaining: result.prescription.refillsRemaining,
          source: "dashboard",
        });
      }
      return result;
    }),

  completePrescription: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        reason: prescriptionLifecycleReasonInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await transitionPrescription(
        { db: ctx.db, practiceId: ctx.practiceId, user: ctx.user },
        { ...input, targetStatus: "completed" }
      );
      if (!result.replayed) {
        await dispatchWebhookEvent(ctx.practiceId, "prescription.completed", {
          id: result.prescription.id,
          patientId: result.prescription.patientId,
          source: "dashboard",
        });
      }
      return result;
    }),

  cancelPrescription: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        id: z.string().uuid(),
        operationId: z.string().uuid(),
        reason: prescriptionLifecycleReasonInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await transitionPrescription(
        { db: ctx.db, practiceId: ctx.practiceId, user: ctx.user },
        { ...input, targetStatus: "cancelled" }
      );
      if (!result.replayed) {
        await dispatchWebhookEvent(ctx.practiceId, "prescription.cancelled", {
          id: result.prescription.id,
          patientId: result.prescription.patientId,
          source: "dashboard",
        });
      }
      return result;
    }),

  // Lab Results
  listLabResults: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "viewer"))
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const orderedBy = alias(users, "lab_ordered_by");
      const reviewedBy = alias(users, "lab_reviewed_by");
      const followUpAssignee = alias(users, "lab_follow_up_assignee");
      const rows = await ctx.db
        .select({
          id: labResults.id,
          appointmentId: labResults.appointmentId,
          testName: labResults.testName,
          resultValue: labResults.resultValue,
          unit: labResults.unit,
          referenceRangeLow: labResults.referenceRangeLow,
          referenceRangeHigh: labResults.referenceRangeHigh,
          status: labResults.status,
          resultFlag: labResults.resultFlag,
          orderedByName: orderedBy.name,
          completedAt: labResults.completedAt,
          completionActorName: sql<string | null>`(
            select event.actor_name
            from lab_result_events event
            where event.practice_id = ${ctx.practiceId}
              and event.lab_result_id = ${labResults.id}
              and (
                event.event_type = 'completed'
                or (event.event_type = 'created' and event.status_after = 'completed')
              )
            order by event.created_at asc, event.id asc
            limit 1
          )`,
          reviewedAt: labResults.reviewedAt,
          reviewedByName: reviewedBy.name,
          followUpStatus: labResults.followUpStatus,
          followUpAssignedTo: labResults.followUpAssignedTo,
          followUpAssigneeName: followUpAssignee.name,
          followUpDueAt: labResults.followUpDueAt,
          followUpNote: labResults.followUpNote,
          followUpCompletedAt: labResults.followUpCompletedAt,
          followUpOutcome: labResults.followUpOutcome,
          replacesLabResultId: sql<string | null>`(
            select replacement_link.source_lab_result_id
            from ${labResultReplacements} as replacement_link
            where replacement_link.practice_id = ${ctx.practiceId}
              and replacement_link.replacement_lab_result_id = ${labResults.id}
            limit 1
          )`,
          replacesLabResultPatientId: sql<string | null>`(
            select source_result.patient_id
            from ${labResultReplacements} as replacement_link
            inner join ${labResults} as source_result
              on source_result.practice_id = ${ctx.practiceId}
             and source_result.id = replacement_link.source_lab_result_id
            where replacement_link.practice_id = ${ctx.practiceId}
              and replacement_link.replacement_lab_result_id = ${labResults.id}
            limit 1
          )`,
          replacementLabResultId: sql<string | null>`(
            select replacement_link.replacement_lab_result_id
            from ${labResultReplacements} as replacement_link
            where replacement_link.practice_id = ${ctx.practiceId}
              and replacement_link.source_lab_result_id = ${labResults.id}
            limit 1
          )`,
          replacementLabResultPatientId: sql<string | null>`(
            select replacement_result.patient_id
            from ${labResultReplacements} as replacement_link
            inner join ${labResults} as replacement_result
              on replacement_result.practice_id = ${ctx.practiceId}
             and replacement_result.id = replacement_link.replacement_lab_result_id
            where replacement_link.practice_id = ${ctx.practiceId}
              and replacement_link.source_lab_result_id = ${labResults.id}
            limit 1
          )`,
          correctionId: clinicalRecordCorrections.id,
          correctionReason: clinicalRecordCorrections.reason,
          correctedAt: clinicalRecordCorrections.createdAt,
          correctedByName: clinicalRecordCorrections.correctedByName,
          createdAt: labResults.createdAt,
        })
        .from(labResults)
        .leftJoin(
          orderedBy,
          and(
            eq(labResults.orderedBy, orderedBy.id),
            eq(orderedBy.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          reviewedBy,
          and(
            eq(labResults.reviewedBy, reviewedBy.id),
            eq(reviewedBy.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          followUpAssignee,
          and(
            eq(labResults.followUpAssignedTo, followUpAssignee.id),
            eq(followUpAssignee.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          clinicalRecordCorrections,
          and(
            eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
            eq(clinicalRecordCorrections.labResultId, labResults.id),
          ),
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

  listLabResultHistory: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "viewer"))
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [result] = await ctx.db
        .select({ id: labResults.id })
        .from(labResults)
        .where(
          and(
            eq(labResults.id, input.id),
            eq(labResults.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(labResults.deletedAt),
          ),
        )
        .limit(1);
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Lab result not found in this clinic.",
        });
      }

      return ctx.db
        .select({
          id: labResultEvents.id,
          createdAt: labResultEvents.createdAt,
          eventType: labResultEvents.eventType,
          statusBefore: labResultEvents.statusBefore,
          statusAfter: labResultEvents.statusAfter,
          resultValue: labResultEvents.resultValue,
          unit: labResultEvents.unit,
          referenceRangeLow: labResultEvents.referenceRangeLow,
          referenceRangeHigh: labResultEvents.referenceRangeHigh,
          resultFlag: labResultEvents.resultFlag,
          followUpStatus: labResultEvents.followUpStatus,
          followUpAssignedTo: labResultEvents.followUpAssignedTo,
          followUpDueAt: labResultEvents.followUpDueAt,
          actorName: labResultEvents.actorName,
          note: labResultEvents.note,
        })
        .from(labResultEvents)
        .where(
          and(
            eq(labResultEvents.practiceId, ctx.practiceId),
            eq(labResultEvents.labResultId, input.id),
          ),
        )
        .orderBy(desc(labResultEvents.createdAt), desc(labResultEvents.id));
    }),

  listLabReviewInbox: protectedProcedure
    .input(
      z.object({
        resultId: z.string().uuid().optional(),
        filter: z
          .enum(["action_required", "awaiting_results", "awaiting_review", "critical", "follow_up", "all"])
          .default("action_required"),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const orderedBy = alias(users, "inbox_lab_ordered_by");
      const reviewedBy = alias(users, "inbox_lab_reviewed_by");
      const assignee = alias(users, "inbox_lab_assignee");
      const clinician = alias(users, "inbox_lab_clinician");
      const conditions = [
        eq(labResults.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        activeLabResultPredicate(ctx.practiceId),
        isNull(labResults.deletedAt),
      ];

      const frontDeskMode = ctx.user.role === "front_desk";
      if (input.resultId) {
        conditions.push(eq(labResults.id, input.resultId));
      }
      if (frontDeskMode) {
        conditions.push(
          eq(labResults.followUpStatus, "open"),
          eq(labResults.followUpAssignedTo, ctx.user.id),
        );
      } else if (!input.resultId && input.filter === "action_required") {
        conditions.push(
          or(ne(labResults.status, "reviewed"), eq(labResults.followUpStatus, "open"))!
        );
      } else if (!input.resultId && input.filter === "awaiting_results") {
        conditions.push(eq(labResults.status, "pending"));
      } else if (!input.resultId && input.filter === "awaiting_review") {
        conditions.push(eq(labResults.status, "completed"));
      } else if (!input.resultId && input.filter === "critical") {
        conditions.push(eq(labResults.resultFlag, "critical"));
      } else if (!input.resultId && input.filter === "follow_up") {
        conditions.push(eq(labResults.followUpStatus, "open"));
      }

      const rows = await ctx.db
        .select({
          id: labResults.id,
          patientId: labResults.patientId,
          patientName: patients.name,
          appointmentId: labResults.appointmentId,
          appointmentStart: appointments.startTime,
          appointmentStatus: appointments.status,
          clinicianName: clinician.name,
          testName: labResults.testName,
          resultValue: labResults.resultValue,
          unit: labResults.unit,
          referenceRangeLow: labResults.referenceRangeLow,
          referenceRangeHigh: labResults.referenceRangeHigh,
          resultFlag: labResults.resultFlag,
          status: labResults.status,
          orderedByName: orderedBy.name,
          completedAt: labResults.completedAt,
          completionActorName: sql<string | null>`(
            select event.actor_name
            from lab_result_events event
            where event.practice_id = ${ctx.practiceId}
              and event.lab_result_id = ${labResults.id}
              and (
                event.event_type = 'completed'
                or (event.event_type = 'created' and event.status_after = 'completed')
              )
            order by event.created_at asc, event.id asc
            limit 1
          )`,
          reviewedAt: labResults.reviewedAt,
          reviewedByName: reviewedBy.name,
          followUpStatus: labResults.followUpStatus,
          followUpAssignedTo: labResults.followUpAssignedTo,
          followUpAssigneeName: assignee.name,
          followUpDueAt: labResults.followUpDueAt,
          followUpNote: labResults.followUpNote,
          followUpCompletedAt: labResults.followUpCompletedAt,
          followUpOutcome: labResults.followUpOutcome,
          createdAt: labResults.createdAt,
        })
        .from(labResults)
        .innerJoin(
          patients,
          and(
            eq(labResults.patientId, patients.id),
            eq(patients.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          appointments,
          and(
            eq(labResults.appointmentId, appointments.id),
            eq(appointments.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          clinician,
          and(
            eq(appointments.doctorId, clinician.id),
            eq(clinician.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          orderedBy,
          and(
            eq(labResults.orderedBy, orderedBy.id),
            eq(orderedBy.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          reviewedBy,
          and(
            eq(labResults.reviewedBy, reviewedBy.id),
            eq(reviewedBy.practiceId, ctx.practiceId)
          )
        )
        .leftJoin(
          assignee,
          and(
            eq(labResults.followUpAssignedTo, assignee.id),
            eq(assignee.practiceId, ctx.practiceId)
          )
        )
        .where(and(...conditions))
        .orderBy(
          asc(sql`case ${labResults.resultFlag}
            when 'critical' then 0 else 1 end`),
          asc(sql`case ${labResults.followUpStatus}
            when 'open' then 0 else 1 end`),
          asc(sql`case when ${labResults.followUpStatus} = 'open'
            then coalesce(${labResults.followUpDueAt}, 'infinity'::timestamptz)
            else 'infinity'::timestamptz end`),
          asc(sql`case ${labResults.status}
            when 'completed' then 0 when 'pending' then 1 else 2 end`),
          asc(sql`coalesce(${labResults.completedAt}, ${labResults.createdAt})`),
          asc(labResults.id)
        )
        .limit(input.resultId ? 2 : input.limit + 1);
      const visibleRows = frontDeskMode
        ? rows
            .filter(
              (row) =>
                row.followUpStatus === "open" &&
                row.followUpAssignedTo === ctx.user.id,
            )
            .map((row) => ({
              ...row,
              resultValue: null,
              unit: null,
              referenceRangeLow: null,
              referenceRangeHigh: null,
              resultFlag: "unknown" as const,
              orderedByName: null,
              completedAt: null,
              completionActorName: null,
              reviewedAt: null,
              reviewedByName: null,
              followUpOutcome: null,
            }))
        : rows;
      return {
        items: visibleRows.slice(0, input.limit),
        truncated: !input.resultId && visibleRows.length > input.limit,
      };
    }),

  listLabAssignees: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .query(async ({ ctx }) => {
      return ctx.db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(
          and(
            eq(users.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            ne(users.role, "viewer"),
            isNull(users.deletedAt)
          )
        )
        .orderBy(asc(users.name));
    }),

  markLabResultEnteredInError: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: z.string().uuid(),
        recordId: z.string().uuid(),
        operationId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(CLINICAL_CORRECTION_REASON_MIN_LENGTH)
          .max(CLINICAL_CORRECTION_REASON_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const operationPayloadHash = labOperationHash({
        kind: "lab_result_entered_in_error",
        patientId: input.patientId,
        recordId: input.recordId,
        reason: input.reason,
      });

      return ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        await lockLabResultSource(txCtx, input.recordId);

        const [operationReplay] = await tx
          .select()
          .from(clinicalRecordCorrections)
          .where(
            and(
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
              eq(clinicalRecordCorrections.operationId, input.operationId),
            ),
          )
          .limit(1);
        if (operationReplay) {
          if (
            operationReplay.recordType !== "lab_result" ||
            operationReplay.labResultId !== input.recordId ||
            operationReplay.patientId !== input.patientId ||
            operationReplay.operationPayloadHash !== operationPayloadHash
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This correction operation id was already used for different clinical evidence.",
            });
          }
          return operationReplay;
        }

        const [source] = await tx
          .select({
            id: labResults.id,
            patientId: labResults.patientId,
            appointmentId: labResults.appointmentId,
          })
          .from(labResults)
          .where(
            and(
              eq(labResults.id, input.recordId),
              eq(labResults.patientId, input.patientId),
              eq(labResults.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(labResults.deletedAt),
            ),
          )
          .limit(1)
          .for("update", { of: labResults });
        if (!source) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Clinical record not found",
          });
        }

        const [sourceCorrection] = await tx
          .select()
          .from(clinicalRecordCorrections)
          .where(
            and(
              eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
              eq(clinicalRecordCorrections.labResultId, source.id),
            ),
          )
          .limit(1);
        if (sourceCorrection) {
          if (
            sourceCorrection.recordType === "lab_result" &&
            sourceCorrection.labResultId === source.id &&
            sourceCorrection.patientId === source.patientId &&
            sourceCorrection.operationPayloadHash === operationPayloadHash
          ) {
            return sourceCorrection;
          }
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This lab result already has a different correction. Refresh the chart.",
          });
        }

        const [created] = await tx
          .insert(clinicalRecordCorrections)
          .values({
            practiceId: ctx.practiceId,
            recordType: "lab_result",
            action: "entered_in_error",
            labResultId: source.id,
            patientId: source.patientId,
            appointmentId: source.appointmentId,
            reason: input.reason,
            correctedBy: ctx.user.id,
            correctedByName: ctx.user.name,
            operationId: input.operationId,
            operationPayloadHash,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Clinical correction changed; refresh and retry.",
          });
        }

        // Preserve the work item and all financial history. Only unresolved,
        // unbilled work is voided so visit closeout cannot be blocked by an
        // entered-in-error lab result.
        const occurredAt = new Date();
        await tx
          .update(visitWorkItems)
          .set({
            status: "voided",
            voidReason: input.reason,
            resolvedBy: ctx.user.id,
            resolvedAt: occurredAt,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(visitWorkItems.practiceId, ctx.practiceId),
              eq(visitWorkItems.labResultId, source.id),
              eq(visitWorkItems.status, "unresolved"),
              isNull(visitWorkItems.invoiceId),
              isNull(visitWorkItems.invoiceItemId),
              isNull(visitWorkItems.deletedAt),
            ),
          );
        return created;
      });
    }),

  createLabResult: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(createLabResultInput)
    .mutation(async ({ ctx, input }) => {
      if (input.replacesLabResultId && ctx.user.role === "technician") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "A veterinarian or administrator must create a replacement lab result.",
        });
      }
      const creationPayloadHash = labOperationHash({
        kind: "create",
        patientId: input.patientId,
        appointmentId: input.appointmentId ?? null,
        testName: input.testName,
        resultValue: input.resultValue ?? null,
        unit: input.unit ?? null,
        referenceRangeLow: input.referenceRangeLow ?? null,
        referenceRangeHigh: input.referenceRangeHigh ?? null,
        status: input.status,
        resultFlag: input.resultFlag,
        replacesLabResultId: input.replacesLabResultId ?? null,
      });
      const operation = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        if (input.replacesLabResultId) {
          await lockLabResultSource(txCtx, input.replacesLabResultId);
        }
        const existingReplay = await tx
          .select(getTableColumns(labResults))
          .from(labResults)
          .where(
            and(
              eq(labResults.practiceId, ctx.practiceId),
              eq(labResults.creationOperationId, input.operationId),
            ),
          )
          .limit(1);
        if (existingReplay[0]) {
          if (existingReplay[0].creationPayloadHash !== creationPayloadHash) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "This lab creation id was already used for different result data.",
            });
          }
          if (input.replacesLabResultId) {
            await assertLabReplacementReplay(txCtx, {
              sourceLabResultId: input.replacesLabResultId,
              replacementLabResultId: existingReplay[0].id,
              operationId: input.operationId,
              payloadHash: creationPayloadHash,
            });
          }
          return { result: existingReplay[0], replayed: true as const };
        }
        await assertPatientBelongsToPractice(txCtx, input.patientId);
        let replacementCorrectionId: string | null = null;
        let shouldRegisterVisitWork = Boolean(input.appointmentId);
        if (input.replacesLabResultId) {
          const [source] = await tx
            .select({
              id: labResults.id,
              correctionId: clinicalRecordCorrections.id,
            })
            .from(labResults)
            .innerJoin(
              clinicalRecordCorrections,
              and(
                eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
                eq(clinicalRecordCorrections.labResultId, labResults.id),
              ),
            )
            .where(
              and(
                eq(labResults.id, input.replacesLabResultId),
                eq(labResults.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(labResults.deletedAt),
              ),
            )
            .limit(1)
            .for("share", { of: labResults });
          if (!source) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "A replacement must point to an entered-in-error result in this patient chart.",
            });
          }
          replacementCorrectionId = source.correctionId;

          const [existingReplacement] = await tx
            .select({ id: labResults.id })
            .from(labResultReplacements)
            .innerJoin(
              labResults,
              and(
                eq(labResults.id, labResultReplacements.replacementLabResultId),
                eq(labResults.practiceId, ctx.practiceId),
              ),
            )
            .where(
              and(
                eq(labResultReplacements.practiceId, ctx.practiceId),
                eq(labResultReplacements.sourceLabResultId, source.id),
                isNull(labResults.deletedAt),
              ),
            )
            .limit(1);
          if (existingReplacement) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This entered-in-error result already has a replacement. Refresh the chart.",
            });
          }
          const [sourceWork] = await tx
            .select({ status: visitWorkItems.status })
            .from(visitWorkItems)
            .where(
              and(
                eq(visitWorkItems.practiceId, ctx.practiceId),
                eq(visitWorkItems.labResultId, source.id),
                isNull(visitWorkItems.deletedAt),
              ),
            )
            .limit(1);
          if (
            sourceWork?.status === "charged" ||
            sourceWork?.status === "no_charge"
          ) {
            shouldRegisterVisitWork = false;
          }
        }
        if (input.appointmentId) {
          if (input.replacesLabResultId) {
            const [replacementAppointment] = await tx
              .select({ status: appointments.status })
              .from(appointments)
              .where(
                and(
                  eq(appointments.id, input.appointmentId),
                  eq(appointments.patientId, input.patientId),
                  eq(appointments.practiceId, ctx.practiceId),
                  activePracticePredicate(ctx.practiceId),
                  isNull(appointments.deletedAt),
                ),
              )
              .limit(1)
              .for("update", { of: appointments });
            if (!replacementAppointment) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "Appointment not found",
              });
            }
            shouldRegisterVisitWork =
              shouldRegisterVisitWork &&
              (replacementAppointment.status === "checked_in" ||
                replacementAppointment.status === "in_exam");
          } else {
            await lockOpenAppointmentForClinicalWork(
              txCtx,
              input.appointmentId,
              input.patientId,
              "lab work",
            );
          }
        }
        const occurredAt = new Date();
        const {
          operationId,
          replacesLabResultId: _replacementIntent,
          ...resultInput
        } = input;
        const [created] = await tx
          .insert(labResults)
          .values({
            ...resultInput,
            completedAt: input.status === "completed" ? occurredAt : null,
            orderedBy: ctx.user.id,
            practiceId: ctx.practiceId,
            creationOperationId: operationId,
            creationPayloadHash,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          const [replay] = await tx
            .select(getTableColumns(labResults))
            .from(labResults)
            .where(
              and(
                eq(labResults.practiceId, ctx.practiceId),
                eq(labResults.creationOperationId, operationId),
              ),
            )
            .limit(1);
          if (!replay || replay.creationPayloadHash !== creationPayloadHash) {
            throw new TRPCError({
              code: "CONFLICT",
              message: input.replacesLabResultId
                ? "This entered-in-error result already has a replacement, or this creation id conflicts. Refresh the chart."
                : "This lab creation id conflicts with different result data.",
            });
          }
          if (input.replacesLabResultId) {
            await assertLabReplacementReplay(txCtx, {
              sourceLabResultId: input.replacesLabResultId,
              replacementLabResultId: replay.id,
              operationId: input.operationId,
              payloadHash: creationPayloadHash,
            });
          }
          return { result: replay, replayed: true as const };
        }
        await tx.insert(labResultEvents).values({
          practiceId: ctx.practiceId,
          labResultId: created.id,
          patientId: created.patientId,
          appointmentId: created.appointmentId,
          eventType: "created",
          createdAt: created.createdAt,
          statusBefore: null,
          statusAfter: created.status,
          resultValue: created.resultValue,
          unit: created.unit,
          referenceRangeLow: created.referenceRangeLow,
          referenceRangeHigh: created.referenceRangeHigh,
          resultFlag: created.resultFlag,
          followUpStatus: created.followUpStatus,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          note: created.status === "completed" ? "Result values available at entry." : null,
          operationId,
          operationPayloadHash: creationPayloadHash,
        });
        if (input.replacesLabResultId && replacementCorrectionId) {
          await tx.insert(labResultReplacements).values({
            practiceId: ctx.practiceId,
            correctionId: replacementCorrectionId,
            sourceLabResultId: input.replacesLabResultId,
            replacementLabResultId: created.id,
            actorId: ctx.user.id,
            actorName: ctx.user.name,
            operationId,
            operationPayloadHash: creationPayloadHash,
          });
        }
        if (created?.appointmentId && shouldRegisterVisitWork) {
          await registerVisitWorkItem(txCtx, created.appointmentId, {
            labResultId: created.id,
          });
        }
        return { result: created, replayed: false as const };
      });
      if (!operation.replayed) {
        await dispatchWebhookEvent(ctx.practiceId, "lab_result.created", {
          id: operation.result.id,
          patientId: operation.result.patientId,
          testName: operation.result.testName,
          status: operation.result.status,
          orderedBy: operation.result.orderedBy,
          source: "dashboard",
        });
      }
      return operation.result;
    }),

  updateLabResultStatus: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.literal("reviewed"),
        operationId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.status === "reviewed" && ctx.user.role === "technician") {
        throw new TRPCError({ code: "FORBIDDEN", message: "A veterinarian or administrator must review lab results." });
      }
      const payloadHash = labOperationHash({
        kind: "review",
        id: input.id,
        status: input.status,
      });
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        await lockLabResultSource(txCtx, input.id);
        const replay = await getLabOperationReplay(txCtx, input.operationId, {
          resultId: input.id,
          eventTypes: ["reviewed"],
          payloadHash,
        });
        if (replay) return replay;
        const existing = await getLabStatusForUpdate(txCtx, input.id);
        assertLabStatusTransition(existing.status, input.status);
        if (!existing.resultValue?.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A lab result cannot be reviewed without recorded values." });
        }
        if (
          existing.resultFlag === "critical" &&
          existing.followUpStatus === "not_required"
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Assign owned follow-up for this critical result before recording clinical review.",
          });
        }
        const occurredAt = new Date();
        const [updated] = await tx
          .update(labResults)
          .set({
            status: input.status,
            reviewedBy: ctx.user.id,
            reviewedAt: occurredAt,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(labResults.id, input.id),
              eq(labResults.practiceId, ctx.practiceId),
              eq(labResults.status, existing.status),
              activePracticePredicate(ctx.practiceId),
              activeLabResultPredicate(ctx.practiceId),
              isNull(labResults.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Lab result changed while updating. Refresh and try again.",
          });
        }
        await tx.insert(labResultEvents).values({
          practiceId: ctx.practiceId,
          labResultId: updated.id,
          patientId: updated.patientId,
          appointmentId: updated.appointmentId,
          eventType: "reviewed",
          createdAt: occurredAt,
          statusBefore: existing.status,
          statusAfter: updated.status,
          resultValue: updated.resultValue,
          unit: updated.unit,
          referenceRangeLow: updated.referenceRangeLow,
          referenceRangeHigh: updated.referenceRangeHigh,
          resultFlag: updated.resultFlag,
          followUpStatus: updated.followUpStatus,
          followUpAssignedTo: updated.followUpAssignedTo,
          followUpDueAt: updated.followUpDueAt,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          operationId: input.operationId,
          operationPayloadHash: payloadHash,
        });
        return updated;
      });
      return result;
    }),

  completeLabResult: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(
      z
        .object({
          id: z.string().uuid(),
          resultValue: clinicalTextInput("Result value", LAB_RESULT_VALUE_MAX_LENGTH),
          unit: optionalClinicalTextInput("Unit", LAB_UNIT_MAX_LENGTH),
          referenceRangeLow: labReferenceInput("Reference range low").optional(),
          referenceRangeHigh: labReferenceInput("Reference range high").optional(),
          resultFlag: z.enum(labResultFlagValues).default("unknown"),
          operationId: z.string().uuid(),
        })
        .superRefine((input, refineCtx) => {
          if (!isOrderedLabReferenceRange(input.referenceRangeLow, input.referenceRangeHigh)) {
            refineCtx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["referenceRangeHigh"],
              message: "Reference range high must be greater than or equal to low.",
            });
          }
        })
    )
    .mutation(async ({ ctx, input }) => {
      const payloadHash = labOperationHash({
        kind: "complete",
        id: input.id,
        resultValue: input.resultValue,
        unit: input.unit ?? null,
        referenceRangeLow: input.referenceRangeLow ?? null,
        referenceRangeHigh: input.referenceRangeHigh ?? null,
        resultFlag: input.resultFlag,
      });
      return ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        await lockLabResultSource(txCtx, input.id);
        const replay = await getLabOperationReplay(txCtx, input.operationId, {
          resultId: input.id,
          eventTypes: ["completed"],
          payloadHash,
        });
        if (replay) return replay;
        const existing = await getLabStatusForUpdate(txCtx, input.id);
        if (existing.status !== "pending") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Only pending lab results can be completed with new values." });
        }
        if (
          input.resultFlag === "critical" &&
          existing.followUpStatus === "open" &&
          !existing.followUpDueAt
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Set a due date on the open follow-up before recording this result as critical.",
          });
        }
        const occurredAt = new Date();
        const [updated] = await tx
          .update(labResults)
          .set({
            resultValue: input.resultValue,
            unit: input.unit ?? null,
            referenceRangeLow: input.referenceRangeLow ?? null,
            referenceRangeHigh: input.referenceRangeHigh ?? null,
            resultFlag: input.resultFlag,
            status: "completed",
            completedAt: occurredAt,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(labResults.id, input.id),
              eq(labResults.practiceId, ctx.practiceId),
              eq(labResults.status, "pending"),
              activePracticePredicate(ctx.practiceId),
              activeLabResultPredicate(ctx.practiceId),
              isNull(labResults.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Lab result changed while completing. Refresh and try again." });
        }
        await tx.insert(labResultEvents).values({
          practiceId: ctx.practiceId,
          labResultId: updated.id,
          patientId: updated.patientId,
          appointmentId: updated.appointmentId,
          eventType: "completed",
          createdAt: occurredAt,
          statusBefore: "pending",
          statusAfter: "completed",
          resultValue: updated.resultValue,
          unit: updated.unit,
          referenceRangeLow: updated.referenceRangeLow,
          referenceRangeHigh: updated.referenceRangeHigh,
          resultFlag: updated.resultFlag,
          followUpStatus: updated.followUpStatus,
          followUpAssignedTo: updated.followUpAssignedTo,
          followUpDueAt: updated.followUpDueAt,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          operationId: input.operationId,
          operationPayloadHash: payloadHash,
        });
        return updated;
      });
    }),

  assignLabFollowUp: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician"))
    .input(
      z.object({
        id: z.string().uuid(),
        assigneeId: z.string().uuid(),
        dueAt: z.string().datetime().optional(),
        note: z.string().trim().max(1000).optional(),
        operationId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const dueAt = input.dueAt ? new Date(input.dueAt).toISOString() : null;
      const note = input.note?.trim() || null;
      const payloadHash = labOperationHash({
        kind: "assign_follow_up",
        id: input.id,
        assigneeId: input.assigneeId,
        dueAt,
        note,
      });
      return ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        await lockLabResultSource(txCtx, input.id);
        const replay = await getLabOperationReplay(txCtx, input.operationId, {
          resultId: input.id,
          eventTypes: ["follow_up_assigned", "follow_up_reassigned"],
          payloadHash,
        });
        if (replay) return replay;
        const existing = await getLabStatusForUpdate(txCtx, input.id);
        if (existing.status === "pending") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Enter and complete the lab values before assigning follow-up.",
          });
        }
        const [assignee] = await tx
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(
            and(
              eq(users.id, input.assigneeId),
              eq(users.practiceId, ctx.practiceId),
              ne(users.role, "viewer"),
              isNull(users.deletedAt)
            )
          )
          .limit(1);
        if (!assignee) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an active clinic teammate." });
        }
        if (existing.resultFlag === "critical" && !dueAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Critical-result follow-up requires a due date and time.",
          });
        }
        if (assignee.role === "front_desk" && !note) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Front desk follow-up requires actionable instructions from the clinical team.",
          });
        }
        const occurredAt = new Date();
        const [updated] = await tx
          .update(labResults)
          .set({
            followUpStatus: "open",
            followUpAssignedTo: input.assigneeId,
            followUpDueAt: dueAt ? new Date(dueAt) : null,
            followUpNote: note,
            followUpCompletedBy: null,
            followUpCompletedAt: null,
            followUpOutcome: null,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(labResults.id, input.id),
              eq(labResults.practiceId, ctx.practiceId),
              eq(labResults.status, existing.status),
              eq(labResults.followUpStatus, existing.followUpStatus),
              sql`${labResults.followUpAssignedTo} is not distinct from ${existing.followUpAssignedTo}::uuid`,
              activePracticePredicate(ctx.practiceId),
              activeLabResultPredicate(ctx.practiceId),
              isNull(labResults.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Lab result changed while assigning follow-up. Refresh and try again." });
        }
        await tx.insert(labResultEvents).values({
          practiceId: ctx.practiceId,
          labResultId: updated.id,
          patientId: updated.patientId,
          appointmentId: updated.appointmentId,
          eventType: existing.followUpStatus === "not_required" ? "follow_up_assigned" : "follow_up_reassigned",
          createdAt: occurredAt,
          statusBefore: updated.status,
          statusAfter: updated.status,
          resultValue: updated.resultValue,
          unit: updated.unit,
          referenceRangeLow: updated.referenceRangeLow,
          referenceRangeHigh: updated.referenceRangeHigh,
          resultFlag: updated.resultFlag,
          followUpStatus: "open",
          followUpAssignedTo: input.assigneeId,
          followUpDueAt: dueAt ? new Date(dueAt) : null,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          note,
          operationId: input.operationId,
          operationPayloadHash: payloadHash,
        });
        return updated;
      });
    }),

  completeLabFollowUp: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        outcome: z.string().trim().min(3).max(1000),
        operationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const payloadHash = labOperationHash({
        kind: "complete_follow_up",
        id: input.id,
        outcome: input.outcome,
      });
      const result = await ctx.db.transaction(async (tx) => {
        const txCtx: RecordsContext = { db: tx, practiceId: ctx.practiceId };
        await lockLabOperation(txCtx, input.operationId);
        await lockLabResultSource(txCtx, input.id);
        const replay = await getLabOperationReplay(txCtx, input.operationId, {
          resultId: input.id,
          eventTypes: ["follow_up_completed"],
          payloadHash,
        });
        if (replay) return replay;
        const existing = await getLabStatusForUpdate(txCtx, input.id);
        if (existing.status === "pending") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Lab follow-up cannot be completed before result values are available.",
          });
        }
        if (existing.followUpStatus !== "open" || !existing.followUpAssignedTo) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This lab result has no open follow-up." });
        }
        if (
          ctx.user.role === "front_desk" &&
          existing.followUpAssignedTo !== ctx.user.id
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Front desk staff can complete only lab follow-up assigned to them.",
          });
        }
        const occurredAt = new Date();
        const [updated] = await tx
          .update(labResults)
          .set({
            followUpStatus: "completed",
            followUpCompletedBy: ctx.user.id,
            followUpCompletedAt: occurredAt,
            followUpOutcome: input.outcome,
            updatedAt: occurredAt,
          })
          .where(
            and(
              eq(labResults.id, input.id),
              eq(labResults.practiceId, ctx.practiceId),
              eq(labResults.followUpStatus, "open"),
              eq(labResults.followUpAssignedTo, existing.followUpAssignedTo),
              activePracticePredicate(ctx.practiceId),
              activeLabResultPredicate(ctx.practiceId),
              isNull(labResults.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Lab follow-up changed while completing. Refresh and try again." });
        }
        await tx.insert(labResultEvents).values({
          practiceId: ctx.practiceId,
          labResultId: updated.id,
          patientId: updated.patientId,
          appointmentId: updated.appointmentId,
          eventType: "follow_up_completed",
          createdAt: occurredAt,
          statusBefore: updated.status,
          statusAfter: updated.status,
          resultValue: updated.resultValue,
          unit: updated.unit,
          referenceRangeLow: updated.referenceRangeLow,
          referenceRangeHigh: updated.referenceRangeHigh,
          resultFlag: updated.resultFlag,
          followUpStatus: "completed",
          followUpAssignedTo: updated.followUpAssignedTo,
          followUpDueAt: updated.followUpDueAt,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          note: input.outcome,
          operationId: input.operationId,
          operationPayloadHash: payloadHash,
        });
        return updated;
      });
      return labMutationResultForRole(result, ctx.user.role);
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
            eq(users.practiceId, ctx.practiceId)
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
