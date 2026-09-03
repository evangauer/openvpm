import { z } from "zod";
import { eq, and, isNull, desc, getTableColumns, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  clinicalRecordCorrections,
  patients,
  practices,
  vitalSigns,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  clinicalDecimalInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  VITALS_BODY_CONDITION_MAX,
  VITALS_BODY_CONDITION_MIN,
  VITALS_CAPILLARY_REFILL_MAX_SEC,
  VITALS_CAPILLARY_REFILL_MIN_SEC,
  VITALS_CAPILLARY_REFILL_SCALE,
  VITALS_HEART_RATE_MAX_BPM,
  VITALS_HEART_RATE_MIN_BPM,
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
  VITALS_PAIN_SCORE_MAX,
  VITALS_PAIN_SCORE_MIN,
  VITALS_RESPIRATORY_RATE_MAX_BPM,
  VITALS_RESPIRATORY_RATE_MIN_BPM,
  VITALS_TEMPERATURE_MAX_C,
  VITALS_TEMPERATURE_MIN_C,
  VITALS_TEMPERATURE_SCALE,
  VITALS_WEIGHT_MAX_KG,
  VITALS_WEIGHT_SCALE,
} from "@/lib/records/vitals-policy";
import { lockOpenVisitForClinicalAppend } from "@/lib/records/visit-integrity";
import {
  CLINICAL_CORRECTION_REASON_MAX_LENGTH,
  CLINICAL_CORRECTION_REASON_MIN_LENGTH,
} from "@/lib/records/clinical-correction-policy";

const recordRole = requireRole("admin", "veterinarian", "technician");
const correctionRole = requireRole("admin", "veterinarian");
const temperatureInput = clinicalDecimalInput("Temperature", {
  min: VITALS_TEMPERATURE_MIN_C,
  max: VITALS_TEMPERATURE_MAX_C,
  scale: VITALS_TEMPERATURE_SCALE,
});
const weightInput = clinicalDecimalInput("Weight", {
  positive: true,
  max: VITALS_WEIGHT_MAX_KG,
  scale: VITALS_WEIGHT_SCALE,
});
const capillaryRefillInput = clinicalDecimalInput("Capillary refill", {
  min: VITALS_CAPILLARY_REFILL_MIN_SEC,
  max: VITALS_CAPILLARY_REFILL_MAX_SEC,
  scale: VITALS_CAPILLARY_REFILL_SCALE,
});
export {
  VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
  VITALS_NOTES_MAX_LENGTH,
} from "@/lib/records/vitals-policy";

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function assertPatientBelongsToPractice(
  db: Database,
  practiceId: string,
  patientId: string,
) {
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }
}

async function assertAppointmentBelongsToPatient(
  db: Database,
  practiceId: string,
  appointmentId: string,
  patientId: string,
) {
  const visit = await lockOpenVisitForClinicalAppend(db, {
    practiceId,
    appointmentId,
    patientId,
  });
  if (!visit.ok && visit.reason === "appointment_not_found") {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Appointment not found",
    });
  }
  if (!visit.ok) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Vitals can only be added while the visit is in exam.",
    });
  }
}

export const vitalsRouter = createRouter({
  /** Vital-sign history for a patient, newest first. */
  listByPatient: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          ...getTableColumns(vitalSigns),
          correctionId: clinicalRecordCorrections.id,
          correctionAction: clinicalRecordCorrections.action,
          correctionReason: clinicalRecordCorrections.reason,
          correctedAt: clinicalRecordCorrections.createdAt,
          correctedBy: clinicalRecordCorrections.correctedBy,
          correctedByName: clinicalRecordCorrections.correctedByName,
        })
        .from(vitalSigns)
        .leftJoin(
          clinicalRecordCorrections,
          and(
            eq(clinicalRecordCorrections.vitalSignId, vitalSigns.id),
            eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
          ),
        )
        .where(
          and(
            eq(vitalSigns.patientId, input.patientId),
            eq(vitalSigns.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(vitalSigns.deletedAt),
          ),
        )
        .orderBy(desc(vitalSigns.recordedAt))
        .limit(input.limit);
    }),

  /** Appointment-owned vital signs remain readable after visit closeout. */
  listByAppointment: protectedProcedure
    .input(
      z.object({
        appointmentId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          ...getTableColumns(vitalSigns),
          correctionId: clinicalRecordCorrections.id,
          correctionAction: clinicalRecordCorrections.action,
          correctionReason: clinicalRecordCorrections.reason,
          correctedAt: clinicalRecordCorrections.createdAt,
          correctedBy: clinicalRecordCorrections.correctedBy,
          correctedByName: clinicalRecordCorrections.correctedByName,
        })
        .from(vitalSigns)
        .leftJoin(
          clinicalRecordCorrections,
          and(
            eq(clinicalRecordCorrections.vitalSignId, vitalSigns.id),
            eq(clinicalRecordCorrections.practiceId, ctx.practiceId),
          ),
        )
        .where(
          and(
            eq(vitalSigns.appointmentId, input.appointmentId),
            eq(vitalSigns.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(vitalSigns.deletedAt),
          ),
        )
        .orderBy(desc(vitalSigns.recordedAt))
        .limit(input.limit);
    }),

  markEnteredInError: protectedProcedure
    .use(correctionRole)
    .input(
      z.object({
        patientId: z.string().uuid(),
        recordId: z.string().uuid(),
        reason: z
          .string()
          .trim()
          .min(CLINICAL_CORRECTION_REASON_MIN_LENGTH)
          .max(CLINICAL_CORRECTION_REASON_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        const [source] = await tx
          .select({
            id: vitalSigns.id,
            patientId: vitalSigns.patientId,
            appointmentId: vitalSigns.appointmentId,
          })
          .from(vitalSigns)
          .where(
            and(
              eq(vitalSigns.id, input.recordId),
              eq(vitalSigns.patientId, input.patientId),
              eq(vitalSigns.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(vitalSigns.deletedAt),
            ),
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
            recordType: "vital_sign",
            action: "entered_in_error",
            vitalSignId: source.id,
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
              eq(clinicalRecordCorrections.vitalSignId, source.id),
            ),
          )
          .limit(1);
        if (existing) return existing;

        throw new TRPCError({
          code: "CONFLICT",
          message: "Clinical correction changed; refresh and retry.",
        });
      }),
    ),

  record: protectedProcedure
    .use(recordRole)
    .input(
      z
        .object({
          patientId: z.string().uuid(),
          appointmentId: z.string().uuid().optional(),
          // Numerics travel as strings into Drizzle numeric columns.
          temperatureC: temperatureInput.optional(),
          heartRateBpm: z
            .number()
            .int()
            .min(VITALS_HEART_RATE_MIN_BPM)
            .max(VITALS_HEART_RATE_MAX_BPM)
            .optional(),
          respiratoryRateBpm: z
            .number()
            .int()
            .min(VITALS_RESPIRATORY_RATE_MIN_BPM)
            .max(VITALS_RESPIRATORY_RATE_MAX_BPM)
            .optional(),
          weightKg: weightInput.optional(),
          bodyConditionScore: z
            .number()
            .int()
            .min(VITALS_BODY_CONDITION_MIN)
            .max(VITALS_BODY_CONDITION_MAX)
            .optional(),
          bodyConditionScale: z.union([z.literal(5), z.literal(9)]).default(9),
          painScore: z
            .number()
            .int()
            .min(VITALS_PAIN_SCORE_MIN)
            .max(VITALS_PAIN_SCORE_MAX)
            .optional(),
          mucousMembrane: optionalClinicalTextInput(
            "Mucous membrane",
            VITALS_MUCOUS_MEMBRANE_MAX_LENGTH,
          ),
          capillaryRefillSec: capillaryRefillInput.optional(),
          notes: optionalClinicalTextInput(
            "Vitals notes",
            VITALS_NOTES_MAX_LENGTH,
          ),
        })
        .superRefine((input, ctx) => {
          const hasMeasurement = [
            input.temperatureC,
            input.heartRateBpm,
            input.respiratoryRateBpm,
            input.weightKg,
            input.bodyConditionScore,
            input.painScore,
            input.capillaryRefillSec,
          ].some((value) => value !== undefined);
          if (
            !hasMeasurement &&
            !input.mucousMembrane?.trim() &&
            !input.notes?.trim()
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "At least one vital measurement or note is required.",
            });
          }
          if (
            input.bodyConditionScore !== undefined &&
            input.bodyConditionScore > input.bodyConditionScale
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["bodyConditionScore"],
              message: `Body condition score must be on the 1–${input.bodyConditionScale} scale.`,
            });
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        await assertPatientBelongsToPractice(
          txDb,
          ctx.practiceId,
          input.patientId,
        );
        if (input.appointmentId) {
          await assertAppointmentBelongsToPatient(
            txDb,
            ctx.practiceId,
            input.appointmentId,
            input.patientId,
          );
        }
        const { temperatureC, weightKg, capillaryRefillSec, ...rest } = input;
        const [row] = await tx
          .insert(vitalSigns)
          .values({
            ...rest,
            practiceId: ctx.practiceId,
            recordedBy: ctx.user.id,
            temperatureC: temperatureC?.toString(),
            weightKg: weightKg?.toString(),
            capillaryRefillSec: capillaryRefillSec?.toString(),
          })
          .returning();
        return row!;
      });
    }),
});
