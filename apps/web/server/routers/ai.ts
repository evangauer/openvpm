import { z } from "zod";
import { eq, and, isNull, lt, gte, lte, sql, desc, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  soapNotes,
  vaccinationRecords,
  patients,
  clients,
  appointments,
  invoices,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  dateInputUtcRangeForTimeZone,
  formatDateInputForTimeZone,
} from "@/lib/date-input";
import {
  hasSoapContent,
  normalizeSoapSection,
  SOAP_SECTION_MAX_LENGTH,
} from "@/lib/records/soap-content";
import { optionalClinicalTextInput } from "@/lib/records/clinical-inputs";
import { AI_SOURCE_MAX_LENGTH } from "@/lib/ai/soap";

export { AI_SOURCE_MAX_LENGTH };

type AIContext = {
  db: Database;
  practiceId: string;
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: AIContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function practiceTimeZone(ctx: AIContext): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }

  return practice.timezone ?? null;
}

async function practiceDateInput(ctx: AIContext): Promise<string> {
  return formatDateInputForTimeZone(new Date(), await practiceTimeZone(ctx));
}

async function practiceDayRange(
  ctx: AIContext
): Promise<{ date: string; start: Date; end: Date }> {
  return dateInputUtcRangeForTimeZone(new Date(), await practiceTimeZone(ctx));
}

async function assertPatientBelongsToPractice(
  ctx: AIContext,
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
  ctx: AIContext,
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

export const aiRouter = createRouter({
  /**
   * AI SOAP Note Hook
   * External AI scribes (Scribenote, VetRec, HappyDoc) POST here
   * to auto-populate SOAP notes for a patient visit.
   */
  createSoapFromAI: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
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
        source: z
          .string()
          .trim()
          .min(1)
          .max(AI_SOURCE_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { source, ...noteData } = input;
      await assertActivePractice(ctx);
      await assertPatientBelongsToPractice(ctx, input.patientId);
      if (input.appointmentId) {
        await assertAppointmentBelongsToPatient(
          ctx,
          input.appointmentId,
          input.patientId
        );
      }
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
      const [note] = await ctx.db
        .insert(soapNotes)
        .values({
          patientId: noteData.patientId,
          appointmentId: noteData.appointmentId,
          ...normalizedNote,
          authorId: ctx.user.id,
          practiceId: ctx.practiceId,
        })
        .returning();
      return { ...note!, source };
    }),

  /**
   * Patients with overdue vaccinations
   * Returns patients whose most recent vaccination nextDueDate has passed.
   */
  patientsOverdueVaccinations: protectedProcedure.query(async ({ ctx }) => {
    const today = await practiceDateInput(ctx);

    const rows = await ctx.db
      .select({
        patientId: patients.id,
        patientName: patients.name,
        species: patients.species,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        vaccineName: vaccinationRecords.vaccineName,
        nextDueDate: vaccinationRecords.nextDueDate,
      })
      .from(vaccinationRecords)
      .innerJoin(
        patients,
        and(
          eq(vaccinationRecords.patientId, patients.id),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(vaccinationRecords.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(vaccinationRecords.deletedAt),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
          lt(vaccinationRecords.nextDueDate, today)
        )
      )
      .orderBy(vaccinationRecords.nextDueDate);

    return rows.map((r) => ({
      patientId: r.patientId,
      patientName: r.patientName,
      species: r.species,
      clientName: [r.clientFirstName, r.clientLastName]
        .filter(Boolean)
        .join(" "),
      vaccineName: r.vaccineName,
      nextDueDate: r.nextDueDate,
      daysOverdue: Math.floor(
        (Date.now() - new Date(r.nextDueDate!).getTime()) / 86_400_000
      ),
    }));
  }),

  /**
   * Patients needing follow-up
   * Appointments in the last 7 days with status "checked_out"
   * that have no future appointment for the same patient.
   */
  patientsNeedingFollowUp: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Get checked-out appointments from last 7 days
    const recentCheckedOut = await ctx.db
      .select({
        appointmentId: appointments.id,
        patientId: appointments.patientId,
        patientName: patients.name,
        species: patients.species,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        checkedOutAt: appointments.endTime,
      })
      .from(appointments)
      .innerJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.clientId, appointments.clientId),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
          eq(appointments.status, "checked_out"),
          gte(appointments.startTime, sevenDaysAgo),
          lte(appointments.startTime, now)
        )
      )
      .orderBy(desc(appointments.startTime));

    // For each patient, check if there is a future appointment
    const patientIds = [
      ...new Set(
        recentCheckedOut
          .map((a) => a.patientId)
          .filter((patientId): patientId is string => Boolean(patientId))
      ),
    ];

    if (patientIds.length === 0) return [];

    const futureAppointments = await ctx.db
      .select({
        patientId: appointments.patientId,
        count: sql<number>`count(*)`,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, now),
          inArray(appointments.patientId, patientIds)
        )
      )
      .groupBy(appointments.patientId);

    const patientsWithFuture = new Set(
      futureAppointments.map((r) => r.patientId)
    );

    return recentCheckedOut
      .filter((a) => a.patientId && !patientsWithFuture.has(a.patientId))
      .map((a) => ({
        appointmentId: a.appointmentId,
        patientId: a.patientId,
        patientName: a.patientName,
        species: a.species,
        clientName: [a.clientFirstName, a.clientLastName]
          .filter(Boolean)
          .join(" "),
        lastVisit: a.checkedOutAt,
      }));
  }),

  /**
   * Daily practice summary
   * Aggregate view of today's activity for AI dashboard assistants.
   */
  dailySummary: protectedProcedure.query(async ({ ctx }) => {
    const today = await practiceDayRange(ctx);

    const [
      appointmentsByStatus,
      soapNotesCreated,
      invoicesPaid,
    ] = await Promise.all([
      // Appointments by status
      ctx.db
        .select({
          status: appointments.status,
          count: sql<number>`count(*)`,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt),
            gte(appointments.startTime, today.start),
            lt(appointments.startTime, today.end)
          )
        )
        .groupBy(appointments.status),

      // SOAP notes created today
      ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(soapNotes)
        .where(
          and(
            eq(soapNotes.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(soapNotes.deletedAt),
            gte(soapNotes.createdAt, today.start),
            lt(soapNotes.createdAt, today.end)
          )
        ),

      // Invoices paid today
      ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(invoices)
        .where(
          and(
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(invoices.deletedAt),
            eq(invoices.status, "paid"),
            gte(invoices.updatedAt, today.start),
            lt(invoices.updatedAt, today.end)
          )
        ),
    ]);

    const statusMap = Object.fromEntries(
      appointmentsByStatus.map((r) => [r.status, Number(r.count)])
    );

    const totalAppointments = Object.values(statusMap).reduce(
      (a, b) => a + b,
      0
    );
    const patientsSeen = (statusMap["checked_out"] ?? 0) + (statusMap["in_exam"] ?? 0);

    return {
      date: today.date,
      appointments: {
        total: totalAppointments,
        byStatus: statusMap,
      },
      patientsSeen,
      soapNotesCreated: Number(soapNotesCreated[0]?.count ?? 0),
      invoicesPaid: Number(invoicesPaid[0]?.count ?? 0),
    };
  }),
});
