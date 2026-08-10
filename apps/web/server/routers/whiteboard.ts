import { z } from "zod";
import { eq, and, isNull, gte, lt, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  appointments,
  practices,
  patients,
  clients,
  users,
  appointmentTypes,
  rooms,
  visitCloseouts,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { dateInputUtcRangeForTimeZone } from "@/lib/date-input";
import {
  appointmentStatusValues,
  canTransitionAppointmentStatus,
} from "@/lib/scheduling/appointment-status";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { CLOSEOUT_BYPASS_MESSAGE } from "@/lib/encounters/closeout-policy";

type WhiteboardContext = {
  db: Database;
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

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function practiceSettings(ctx: WhiteboardContext): Promise<{
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
    throw practiceNotFound();
  }

  return {
    name: practice.name.trim() || "Veterinary Practice",
    phone: practice.phone ?? null,
    timezone: practice.timezone ?? null,
  };
}

async function practiceTimeZone(ctx: WhiteboardContext): Promise<string | null> {
  return (await practiceSettings(ctx)).timezone;
}

async function practiceDayRange(
  ctx: WhiteboardContext
): Promise<{ date: string; start: Date; end: Date }> {
  return dateInputUtcRangeForTimeZone(new Date(), await practiceTimeZone(ctx));
}

export const whiteboardRouter = createRouter({
  settings: protectedProcedure.query(async ({ ctx }) => practiceSettings(ctx)),

  getActive: protectedProcedure.query(async ({ ctx }) => {
    const today = await practiceDayRange(ctx);

    return ctx.db
      .select({
        id: appointments.id,
        status: appointments.status,
        startTime: appointments.startTime,
        notes: appointments.notes,
        patientId: patients.id,
        clientId: clients.id,
        patientName: patients.name,
        patientSpecies: patients.species,
        patientPhotoUrl: patients.photoUrl,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        doctorName: users.name,
        roomName: rooms.name,
        typeName: appointmentTypes.name,
        typeColor: appointmentTypes.color,
      })
      .from(appointments)
      .leftJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.clientId, appointments.clientId),
          eq(patients.practiceId, ctx.practiceId),
          eq(patients.status, "active"),
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
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt)
        )
      )
      .leftJoin(
        appointmentTypes,
        and(
          eq(appointments.typeId, appointmentTypes.id),
          eq(appointmentTypes.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointmentTypes.deletedAt)
        )
      )
      .leftJoin(
        rooms,
        and(
          eq(appointments.roomId, rooms.id),
          eq(rooms.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(rooms.deletedAt)
        )
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, today.start),
          lt(appointments.startTime, today.end),
          inArray(appointments.status, [
            "confirmed",
            "checked_in",
            "in_exam",
            "checked_out",
          ])
        )
      )
      .orderBy(appointments.startTime);
  }),

  updateStatus: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(appointmentStatusValues),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { current, appt } = await ctx.db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            patientId: appointments.patientId,
            clientId: appointments.clientId,
            activePatientId: patients.id,
            activeClientId: clients.id,
          })
          .from(appointments)
          .leftJoin(
            patients,
            and(
              eq(appointments.patientId, patients.id),
              eq(patients.clientId, appointments.clientId),
              eq(patients.practiceId, ctx.practiceId),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .leftJoin(
            clients,
            and(
              eq(appointments.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
              isNull(clients.deletedAt)
            )
          )
          .where(
            and(
              eq(appointments.id, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt)
            )
          )
          // Lock only the appointment owner row; PostgreSQL cannot apply
          // FOR UPDATE to the nullable side of these validation LEFT JOINs.
          .for("update", { of: appointments });
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Appointment not found",
          });
        }
        if (input.status === "checked_out") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: CLOSEOUT_BYPASS_MESSAGE,
          });
        }
        if (!canTransitionAppointmentStatus(current.status, input.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot change appointment status from ${current.status} to ${input.status}.`,
          });
        }
        if (
          input.status === "in_exam" &&
          (!current.patientId ||
            !current.clientId ||
            current.activePatientId !== current.patientId ||
            current.activeClientId !== current.clientId)
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Attach an active patient and matching client before starting the exam.",
          });
        }

        const [closeout] = await tx
          .select({ id: visitCloseouts.id, status: visitCloseouts.status })
          .from(visitCloseouts)
          .where(
            and(
              eq(visitCloseouts.appointmentId, input.id),
              eq(visitCloseouts.practiceId, ctx.practiceId),
              isNull(visitCloseouts.deletedAt)
            )
          )
          .limit(1);
        if (
          closeout?.status === "clinical_finalized" ||
          closeout?.status === "completed"
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Clinical handoff is finalized. Complete the visit through closeout instead of changing its status.",
          });
        }

        const [appt] = await tx
          .update(appointments)
          .set({ status: input.status })
          .where(
            and(
              eq(appointments.id, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              eq(appointments.status, current.status),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt)
            )
          )
          .returning();
        if (!appt) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Appointment status changed; try again.",
          });
        }
        if (
          closeout?.status === "draft" &&
          (input.status === "cancelled" || input.status === "no_show")
        ) {
          const now = new Date();
          await tx
            .update(visitCloseouts)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(visitCloseouts.id, closeout.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, "draft"),
                isNull(visitCloseouts.deletedAt)
              )
            );
        }
        return { current, appt };
      });
      if (appt.status === "checked_in") {
        await dispatchWebhookEvent(ctx.practiceId, "appointment.checked_in", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      if (appt.status === "cancelled") {
        await dispatchWebhookEvent(ctx.practiceId, "appointment.cancelled", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      return appt;
    }),
});
