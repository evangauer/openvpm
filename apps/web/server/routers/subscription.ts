import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { practices } from "@openpims/db";
import {
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
} from "@/lib/stripe";
import {
  PLANS,
  PLAN_ORDER,
  billingEnforced,
  cloudCheckoutPriceIds,
  cloudMeteredPriceIds,
  estimatedCloudBaseMonthlyUsd,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  TRIAL_DAYS,
  hasHostedFullAccess,
} from "@/lib/billing/plans";
import { usageForPractice, currentPeriodMonth } from "@/lib/billing/usage";
import {
  countBillableLocationsAndSeats,
  readBillingSyncState,
  syncPracticeSubscriptionQuantities,
  type BillingSyncState,
} from "@/lib/billing/subscription-sync";
import { appBaseUrl } from "@/lib/app-url";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

/** Whether a tier can be bought self-serve (Stripe price configured). */
function purchasable(tier: keyof typeof PLANS): boolean {
  if (tier !== "cloud") return false;
  const { locationPriceId, seatPriceId } = cloudCheckoutPriceIds();
  return !!(locationPriceId && seatPriceId);
}

export const subscriptionRouter = createRouter({
  /** Current plan + status, plus the catalog for display. */
  get: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
        stripeCustomerId: practices.stripeCustomerId,
        stripeSubscriptionId: practices.stripeSubscriptionId,
      })
      .from(practices)
      .where(eq(practices.id, ctx.practiceId))
      .limit(1);

    const enforced = billingEnforced();
    let counts = await countBillableLocationsAndSeats(ctx.db, ctx.practiceId);
    let billingSync: BillingSyncState | null = await readBillingSyncState(
      ctx.db,
      ctx.practiceId
    );
    if (enforced && practice?.stripeSubscriptionId) {
      billingSync = await syncPracticeSubscriptionQuantities({
        db: ctx.db,
        practiceId: ctx.practiceId,
        subscriptionId: practice.stripeSubscriptionId,
        alertOnError: false,
      });
      counts = {
        locationCount: billingSync.locationCount,
        billableSeatCount: billingSync.billableSeatCount,
      };
    }
    const period = currentPeriodMonth();
    const [smsUsed, aiUsed] = enforced
      ? await Promise.all([
          usageForPractice(ctx.practiceId, "sms", period),
          usageForPractice(ctx.practiceId, "ai_run", period),
        ])
      : [0, 0];

    return {
      tier: practice?.tier ?? "free",
      billingStatus: practice?.billingStatus ?? "none",
      trialEndsAt: practice?.trialEndsAt ?? null,
      hasBillingAccount: !!practice?.stripeCustomerId,
      billingEnforced: enforced,
      hasFullAccess: hasHostedFullAccess(
        practice?.tier,
        practice?.billingStatus,
        practice?.trialEndsAt
      ),
      locationCount: counts.locationCount,
      billableSeatCount: counts.billableSeatCount,
      locationUnitPriceMonthlyUsd: CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
      seatUnitPriceMonthlyUsd: CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
      estimatedMonthlyBase: estimatedCloudBaseMonthlyUsd(
        counts.locationCount,
        counts.billableSeatCount
      ),
      billingSyncStatus: billingSync,
      usage: { period, sms: smsUsed, aiRuns: aiUsed },
      plans: PLAN_ORDER.map((t) => {
        const p = PLANS[t];
        return {
          tier: p.tier,
          name: p.name,
          locationUnitPriceMonthlyUsd: p.locationUnitPriceMonthlyUsd,
          seatUnitPriceMonthlyUsd: p.seatUnitPriceMonthlyUsd,
          blurb: p.blurb,
          features: p.features,
          seatLimit: p.seatLimit,
          locationLimit: p.locationLimit,
          includedSmsPerMonth: p.includedSmsPerMonth,
          includedAiRunsPerMonth: p.includedAiRunsPerMonth,
          aiOveragePriceUsd: p.aiOveragePriceUsd,
          smsOveragePriceUsd: p.smsOveragePriceUsd,
          selfServe: p.selfServe,
          purchasable: purchasable(t),
        };
      }),
    };
  }),

  /** Start a Stripe Checkout for the self-serve Cloud plan. */
  createCheckout: adminProcedure
    .input(z.object({ tier: z.enum(["cloud"]).default("cloud") }))
    .mutation(async ({ ctx, input }) => {
      const plan = PLANS[input.tier];
      const { locationPriceId } = cloudCheckoutPriceIds();
      if (!plan.selfServe || !locationPriceId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This plan isn't available for checkout yet.",
        });
      }

      const [practice] = await ctx.db
        .select({
          stripeCustomerId: practices.stripeCustomerId,
          email: practices.email,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(eq(practices.id, ctx.practiceId))
        .limit(1);

      const counts = await countBillableLocationsAndSeats(ctx.db, ctx.practiceId);

      const base = appBaseUrl();
      const activeTrialEnd =
        practice?.billingStatus === "trialing" &&
        practice.trialEndsAt &&
        new Date(practice.trialEndsAt).getTime() > Date.now()
          ? practice.trialEndsAt
          : null;
      // Per-location licensed item, plus the metered overage items (AI + SMS)
      // when configured. Metered items carry no quantity; Stripe meters them.
      const { aiOveragePriceId, smsOveragePriceId } = cloudMeteredPriceIds();
      const lineItems: Array<{
        priceId: string;
        quantity?: number;
        metered?: boolean;
      }> = [{ priceId: locationPriceId, quantity: counts.locationCount }];
      if (aiOveragePriceId) lineItems.push({ priceId: aiOveragePriceId, metered: true });
      if (smsOveragePriceId) lineItems.push({ priceId: smsOveragePriceId, metered: true });
      const result = await createSubscriptionCheckoutSession({
        lineItems,
        practiceId: ctx.practiceId,
        customerId: practice?.stripeCustomerId ?? undefined,
        customerEmail: practice?.email ?? ctx.session.user.email,
        trialEnd: activeTrialEnd,
        trialPeriodDays: activeTrialEnd || practice?.trialEndsAt ? undefined : TRIAL_DAYS,
        successUrl: `${base}/settings?tab=billing&checkout=success`,
        cancelUrl: `${base}/settings?tab=billing&checkout=cancelled`,
      });
      if (!result) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Billing is not configured on this server.",
        });
      }
      return { url: result.url };
    }),

  /** Open the Stripe Billing Portal to manage/cancel an existing subscription. */
  openBillingPortal: adminProcedure.mutation(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ stripeCustomerId: practices.stripeCustomerId })
      .from(practices)
      .where(eq(practices.id, ctx.practiceId))
      .limit(1);

    if (!practice?.stripeCustomerId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "No billing account yet — start a plan first.",
      });
    }

    const result = await createBillingPortalSession({
      customerId: practice.stripeCustomerId,
      returnUrl: `${appBaseUrl()}/settings?tab=billing`,
    });
    if (!result) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Billing is not configured on this server.",
      });
    }
    return { url: result.url };
  }),
});
