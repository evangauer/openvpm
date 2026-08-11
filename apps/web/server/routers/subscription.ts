import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { practices } from "@openpims/db";
import {
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
} from "@/lib/stripe";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
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
  type BillingSyncState,
} from "@/lib/billing/subscription-sync";
import { appBaseUrl } from "@/lib/app-url";
import { billingContactEmail } from "@/lib/billing/contact";
import { RECOVERY_HOLD_BLOCK_MESSAGE } from "@/lib/recovery-hold";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

/** Whether a tier can be bought self-serve (Stripe price configured). */
function purchasable(tier: keyof typeof PLANS): boolean {
  if (tier !== "cloud") return false;
  const { locationPriceId } = cloudCheckoutPriceIds();
  return !!locationPriceId;
}

export const subscriptionRouter = createRouter({
  /** Current plan + status, plus the catalog for display. */
  get: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({
        tier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
        timezone: practices.timezone,
        stripeCustomerId: practices.stripeCustomerId,
        stripeSubscriptionId: practices.stripeSubscriptionId,
      })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);

    if (!practice) {
      throw practiceNotFound();
    }

    const enforced = billingEnforced();
    let counts = await countBillableLocationsAndSeats(ctx.db, ctx.practiceId);
    let billingSync: BillingSyncState | null = await readBillingSyncState(
      ctx.db,
      ctx.practiceId
    );
    const period = currentPeriodMonth();
    const [smsUsed, aiUsed] = enforced
      ? await Promise.all([
          usageForPractice(ctx.practiceId, "sms", period),
          usageForPractice(ctx.practiceId, "ai_run", period),
        ])
      : [0, 0];

    return {
      tier: practice.tier ?? "free",
      billingStatus: practice.billingStatus ?? "none",
      trialEndsAt: practice.trialEndsAt ?? null,
      timezone: practice.timezone ?? null,
      hasBillingAccount: !!practice.stripeCustomerId,
      hasSubscription: !!practice.stripeSubscriptionId,
      billingEnforced: enforced,
      hasFullAccess: hasHostedFullAccess(
        practice.tier,
        practice.billingStatus,
        practice.trialEndsAt
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
    .input(
      z.object({
        tier: z.enum(["cloud"]).default("cloud"),
        // Where Stripe sends the admin back: the billing page (default) or
        // the guided setup, which resumes where they left off.
        returnTo: z.enum(["settings", "setup"]).default("settings"),
      })
    )
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
          stripeSubscriptionId: practices.stripeSubscriptionId,
          email: practices.email,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
          recoveryHold: practices.recoveryHold,
        })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1)
        .for("share", { of: practices });

      if (!practice) {
        throw practiceNotFound();
      }
      if (practice.recoveryHold) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: RECOVERY_HOLD_BLOCK_MESSAGE,
        });
      }

      // A completed Checkout already owns the subscription lifecycle. Starting
      // another Checkout for the same practice can create a second Stripe
      // subscription that charges alongside the first when its trial ends.
      // Terminal subscription webhooks clear this id, so any stored id is the
      // server-side signal to manage the existing subscription instead.
      if (practice.stripeSubscriptionId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "A subscription is already connected. Manage it from Plan & Billing.",
        });
      }

      const counts = await countBillableLocationsAndSeats(ctx.db, ctx.practiceId);

      const base = appBaseUrl();
      const activeTrialEnd =
        practice.billingStatus === "trialing" &&
        practice.trialEndsAt &&
        new Date(practice.trialEndsAt).getTime() > Date.now()
          ? practice.trialEndsAt
          : null;
      // Checkout carries only the per-location licensed item so the clinic
      // sees one clean product. The metered overage items (AI + SMS) are
      // attached to the subscription server-side after creation
      // (syncPracticeSubscriptionQuantities), not shown at checkout.
      const lineItems: Array<{
        priceId: string;
        quantity?: number;
        metered?: boolean;
      }> = [{ priceId: locationPriceId, quantity: counts.locationCount }];
      const customerEmail =
        billingContactEmail(practice.email) ??
        billingContactEmail(ctx.session.user.email);
      const result = await createSubscriptionCheckoutSession({
        lineItems,
        practiceId: ctx.practiceId,
        customerId: practice.stripeCustomerId ?? undefined,
        customerEmail,
        trialEnd: activeTrialEnd,
        trialPeriodDays: activeTrialEnd || practice.trialEndsAt ? undefined : TRIAL_DAYS,
        successUrl:
          input.returnTo === "setup"
            ? `${base}/?setup=resume&checkout=success`
            : `${base}/settings?tab=billing&checkout=success`,
        cancelUrl:
          input.returnTo === "setup"
            ? `${base}/?setup=resume&checkout=cancelled`
            : `${base}/settings?tab=billing&checkout=cancelled`,
      });
      const checkoutUrl = result?.url;
      if (!isSafeCheckoutRedirectUrl(checkoutUrl)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Billing is not configured on this server.",
        });
      }
      return { url: checkoutUrl };
    }),

  /** Open the Stripe Billing Portal to manage/cancel an existing subscription. */
  openBillingPortal: adminProcedure.mutation(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({
        stripeCustomerId: practices.stripeCustomerId,
        recoveryHold: practices.recoveryHold,
      })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1)
      .for("share", { of: practices });

    if (!practice) {
      throw practiceNotFound();
    }
    if (practice.recoveryHold) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: RECOVERY_HOLD_BLOCK_MESSAGE,
      });
    }

    if (!practice.stripeCustomerId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "No billing account yet — start a plan first.",
      });
    }

    const result = await createBillingPortalSession({
      customerId: practice.stripeCustomerId,
      returnUrl: `${appBaseUrl()}/settings?tab=billing`,
    });
    const portalUrl = result?.url;
    if (!isSafeCheckoutRedirectUrl(portalUrl)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Billing is not configured on this server.",
      });
    }
    return { url: portalUrl };
  }),
});
