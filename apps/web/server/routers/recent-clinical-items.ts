import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  appointments,
  patients,
  practices,
  recentClinicalItems,
} from "@openpims/db";
import { ambulatoryWorkspaceRolloutEnabled } from "@/server/ambulatory-rollout";

function assertAmbulatoryWorkspaceAvailable(): void {
  if (!ambulatoryWorkspaceRolloutEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Ambulatory workspace is not available.",
    });
  }
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1 from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

export const recentClinicalItemsRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    assertAmbulatoryWorkspaceAvailable();
    return ctx.db
      .select({
        patientId: patients.id,
        patientName: patients.name,
        patientSpecies: patients.species,
        appointmentId: recentClinicalItems.appointmentId,
        appointmentStatus: appointments.status,
        viewedAt: recentClinicalItems.viewedAt,
      })
      .from(recentClinicalItems)
      .innerJoin(
        patients,
        and(
          eq(recentClinicalItems.patientId, patients.id),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .leftJoin(
        appointments,
        and(
          eq(recentClinicalItems.appointmentId, appointments.id),
          eq(appointments.practiceId, ctx.practiceId),
          eq(appointments.patientId, recentClinicalItems.patientId),
          isNull(appointments.deletedAt),
        ),
      )
      .where(
        and(
          eq(recentClinicalItems.practiceId, ctx.practiceId),
          eq(recentClinicalItems.userId, ctx.user.id),
          activePracticePredicate(ctx.practiceId),
          isNull(recentClinicalItems.deletedAt),
        ),
      )
      .orderBy(desc(recentClinicalItems.viewedAt))
      .limit(10);
  }),

  record: protectedProcedure
    .input(
      z
        .object({
          patientId: z.string().uuid(),
          appointmentId: z.string().uuid().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      assertAmbulatoryWorkspaceAvailable();
      const [target] = await ctx.db
        .select({
          patientId: patients.id,
          appointmentId: appointments.id,
        })
        .from(patients)
        .leftJoin(
          appointments,
          and(
            input.appointmentId
              ? eq(appointments.id, input.appointmentId)
              : sql`false`,
            eq(appointments.patientId, patients.id),
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt),
          ),
        )
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      if (!target || (input.appointmentId && !target.appointmentId)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient or visit not found",
        });
      }

      const now = new Date();
      const [recorded] = await ctx.db
        .insert(recentClinicalItems)
        .values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          patientId: target.patientId,
          appointmentId: input.appointmentId,
          viewedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            recentClinicalItems.practiceId,
            recentClinicalItems.userId,
            recentClinicalItems.patientId,
          ],
          set: {
            appointmentId: input.appointmentId,
            viewedAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        })
        .returning({ id: recentClinicalItems.id });
      if (!recorded) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Recent item could not be recorded",
        });
      }
      return recorded;
    }),
});
