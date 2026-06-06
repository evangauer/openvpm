import { z } from "zod";
import { eq, and, isNull, asc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { appointmentWaitlist, clients, patients, appointmentTypes } from "@openpims/db";
import { matchWaitlist, type WaitlistEntry } from "@/lib/scheduling/waitlist";

const manageRole = requireRole("admin", "veterinarian", "front_desk");

/** Join the display fields the UI needs alongside the matcher fields. */
function selectShape() {
  return {
    id: appointmentWaitlist.id,
    status: appointmentWaitlist.status,
    typeId: appointmentWaitlist.typeId,
    preferredFrom: appointmentWaitlist.preferredFrom,
    preferredTo: appointmentWaitlist.preferredTo,
    notes: appointmentWaitlist.notes,
    createdAt: appointmentWaitlist.createdAt,
    clientFirstName: clients.firstName,
    clientLastName: clients.lastName,
    clientPhone: clients.phone,
    patientName: patients.name,
    typeName: appointmentTypes.name,
  };
}

export const waitlistRouter = createRouter({
  list: protectedProcedure
    .input(
      z
        .object({ status: z.enum(["waiting", "scheduled", "cancelled"]).default("waiting") })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const status = input?.status ?? "waiting";
      return ctx.db
        .select(selectShape())
        .from(appointmentWaitlist)
        .leftJoin(clients, eq(appointmentWaitlist.clientId, clients.id))
        .leftJoin(patients, eq(appointmentWaitlist.patientId, patients.id))
        .leftJoin(appointmentTypes, eq(appointmentWaitlist.typeId, appointmentTypes.id))
        .where(
          and(
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            eq(appointmentWaitlist.status, status),
            isNull(appointmentWaitlist.deletedAt)
          )
        )
        .orderBy(asc(appointmentWaitlist.createdAt));
    }),

  add: protectedProcedure
    .use(manageRole)
    .input(
      z.object({
        clientId: z.string().uuid(),
        patientId: z.string().uuid().optional(),
        typeId: z.string().uuid().optional(),
        preferredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        preferredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        notes: z.string().max(1000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(appointmentWaitlist)
        .values({
          practiceId: ctx.practiceId,
          clientId: input.clientId,
          patientId: input.patientId ?? null,
          typeId: input.typeId ?? null,
          preferredFrom: input.preferredFrom ?? null,
          preferredTo: input.preferredTo ?? null,
          notes: input.notes ?? null,
          createdBy: ctx.user.id,
        })
        .returning();
      return row!;
    }),

  setStatus: protectedProcedure
    .use(manageRole)
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["waiting", "scheduled", "cancelled"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(appointmentWaitlist)
        .set({ status: input.status })
        .where(
          and(
            eq(appointmentWaitlist.id, input.id),
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            isNull(appointmentWaitlist.deletedAt)
          )
        )
        .returning();
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Waitlist entry not found" });
      return updated;
    }),

  /**
   * When a slot opens up (e.g. a cancellation), find waiting clients who fit
   * the freed date + appointment type, oldest request first.
   */
  matchesForSlot: protectedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        typeId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select(selectShape())
        .from(appointmentWaitlist)
        .leftJoin(clients, eq(appointmentWaitlist.clientId, clients.id))
        .leftJoin(patients, eq(appointmentWaitlist.patientId, patients.id))
        .leftJoin(appointmentTypes, eq(appointmentWaitlist.typeId, appointmentTypes.id))
        .where(
          and(
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            eq(appointmentWaitlist.status, "waiting"),
            isNull(appointmentWaitlist.deletedAt)
          )
        );

      const entries: WaitlistEntry[] = rows.map((r) => ({
        id: r.id,
        status: r.status,
        typeId: r.typeId,
        preferredFrom: r.preferredFrom,
        preferredTo: r.preferredTo,
        createdAt: r.createdAt,
      }));
      // Run the matcher once, then map back to the joined display rows in the
      // matcher's FIFO order.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return matchWaitlist(entries, { date: input.date, typeId: input.typeId })
        .map((e) => byId.get(e.id))
        .filter((r): r is (typeof rows)[number] => Boolean(r));
    }),
});
