import { z } from "zod";
import { eq, and, isNull, ilike, or, sql, desc, ne, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  patients,
  patientWeights,
  patientAllergies,
  clients,
  appointments,
  appointmentWaitlist,
  soapNotes,
  vaccinationRecords,
  labResults,
  procedures,
  clinicalNotes,
  problemList,
  vitalSigns,
  cases,
  treatmentPlans,
  prescriptions,
  invoices,
  controlledSubstanceLog,
  insurancePolicies,
  wellnessEnrollments,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { alias } from "drizzle-orm/pg-core";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import {
  clinicalDateInput,
  clinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  PATIENT_WEIGHT_ERROR_MESSAGE,
  isPatientWeightInputValid,
} from "@/lib/records/patient-weight-policy";
import {
  PATIENT_BREED_MAX_LENGTH,
  PATIENT_COLOR_MAX_LENGTH,
  PATIENT_MICROCHIP_NUMBER_MAX_LENGTH,
  PATIENT_NAME_MAX_LENGTH,
  PATIENT_PHOTO_URL_MAX_LENGTH,
  PATIENT_SEARCH_MAX_LENGTH,
} from "@/lib/patients/policy";
import { listOffsetInput } from "./pagination";

const patientSpeciesInput = z.enum([
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "other",
]);
const patientSexInput = z.enum([
  "male",
  "female",
  "male_neutered",
  "female_spayed",
]);
const patientStatusInput = z.enum(["active", "inactive", "deceased"]);
const activeAppointmentStatuses = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
] as const;
const patientManagerProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk")
);
const patientDobInput = clinicalDateInput("Date of birth").optional();
const patientDobUpdateInput = clinicalDateInput("Date of birth")
  .nullable()
  .optional();
const patientSearchInput = z
  .string()
  .trim()
  .max(PATIENT_SEARCH_MAX_LENGTH)
  .optional();
const patientSearchQueryInput = clinicalTextInput(
  "Search query",
  PATIENT_SEARCH_MAX_LENGTH
);
const patientNameInput = clinicalTextInput(
  "Patient name",
  PATIENT_NAME_MAX_LENGTH
);
const optionalPatientString = (label: string, maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} must be at most ${maxLength} characters.`)
    .optional()
    .transform((value) => value || undefined);
const patientMutableInput = {
  name: patientNameInput,
  species: patientSpeciesInput,
  breed: optionalPatientString("Breed", PATIENT_BREED_MAX_LENGTH),
  sex: patientSexInput.optional(),
  dob: patientDobInput,
  color: optionalPatientString("Color", PATIENT_COLOR_MAX_LENGTH),
  microchipNumber: optionalPatientString(
    "Microchip number",
    PATIENT_MICROCHIP_NUMBER_MAX_LENGTH
  ),
};
const patientWeightInput = z
  .string()
  .trim()
  .refine(isPatientWeightInputValid, PATIENT_WEIGHT_ERROR_MESSAGE);
const patientAllergyInput = z.object({
  patientId: z.string().uuid(),
  allergen: clinicalTextInput("Allergen", 255),
  reaction: optionalPatientString("Reaction", 2000),
  severity: z.enum(["mild", "moderate", "severe"]).default("moderate"),
});
type PatientsContext = {
  db: Pick<Database, "select">;
  practiceId: string;
};

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function assertActivePractice(ctx: PatientsContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
}

async function assertClientBelongsToPractice(
  db: Database,
  practiceId: string,
  clientId: string
) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);

  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }
}

async function assertPatientBelongsToPractice(
  db: Database,
  practiceId: string,
  patientId: string
) {
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }
}

export const patientsRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        search: patientSearchInput,
        species: patientSpeciesInput.optional(),
        status: patientStatusInput.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: listOffsetInput,
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions: ReturnType<typeof eq>[] = [
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt),
      ];

      if (input.search) {
        conditions.push(
          or(
            ilike(patients.name, `%${input.search}%`),
            ilike(patients.breed, `%${input.search}%`)
          )!
        );
      }
      if (input.species) {
        conditions.push(eq(patients.species, input.species));
      }
      if (input.status) {
        conditions.push(eq(patients.status, input.status));
      }

      const [items, countResult] = await Promise.all([
        ctx.db
          .select({
            id: patients.id,
            name: patients.name,
            species: patients.species,
            breed: patients.breed,
            sex: patients.sex,
            dob: patients.dob,
            status: patients.status,
            photoUrl: patients.photoUrl,
            clientId: patients.clientId,
            clientFirstName: clients.firstName,
            clientLastName: clients.lastName,
            createdAt: patients.createdAt,
          })
          .from(patients)
          .leftJoin(
            clients,
            and(
              eq(patients.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
              isNull(clients.deletedAt)
            )
          )
          .where(and(...conditions))
          .orderBy(desc(patients.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(patients)
          .where(and(...conditions)),
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  search: protectedProcedure
    .input(z.object({ query: patientSearchQueryInput }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
        })
        .from(patients)
        .leftJoin(
          clients,
          and(
            eq(patients.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
            or(
              ilike(patients.name, `%${input.query}%`),
              ilike(patients.breed, `%${input.query}%`)
            )
          )
        )
        .limit(10);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [patient] = await ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          sex: patients.sex,
          dob: patients.dob,
          color: patients.color,
          microchipNumber: patients.microchipNumber,
          photoUrl: patients.photoUrl,
          status: patients.status,
          clientId: patients.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          practiceId: patients.practiceId,
          createdAt: patients.createdAt,
        })
        .from(patients)
        .leftJoin(
          clients,
          and(
            eq(patients.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .where(
          and(
            eq(patients.id, input.id),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!patient) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
      }

      const [weights, allergies] = await Promise.all([
        ctx.db
          .select()
          .from(patientWeights)
          .where(
            and(
              eq(patientWeights.patientId, input.id),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientWeights.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId),
              isNull(patientWeights.deletedAt)
            )
          )
          .orderBy(desc(patientWeights.recordedAt)),
        ctx.db
          .select()
          .from(patientAllergies)
          .where(
            and(
              eq(patientAllergies.patientId, input.id),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientAllergies.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId),
              isNull(patientAllergies.deletedAt)
            )
          ),
      ]);

      return { ...patient, weights, allergies };
    }),

  create: patientManagerProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        ...patientMutableInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertClientBelongsToPractice(ctx.db, ctx.practiceId, input.clientId);
      const [patient] = await ctx.db
        .insert(patients)
        .values({ ...input, practiceId: ctx.practiceId })
        .returning();
      await dispatchWebhookEvent(ctx.practiceId, "patient.created", {
        id: patient!.id,
        clientId: patient!.clientId,
        name: patient!.name,
        species: patient!.species,
        breed: patient!.breed,
        sex: patient!.sex,
        status: patient!.status,
        source: "dashboard",
      });
      return patient!;
    }),

  update: patientManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: patientMutableInput.name.optional(),
        species: patientMutableInput.species.optional(),
        breed: patientMutableInput.breed,
        sex: patientMutableInput.sex,
        dob: patientDobUpdateInput,
        color: patientMutableInput.color,
        microchipNumber: patientMutableInput.microchipNumber,
        status: patientStatusInput.optional(),
        photoUrl: optionalPatientString(
          "Photo URL",
          PATIENT_PHOTO_URL_MAX_LENGTH
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [patient] = await ctx.db
        .update(patients)
        .set(data)
        .where(
          and(
            eq(patients.id, id),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .returning();
      if (!patient) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
      }
      return patient;
    }),

  delete: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [existingPatient] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.id, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt)
            )
          )
          .limit(1);

        if (!existingPatient) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.patientId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeAppointmentStatuses)
            )
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a patient with active appointments. Cancel or complete the appointments first.",
          });
        }

        const [waitingEntry] = await tx
          .select({ id: appointmentWaitlist.id })
          .from(appointmentWaitlist)
          .where(
            and(
              eq(appointmentWaitlist.patientId, input.id),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(appointmentWaitlist.status, "waiting"),
              isNull(appointmentWaitlist.deletedAt)
            )
          )
          .limit(1);

        if (waitingEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a patient with a waiting appointment request. Resolve the waitlist entry first.",
          });
        }

        const [patient] = await tx
          .update(patients)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(patients.id, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt)
            )
          )
          .returning({ id: patients.id });
        if (!patient) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
        }
      });
      return { success: true };
    }),

  addWeight: patientManagerProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        weightKg: patientWeightInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx.db, ctx.practiceId, input.patientId);
      const [weight] = await ctx.db
        .insert(patientWeights)
        .values({
          patientId: input.patientId,
          weightKg: input.weightKg,
          recordedBy: ctx.user.id,
        })
        .returning();
      return weight!;
    }),

  addAllergy: patientManagerProcedure
    .input(patientAllergyInput)
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx.db, ctx.practiceId, input.patientId);
      const [allergy] = await ctx.db
        .insert(patientAllergies)
        .values({
          ...input,
          notedBy: ctx.user.id,
        })
        .returning();
      return allergy!;
    }),

  /**
   * Soft delete: the row keeps its history (the Rx safety log may reference
   * it) but stops feeding the alert bar, prescription checks, and portal.
   */
  removeAllergy: patientManagerProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPatientBelongsToPractice(ctx.db, ctx.practiceId, input.patientId);
      const [removed] = await ctx.db
        .update(patientAllergies)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(patientAllergies.id, input.id),
            eq(patientAllergies.patientId, input.patientId),
            isNull(patientAllergies.deletedAt)
          )
        )
        .returning({ id: patientAllergies.id });
      if (!removed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Allergy not found" });
      }
      return { ok: true };
    }),

  merge: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        keepId: z.string().uuid(),
        mergeId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.keepId === input.mergeId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot merge a patient into itself.",
        });
      }

      // Verify both patients exist in the practice
      const [keepPatient] = await ctx.db
        .select({ id: patients.id, clientId: patients.clientId })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.keepId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!keepPatient) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The patient to keep was not found.",
        });
      }

      const [mergePatient] = await ctx.db
        .select({ id: patients.id, clientId: patients.clientId })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.mergeId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!mergePatient) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The patient to merge was not found.",
        });
      }

      if (keepPatient.clientId !== mergePatient.clientId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Patients must belong to the same client to merge.",
        });
      }

      await ctx.db.transaction(async (tx) => {
        // Re-point all records from mergeId to keepId
        await Promise.all([
          tx
          .update(appointments)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(appointments.patientId, input.mergeId),
              eq(appointments.clientId, keepPatient.clientId),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(appointmentWaitlist)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(appointmentWaitlist.patientId, input.mergeId),
              eq(appointmentWaitlist.clientId, keepPatient.clientId),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(soapNotes)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(soapNotes.patientId, input.mergeId),
              eq(soapNotes.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(vaccinationRecords)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(vaccinationRecords.patientId, input.mergeId),
              eq(vaccinationRecords.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(labResults)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(labResults.patientId, input.mergeId),
              eq(labResults.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(procedures)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(procedures.patientId, input.mergeId),
              eq(procedures.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(clinicalNotes)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(clinicalNotes.patientId, input.mergeId),
              eq(clinicalNotes.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(problemList)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(problemList.patientId, input.mergeId),
              eq(problemList.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(vitalSigns)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(vitalSigns.patientId, input.mergeId),
              eq(vitalSigns.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(cases)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(cases.patientId, input.mergeId),
              eq(cases.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(treatmentPlans)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(treatmentPlans.patientId, input.mergeId),
              eq(treatmentPlans.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(prescriptions)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(prescriptions.patientId, input.mergeId),
              eq(prescriptions.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(controlledSubstanceLog)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(controlledSubstanceLog.patientId, input.mergeId),
              eq(controlledSubstanceLog.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(insurancePolicies)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(insurancePolicies.patientId, input.mergeId),
              eq(insurancePolicies.clientId, keepPatient.clientId),
              eq(insurancePolicies.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(wellnessEnrollments)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(wellnessEnrollments.patientId, input.mergeId),
              eq(wellnessEnrollments.clientId, keepPatient.clientId),
              eq(wellnessEnrollments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(patientWeights)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(patientWeights.patientId, input.mergeId),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientWeights.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(patientAllergies)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(patientAllergies.patientId, input.mergeId),
              sql`exists (
                select 1
                from ${patients}
                where ${patients.id} = ${patientAllergies.patientId}
                  and ${patients.practiceId} = ${ctx.practiceId}
                  and ${patients.deletedAt} is null
              )`,
              activePracticePredicate(ctx.practiceId)
            )
          ),
          tx
          .update(invoices)
          .set({ patientId: input.keepId })
          .where(
            and(
              eq(invoices.patientId, input.mergeId),
              eq(invoices.clientId, keepPatient.clientId),
              eq(invoices.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          ),
        ]);

        // Soft-delete the merged patient
        await tx
        .update(patients)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(patients.id, input.mergeId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        );
      });

      // Return the kept patient
      const [kept] = await ctx.db
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.id, input.keepId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!kept) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Practice not found",
        });
      }

      return kept!;
    }),

  findDuplicates: protectedProcedure
    .query(async ({ ctx }) => {
      // Find patients with similar names within the practice.
      // Self-join patients table where names match via ILIKE and IDs differ.
      const p2 = alias(patients, "p2");

      const rows = await ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          clientId: patients.clientId,
          duplicateId: p2.id,
          duplicateName: p2.name,
          duplicateSpecies: p2.species,
          duplicateBreed: p2.breed,
          duplicateClientId: p2.clientId,
        })
        .from(patients)
        .innerJoin(
          p2,
          and(
            eq(patients.practiceId, p2.practiceId),
            ilike(patients.name, p2.name),
            ne(patients.id, p2.id),
            // Use id ordering to avoid returning both (A,B) and (B,A)
            sql`${patients.id} < ${p2.id}`
          )
        )
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
            isNull(p2.deletedAt)
          )
        )
        .orderBy(patients.name)
        .limit(100);

      // Group into sets of potential duplicates
      const groupMap = new Map<
        string,
        {
          name: string;
          patients: {
            id: string;
            name: string;
            species: string;
            breed: string | null;
            clientId: string;
          }[];
        }
      >();

      for (const row of rows) {
        const key = row.name.toLowerCase();
        if (!groupMap.has(key)) {
          groupMap.set(key, { name: row.name, patients: [] });
        }
        const group = groupMap.get(key)!;
        // Add both sides if not already present
        if (!group.patients.some((p) => p.id === row.id)) {
          group.patients.push({
            id: row.id,
            name: row.name,
            species: row.species,
            breed: row.breed,
            clientId: row.clientId,
          });
        }
        if (!group.patients.some((p) => p.id === row.duplicateId)) {
          group.patients.push({
            id: row.duplicateId,
            name: row.duplicateName,
            species: row.duplicateSpecies,
            breed: row.duplicateBreed,
            clientId: row.duplicateClientId,
          });
        }
      }

      return Array.from(groupMap.values());
    }),
});
