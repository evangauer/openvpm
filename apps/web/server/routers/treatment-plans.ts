import { z } from "zod";
import { eq, and, isNull, asc, desc, inArray, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  patients,
  practices,
  problemList,
  treatmentPlans,
  treatmentPlanItems,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  summarizePlanProgress,
  type PlanItemStatus,
} from "@/lib/treatment-plans/progress";
import {
  clinicalDateInput,
  clinicalTextInput,
  compareClinicalDateInputs,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";

const clinicalRole = requireRole("admin", "veterinarian", "technician");
const planStatuses = ["active", "completed", "discontinued"] as const;
const itemStatuses = ["pending", "in_progress", "done", "skipped"] as const;

const createTreatmentPlanInput = z
  .object({
    patientId: z.string().uuid(),
    problemId: z.string().uuid().optional(),
    title: clinicalTextInput("Plan title", 255),
    description: optionalClinicalTextInput("Plan description", 2000),
    startDate: clinicalDateInput("Start date").optional(),
    endDate: clinicalDateInput("End date").optional(),
    items: z
      .array(
        z.object({
          description: clinicalTextInput("Item description", 500),
          instructions: optionalClinicalTextInput("Item instructions", 2000),
        })
      )
      .max(100, "Treatment plans can include at most 100 items.")
      .default([]),
  })
  .superRefine((input, ctx) => {
    if (
      input.startDate &&
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

type TreatmentPlansContext = {
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

async function assertActivePractice(ctx: TreatmentPlansContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

function activeTreatmentPlanScope(
  ctx: TreatmentPlansContext,
  planId: string
): SQL {
  return sql`exists (
    select 1
    from ${treatmentPlans}
    where ${treatmentPlans.id} = ${planId}
      and ${treatmentPlans.practiceId} = ${ctx.practiceId}
      and ${treatmentPlans.status} = 'active'
      and exists (
        select 1
        from ${practices}
        where ${practices.id} = ${ctx.practiceId}
          and ${practices.deletedAt} is null
      )
      and ${treatmentPlans.deletedAt} is null
  )`;
}

async function assertPatientBelongsToPractice(
  ctx: TreatmentPlansContext,
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

async function assertProblemBelongsToPatient(
  ctx: TreatmentPlansContext,
  problemId: string,
  patientId: string
) {
  const [problem] = await ctx.db
    .select({ id: problemList.id })
    .from(problemList)
    .where(
      and(
        eq(problemList.id, problemId),
        eq(problemList.patientId, patientId),
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

export const treatmentPlansRouter = createRouter({
  /** Plans for a patient, each with its items and a progress summary. */
  listByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const plans = await ctx.db
        .select()
        .from(treatmentPlans)
        .where(
          and(
            eq(treatmentPlans.patientId, input.patientId),
            eq(treatmentPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentPlans.deletedAt)
          )
        )
        .orderBy(desc(treatmentPlans.createdAt));

      if (plans.length === 0) return [];

      const items = await ctx.db
        .select()
        .from(treatmentPlanItems)
        .where(
          and(
            inArray(
              treatmentPlanItems.planId,
              plans.map((p) => p.id)
            ),
            isNull(treatmentPlanItems.deletedAt)
          )
        )
        .orderBy(asc(treatmentPlanItems.sortOrder));

      return plans.map((plan) => {
        const planItems = items.filter((i) => i.planId === plan.id);
        return {
          ...plan,
          items: planItems,
          progress: summarizePlanProgress(
            planItems.map((i) => ({ status: i.status as PlanItemStatus }))
          ),
        };
      });
    }),

  create: protectedProcedure
    .use(clinicalRole)
    .input(createTreatmentPlanInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertPatientBelongsToPractice(ctx, input.patientId);
      if (input.problemId) {
        await assertProblemBelongsToPatient(
          ctx,
          input.problemId,
          input.patientId
        );
      }

      return ctx.db.transaction(async (tx) => {
        const [plan] = await tx
          .insert(treatmentPlans)
          .values({
            practiceId: ctx.practiceId,
            patientId: input.patientId,
            problemId: input.problemId ?? null,
            title: input.title,
            description: input.description ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
            createdBy: ctx.user.id,
          })
          .returning();

        if (input.items.length > 0) {
          await tx.insert(treatmentPlanItems).values(
            input.items.map((item, i) => ({
              planId: plan!.id,
              description: item.description,
              instructions: item.instructions ?? null,
              sortOrder: i,
            }))
          );
        }

        return plan!;
      });
    }),

  updateStatus: protectedProcedure
    .use(clinicalRole)
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(planStatuses),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [current] = await ctx.db
        .select({
          id: treatmentPlans.id,
          status: treatmentPlans.status,
        })
        .from(treatmentPlans)
        .where(
          and(
            eq(treatmentPlans.id, input.id),
            eq(treatmentPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentPlans.deletedAt)
          )
        )
        .limit(1);

      if (!current) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
      }

      const [updated] = await ctx.db
        .update(treatmentPlans)
        .set({ status: input.status })
        .where(
          and(
            eq(treatmentPlans.id, input.id),
            eq(treatmentPlans.practiceId, ctx.practiceId),
            eq(treatmentPlans.status, current.status),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentPlans.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Treatment plan status changed. Refresh and try again.",
        });
      }
      return updated;
    }),

  updateItemStatus: protectedProcedure
    .use(clinicalRole)
    .input(
      z.object({
        itemId: z.string().uuid(),
        status: z.enum(itemStatuses),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the item's plan belongs to this practice before mutating.
      const [row] = await ctx.db
        .select({
          planId: treatmentPlanItems.planId,
          planStatus: treatmentPlans.status,
          itemStatus: treatmentPlanItems.status,
        })
        .from(treatmentPlanItems)
        .innerJoin(
          treatmentPlans,
          and(
            eq(treatmentPlanItems.planId, treatmentPlans.id),
            eq(treatmentPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentPlans.deletedAt)
          )
        )
        .where(
          and(
            eq(treatmentPlanItems.id, input.itemId),
            eq(treatmentPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentPlans.deletedAt),
            isNull(treatmentPlanItems.deletedAt)
          )
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      }
      if (row.planStatus !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only active treatment plans can be updated.",
        });
      }

      const [updated] = await ctx.db
        .update(treatmentPlanItems)
        .set({ status: input.status })
        .where(
          and(
            eq(treatmentPlanItems.id, input.itemId),
            eq(treatmentPlanItems.planId, row.planId),
            eq(treatmentPlanItems.status, row.itemStatus),
            activeTreatmentPlanScope(ctx, row.planId),
            isNull(treatmentPlanItems.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Treatment plan item changed. Refresh and try again.",
        });
      }
      return updated;
    }),
});
