import { isNull, sql, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { db } from "@openpims/db/client";
import { practices, users, clients, patients, locations } from "@openpims/db";
import { isPlatformAdmin } from "@/lib/platform-admin";
import {
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  getPlan,
  type PlanTier,
} from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";

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
      const userCount = userCounts.get(p.id) ?? 0;
      const locationCount = Math.max(1, locationCounts.get(p.id) ?? 0);
      const estimatedMrr =
        p.billingStatus === "active" && getPlan(p.tier).tier === "cloud"
          ? locationCount * CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD +
            userCount * CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
          : 0;
      return {
        ...p,
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
});
