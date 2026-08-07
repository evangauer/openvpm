import { z } from "zod";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { db } from "@openpims/db/client";
import { practices, users, clients, patients, locations } from "@openpims/db";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { computeActivationFunnel } from "@/lib/admin/activation-funnel";
import { computeJourneyFunnel } from "@/lib/admin/journey-funnel";
import {
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  getPlan,
  type PlanTier,
} from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import {
  onboardingIntentLabel,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";

/**
 * Platform-operator only. Crosses tenant boundaries deliberately, so it is
 * gated by the PLATFORM_ADMIN_EMAILS allowlist (not the practice "admin" role).
 */
const platformAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!isPlatformAdmin(ctx.session?.user?.email)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Platform admin access only." });
  }
  return next();
});

type AdminPracticeSettings = {
  acquisition?: { source?: string; campaign?: string };
  analyticsExcluded?: boolean;
  onboardingCompletedAt?: string | null;
  onboardingState?: {
    onboardingIntent?: OnboardingIntent;
    journeyStepId?: string | null;
    journeyDismissed?: boolean;
  };
};

const setupStepLabels: Record<string, string> = {
  intent: "Starting path",
  basics: "Clinic basics",
  branding: "Branding",
  team: "Team",
  data: "Data import",
  agent: "AI helper",
  phone: "Texting",
  billing: "Billing",
  allSet: "Finish",
};

function conversionContext(value: unknown) {
  const settings = (value ?? {}) as AdminPracticeSettings;
  const acquisition = settings.acquisition;
  const acquisitionSource =
    [acquisition?.source, acquisition?.campaign].filter(Boolean).join(" · ") ||
    "Unknown";
  const state = settings.onboardingState;
  const onboardingIntent = onboardingIntentLabel(state?.onboardingIntent);
  const analyticsExcluded = settings.analyticsExcluded === true;

  if (settings.onboardingCompletedAt) {
    return {
      acquisitionSource,
      onboardingIntent,
      analyticsExcluded,
      setupStage: "Complete",
    };
  }
  const step = state?.journeyStepId;
  if (step) {
    const label = setupStepLabels[step] ?? step;
    return {
      acquisitionSource,
      onboardingIntent,
      analyticsExcluded,
      setupStage: state?.journeyDismissed ? `Paused at ${label}` : label,
    };
  }
  return {
    acquisitionSource,
    onboardingIntent,
    analyticsExcluded,
    setupStage: "Not started",
  };
}

export const adminRouter = createRouter({
  /** Am I a platform admin? (drives whether the /admin nav shows.) */
  isPlatformAdmin: protectedProcedure.query(({ ctx }) => {
    return isPlatformAdmin(ctx.session?.user?.email);
  }),

  /** Cross-tenant operations overview: practices, plans, status, usage, MRR. */
  overview: platformAdminProcedure.query(async () =>
    // Bypass tenant RLS — this view legitimately spans all practices.
    withSystem(db, async (tx) => {
    const rows = await tx
      .select({
        id: practices.id,
        name: practices.name,
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
        timezone: practices.timezone,
        country: practices.country,
        createdAt: practices.createdAt,
        settings: practices.settings,
      })
      .from(practices)
      .where(isNull(practices.deletedAt))
      .orderBy(desc(practices.createdAt));

    const countBy = async (
      table: typeof users | typeof clients | typeof patients | typeof locations
    ) => {
      const res = await tx
        .select({
          practiceId: table.practiceId,
          c: sql<number>`count(*)::int`,
        })
        .from(table)
        .where(isNull(table.deletedAt))
        .groupBy(table.practiceId);
      return new Map(res.map((r) => [r.practiceId, Number(r.c)]));
    };

    const [userCounts, clientCounts, patientCounts, locationCounts] =
      await Promise.all([
        countBy(users),
        countBy(clients),
        countBy(patients),
        countBy(locations),
      ]);

    const practiceRows = rows.map((p) => {
      const { settings, ...practice } = p;
      const userCount = userCounts.get(p.id) ?? 0;
      const locationCount = Math.max(1, locationCounts.get(p.id) ?? 0);
      const estimatedMrr =
        p.billingStatus === "active" && getPlan(p.tier).tier === "cloud"
          ? locationCount * CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD +
            userCount * CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
          : 0;
      return {
        ...practice,
        ...conversionContext(settings),
        userCount,
        locationCount,
        estimatedMrr,
        clientCount: clientCounts.get(p.id) ?? 0,
        patientCount: patientCounts.get(p.id) ?? 0,
      };
    });

    // MRR: active hosted Cloud subscriptions use hybrid location + staff pricing.
    const estimatedMrr = practiceRows
      .filter(
        (p) => p.billingStatus === "active" && getPlan(p.tier).tier === "cloud"
      )
      .reduce((sum, p) => sum + p.estimatedMrr, 0);

    const byTier: Record<PlanTier, number> = {
      free: 0,
      cloud: 0,
      enterprise: 0,
    };
    for (const p of practiceRows) {
      const t = getPlan(p.tier).tier;
      byTier[t] += 1;
    }

    return {
      practices: practiceRows,
      totals: {
        practices: practiceRows.length,
        estimatedMrr,
        byTier,
        trialing: practiceRows.filter((p) => p.billingStatus === "trialing").length,
        active: practiceRows.filter((p) => p.billingStatus === "active").length,
        pastDue: practiceRows.filter((p) => p.billingStatus === "past_due").length,
      },
    };
    })
  ),

  /**
   * Platform-operator tooling: give a trialing practice more time. Extends
   * from the later of now / the current trial end, so a lapsed no-card trial
   * comes back to life. Paid, past-due, and canceled practices are managed in
   * Stripe, never here.
   */
  extendTrial: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        days: z.number().int().min(1).max(90),
      })
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [practice] = await tx
          .select({
            id: practices.id,
            billingStatus: practices.billingStatus,
            trialEndsAt: practices.trialEndsAt,
          })
          .from(practices)
          .where(
            and(eq(practices.id, input.practiceId), isNull(practices.deletedAt))
          )
          .limit(1);

        if (!practice) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found." });
        }
        if (practice.billingStatus !== "trialing") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Only trialing practices can be extended. Paid and canceled practices are managed through Stripe.",
          });
        }

        const now = Date.now();
        const base =
          practice.trialEndsAt && practice.trialEndsAt.getTime() > now
            ? practice.trialEndsAt.getTime()
            : now;
        const trialEndsAt = new Date(base + input.days * 24 * 60 * 60 * 1000);

        await tx
          .update(practices)
          .set({ trialEndsAt, updatedAt: new Date() })
          .where(eq(practices.id, input.practiceId));

        return { practiceId: input.practiceId, trialEndsAt };
      })
    ),

  /** Reversibly exclude internal/test practices from conversion reporting. */
  setAnalyticsExcluded: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        excluded: z.boolean(),
      })
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [updated] = await tx
          .update(practices)
          .set({
            settings: sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify({
              analyticsExcluded: input.excluded,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(eq(practices.id, input.practiceId), isNull(practices.deletedAt))
          )
          .returning({ id: practices.id });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Practice not found.",
          });
        }
        return { practiceId: input.practiceId, excluded: input.excluded };
      })
    ),

  /**
   * Trial funnel: signups -> activated -> subscribed, derived from existing
   * rows (see lib/admin/activation-funnel.ts for the definitions).
   */
  activationFunnel: platformAdminProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .optional()
    )
    .query(({ input }) => computeActivationFunnel(db, input?.days ?? 30)),

  /** Privacy-safe first-touch cohorts spanning visit through paid. */
  journeyFunnel: platformAdminProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .optional()
    )
    .query(({ input }) => computeJourneyFunnel(db, input?.days ?? 30)),
});
