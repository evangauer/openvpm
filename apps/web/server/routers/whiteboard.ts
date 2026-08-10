import { z } from "zod";
import { eq, and, isNull, gte, gt, lt, inArray, not, sql } from "drizzle-orm";
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
  locations,
  visitCloseouts,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { dateInputUtcRangeForTimeZone } from "@/lib/date-input";
import {
  appointmentStatusValues,
  canTransitionAppointmentStatus,
} from "@/lib/scheduling/appointment-status";
import { dispatchAppointmentWebhookAfterCommit } from "@/lib/appointment-webhooks";
import { CLOSEOUT_BYPASS_MESSAGE } from "@/lib/encounters/closeout-policy";
import { conflictMessage, detectConflicts } from "@/lib/scheduling/conflicts";
import {
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "@/lib/scheduling/location";

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
        locationName: locations.name,
        locationId: appointments.locationId,
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
      .leftJoin(
        locations,
        and(
          eq(appointments.locationId, locations.id),
          eq(locations.practiceId, ctx.practiceId),
        ),
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
        await takeAppointmentSchedulingLock(
          tx as unknown as Database,
          ctx.practiceId,
        );
        const [current] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            doctorId: appointments.doctorId,
            roomId: appointments.roomId,
            locationId: appointments.locationId,
            patientId: appointments.patientId,
            clientId: appointments.clientId,
            activePatientId: patients.id,
            activeClientId: clients.id,
            startTime: appointments.startTime,
            endTime: appointments.endTime,
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
        let restoredLocationId: string | undefined;
        if (
          (current.status === "cancelled" || current.status === "no_show") &&
          input.status !== "cancelled" &&
          input.status !== "no_show"
        ) {
          const resolution = await resolveAppointmentLocation(
            tx as unknown as Database,
            {
              practiceId: ctx.practiceId,
              locationId: current.locationId,
              doctorId: current.doctorId,
              roomId: current.roomId,
            },
          );
          if (!resolution.ok) {
            throw new TRPCError({
              code: resolution.code,
              message: resolution.message,
            });
          }
          restoredLocationId = resolution.locationId;
          const existing = await tx
            .select({
              id: appointments.id,
              startTime: appointments.startTime,
              endTime: appointments.endTime,
              doctorId: appointments.doctorId,
              roomId: appointments.roomId,
              locationId: appointments.locationId,
              status: appointments.status,
            })
            .from(appointments)
            .where(
              and(
                eq(appointments.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(appointments.deletedAt),
                not(inArray(appointments.status, ["cancelled", "no_show"])),
                lt(appointments.startTime, current.endTime),
                gt(appointments.endTime, current.startTime),
              ),
            );
          const message = conflictMessage(
            detectConflicts(
              {
                startTime: current.startTime,
                endTime: current.endTime,
                doctorId: current.doctorId,
                roomId: current.roomId,
                locationId: restoredLocationId,
                excludeId: current.id,
              },
              existing,
            ),
          );
          if (message) {
            throw new TRPCError({ code: "CONFLICT", message });
          }
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
          .set({
            status: input.status,
            ...(restoredLocationId ? { locationId: restoredLocationId } : {}),
          })
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
        await dispatchAppointmentWebhookAfterCommit(ctx, ctx.practiceId, "appointment.checked_in", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          roomId: appt.roomId,
          locationId: appt.locationId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      if (appt.status === "cancelled") {
        await dispatchAppointmentWebhookAfterCommit(ctx, ctx.practiceId, "appointment.cancelled", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          roomId: appt.roomId,
          locationId: appt.locationId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      return appt;
    }),
});
