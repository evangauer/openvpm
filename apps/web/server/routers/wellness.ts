import { z } from "zod";
import { eq, and, isNull, lte, desc, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  wellnessPlans,
  wellnessEnrollments,
  clients,
  patients,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { computeNextBillingDate } from "@/lib/wellness/billing";
import { generateDueWellnessInvoices } from "@/lib/wellness/invoicing";
import {
  clinicalDateInput,
  clinicalDecimalInput,
  clinicalTextInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH,
  WELLNESS_PLAN_NAME_MAX_LENGTH,
  WELLNESS_PLAN_PRICE_MAX,
  WELLNESS_PLAN_PRICE_MIN,
  WELLNESS_PLAN_PRICE_SCALE,
} from "@/lib/wellness/policy";

const manageRole = requireRole("admin", "front_desk");
const wellnessDateInput = clinicalDateInput("Wellness date");
const wellnessPriceInput = clinicalDecimalInput("Wellness plan price", {
  min: WELLNESS_PLAN_PRICE_MIN,
  max: WELLNESS_PLAN_PRICE_MAX,
  scale: WELLNESS_PLAN_PRICE_SCALE,
});
export const WELLNESS_INVOICE_BATCH_MAX_TARGETS = 100;

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

async function assertActivePractice(db: Database, practiceId: string) {
  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function practiceTimeZone(
  db: Database,
  practiceId: string
): Promise<string | null> {
  const [practice] = await db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }

  return practice.timezone ?? null;
}

async function practiceDateInput(
  db: Database,
  practiceId: string
): Promise<string> {
  return formatDateInputForTimeZone(
    new Date(),
    await practiceTimeZone(db, practiceId)
  );
}

async function assertEnrollmentTargetsBelongToPractice(
  db: Database,
  practiceId: string,
  input: {
    clientId: string;
    patientId?: string;
  }
) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, input.clientId),
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }

  if (input.patientId) {
    const [patient] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.id, input.patientId),
          eq(patients.clientId, input.clientId),
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
}

export const wellnessRouter = createRouter({
  listPlans: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx.db, ctx.practiceId);
    return ctx.db
      .select()
      .from(wellnessPlans)
      .where(
        and(
          eq(wellnessPlans.practiceId, ctx.practiceId),
          isNull(wellnessPlans.deletedAt)
        )
      )
      .orderBy(desc(wellnessPlans.createdAt));
  }),

  createPlan: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        name: clinicalTextInput("Plan name", WELLNESS_PLAN_NAME_MAX_LENGTH),
        description: optionalClinicalTextInput(
          "Description",
          WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH
        ),
        price: wellnessPriceInput,
        billingInterval: z.enum(["monthly", "annual"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const [plan] = await ctx.db
        .insert(wellnessPlans)
        .values({
          practiceId: ctx.practiceId,
          name: input.name,
          description: input.description ?? null,
          price: input.price.toFixed(2),
          billingInterval: input.billingInterval,
        })
        .returning();
      return plan!;
    }),

  setPlanActive: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        planId: z.string().uuid(),
        active: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      if (!input.active) {
        const [activeEnrollment] = await ctx.db
          .select({ id: wellnessEnrollments.id })
          .from(wellnessEnrollments)
          .where(
            and(
              eq(wellnessEnrollments.practiceId, ctx.practiceId),
              eq(wellnessEnrollments.planId, input.planId),
              activePracticePredicate(ctx.practiceId),
              eq(wellnessEnrollments.status, "active"),
              isNull(wellnessEnrollments.deletedAt)
            )
          )
          .limit(1);

        if (activeEnrollment) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Cancel or migrate active enrollments before deactivating this wellness plan.",
          });
        }
      }

      const [plan] = await ctx.db
        .update(wellnessPlans)
        .set({ active: input.active })
        .where(
          and(
            eq(wellnessPlans.id, input.planId),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(wellnessPlans.deletedAt)
          )
        )
        .returning();

      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
      }
      return plan;
    }),

  enroll: protectedProcedure
    .use(manageRole)
    .input(
      z.object({
        planId: z.string().uuid(),
        clientId: z.string().uuid(),
        patientId: z.string().uuid().optional(),
        startDate: wellnessDateInput.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const [plan] = await ctx.db
        .select({ id: wellnessPlans.id })
        .from(wellnessPlans)
        .where(
          and(
            eq(wellnessPlans.id, input.planId),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessPlans.active, true),
            isNull(wellnessPlans.deletedAt)
          )
        )
        .limit(1);
      if (!plan) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Plan not found" });
      }

      await assertEnrollmentTargetsBelongToPractice(
        ctx.db,
        ctx.practiceId,
        input
      );

      const [existingEnrollment] = await ctx.db
        .select({ id: wellnessEnrollments.id })
        .from(wellnessEnrollments)
        .where(
          and(
            eq(wellnessEnrollments.practiceId, ctx.practiceId),
            eq(wellnessEnrollments.planId, input.planId),
            eq(wellnessEnrollments.clientId, input.clientId),
            activePracticePredicate(ctx.practiceId),
            input.patientId
              ? eq(wellnessEnrollments.patientId, input.patientId)
              : isNull(wellnessEnrollments.patientId),
            eq(wellnessEnrollments.status, "active"),
            isNull(wellnessEnrollments.deletedAt)
          )
        )
        .limit(1);
      if (existingEnrollment) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This client already has an active enrollment for this plan.",
        });
      }

      const startDate =
        input.startDate ?? (await practiceDateInput(ctx.db, ctx.practiceId));
      const [enrollment] = await ctx.db
        .insert(wellnessEnrollments)
        .values({
          practiceId: ctx.practiceId,
          planId: input.planId,
          clientId: input.clientId,
          patientId: input.patientId ?? null,
          startDate,
          // First charge is due at enrollment; staff bill it and advance.
          nextBillingDate: startDate,
        })
        .returning();
      return enrollment!;
    }),

  /** Active enrollments due for billing on or before `asOf` (default today). */
  listDue: protectedProcedure
    .use(manageRole)
    .input(z.object({ asOf: wellnessDateInput.optional() }).optional())
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const asOf =
        input?.asOf ?? (await practiceDateInput(ctx.db, ctx.practiceId));
      return ctx.db
        .select({
          enrollmentId: wellnessEnrollments.id,
          nextBillingDate: wellnessEnrollments.nextBillingDate,
          planName: wellnessPlans.name,
          price: wellnessPlans.price,
          billingInterval: wellnessPlans.billingInterval,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          patientName: patients.name,
        })
        .from(wellnessEnrollments)
        .innerJoin(
          wellnessPlans,
          and(
            eq(wellnessEnrollments.planId, wellnessPlans.id),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessPlans.active, true),
            isNull(wellnessPlans.deletedAt)
          )
        )
        .innerJoin(
          clients,
          and(
            eq(wellnessEnrollments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(wellnessEnrollments.patientId, patients.id),
            eq(patients.clientId, wellnessEnrollments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .where(
          and(
            eq(wellnessEnrollments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessEnrollments.status, "active"),
            isNull(wellnessEnrollments.deletedAt),
            lte(wellnessEnrollments.nextBillingDate, asOf),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            eq(wellnessPlans.active, true),
            isNull(wellnessPlans.deletedAt),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .orderBy(wellnessEnrollments.nextBillingDate);
    }),

  listEnrollments: protectedProcedure
    .input(
      z
        .object({
          clientId: z.string().uuid().optional(),
          patientId: z.string().uuid().optional(),
          status: z.enum(["active", "cancelled"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const timezone = await practiceTimeZone(ctx.db, ctx.practiceId);
      const conditions: SQL[] = [
        eq(wellnessEnrollments.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(wellnessEnrollments.deletedAt),
        eq(wellnessPlans.practiceId, ctx.practiceId),
        isNull(wellnessPlans.deletedAt),
        eq(clients.practiceId, ctx.practiceId),
        isNull(clients.deletedAt),
      ];
      if (input?.clientId) {
        conditions.push(eq(wellnessEnrollments.clientId, input.clientId));
      }
      if (input?.patientId) {
        conditions.push(eq(wellnessEnrollments.patientId, input.patientId));
      }
      if (input?.status) {
        conditions.push(eq(wellnessEnrollments.status, input.status));
      }

      const rows = await ctx.db
        .select({
          enrollmentId: wellnessEnrollments.id,
          status: wellnessEnrollments.status,
          startDate: wellnessEnrollments.startDate,
          nextBillingDate: wellnessEnrollments.nextBillingDate,
          cancelledAt: wellnessEnrollments.cancelledAt,
          planName: wellnessPlans.name,
          price: wellnessPlans.price,
          billingInterval: wellnessPlans.billingInterval,
          clientId: wellnessEnrollments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          patientId: patients.id,
          patientName: patients.name,
        })
        .from(wellnessEnrollments)
        .innerJoin(
          wellnessPlans,
          and(
            eq(wellnessEnrollments.planId, wellnessPlans.id),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(wellnessPlans.deletedAt)
          )
        )
        .innerJoin(
          clients,
          and(
            eq(wellnessEnrollments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(wellnessEnrollments.patientId, patients.id),
            eq(patients.clientId, wellnessEnrollments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .where(and(...conditions))
        .orderBy(desc(wellnessEnrollments.createdAt));
      return rows.map((row) => ({
        ...row,
        timezone,
      }));
    }),

  /**
   * Generate real invoices for due memberships and advance their invoice schedule.
   * This is not a card-on-file Stripe subscription flow; generated invoices are
   * payable through the existing staff/portal Stripe checkout paths.
   */
  generateDueInvoices: protectedProcedure
    .use(manageRole)
    .input(
      z
        .object({
          asOf: wellnessDateInput.optional(),
          enrollmentIds: z
            .array(z.string().uuid())
            .max(
              WELLNESS_INVOICE_BATCH_MAX_TARGETS,
              `Wellness invoice runs can target at most ${WELLNESS_INVOICE_BATCH_MAX_TARGETS} enrollments.`
            )
            .optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const asOf =
        input?.asOf ?? (await practiceDateInput(ctx.db, ctx.practiceId));
      return generateDueWellnessInvoices({
        db: ctx.db,
        practiceId: ctx.practiceId,
        asOf,
        enrollmentIds: input?.enrollmentIds,
      });
    }),

  /**
   * Manual reconciliation escape hatch: advance an enrollment without creating
   * an invoice, for charges handled outside OpenVPM.
   */
  markBilled: protectedProcedure
    .use(manageRole)
    .input(z.object({ enrollmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const [row] = await ctx.db
        .select({
          id: wellnessEnrollments.id,
          nextBillingDate: wellnessEnrollments.nextBillingDate,
          interval: wellnessPlans.billingInterval,
        })
        .from(wellnessEnrollments)
        .innerJoin(
          wellnessPlans,
          and(
            eq(wellnessEnrollments.planId, wellnessPlans.id),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessPlans.active, true),
            isNull(wellnessPlans.deletedAt)
          )
        )
        .where(
          and(
            eq(wellnessEnrollments.id, input.enrollmentId),
            eq(wellnessEnrollments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessEnrollments.status, "active"),
            eq(wellnessPlans.practiceId, ctx.practiceId),
            eq(wellnessPlans.active, true),
            isNull(wellnessPlans.deletedAt),
            isNull(wellnessEnrollments.deletedAt)
          )
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Enrollment not found",
        });
      }

      const next = computeNextBillingDate(row.nextBillingDate, row.interval);
      const [updated] = await ctx.db
        .update(wellnessEnrollments)
        .set({ nextBillingDate: next })
        .where(
          and(
            eq(wellnessEnrollments.id, input.enrollmentId),
            eq(wellnessEnrollments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessEnrollments.status, "active"),
            eq(wellnessEnrollments.nextBillingDate, row.nextBillingDate),
            isNull(wellnessEnrollments.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enrollment changed while billing. Refresh and try again.",
        });
      }
      return updated;
    }),

  cancel: protectedProcedure
    .use(manageRole)
    .input(z.object({ enrollmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const [updated] = await ctx.db
        .update(wellnessEnrollments)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(
          and(
            eq(wellnessEnrollments.id, input.enrollmentId),
            eq(wellnessEnrollments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(wellnessEnrollments.status, "active"),
            isNull(wellnessEnrollments.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Enrollment not found",
        });
      }
      return updated;
    }),
});
