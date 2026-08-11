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
import { hasFirstRealVisit } from "@/lib/billing/first-real-visit";
import {
  verifySubscriptionCheckoutAttributionToken,
  type SubscriptionCheckoutSource,
} from "@/lib/billing/checkout-attribution";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIPE_TRIAL_END_MIN_LEAD_MS = 2 * DAY_MS;
const STRIPE_TRIAL_END_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const LATE_TRIAL_CHECKOUT_GRACE_DAYS = 3;

type CheckoutTrialTerms = {
  trialEnd: Date | string | null;
  trialPeriodDays: number | undefined;
};

/**
 * Derive mutually exclusive Stripe Checkout trial terms from durable practice
 * state. Checkout rejects a custom trial_end that is less than 48 hours away,
 * so a still-active trial near that boundary receives a deterministic three-day
 * grace. The grace is independent of the current instant, keeping repeated
 * near-expiry Checkout attempts on identical provider parameters.
 */
export function subscriptionCheckoutTrialTerms(input: {
  billingStatus: string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
  now: Date;
}): CheckoutTrialTerms {
  const { billingStatus, trialEndsAt, now } = input;
  if (billingStatus === "trialing" && trialEndsAt) {
    const trialEndMs = new Date(trialEndsAt).getTime();
    const remainingMs = trialEndMs - now.getTime();
    if (
      Number.isFinite(remainingMs) &&
      remainingMs > 0 &&
      remainingMs >=
        STRIPE_TRIAL_END_MIN_LEAD_MS + STRIPE_TRIAL_END_SAFETY_BUFFER_MS
    ) {
      return { trialEnd: trialEndsAt, trialPeriodDays: undefined };
    }
    if (Number.isFinite(remainingMs) && remainingMs > 0) {
      return {
        trialEnd: null,
        trialPeriodDays: LATE_TRIAL_CHECKOUT_GRACE_DAYS,
      };
    }
  }

  // Any stored end is historical trial evidence. Never grant another trial to
  // an expired, canceled, or otherwise non-trialing practice.
  if (trialEndsAt) {
    return { trialEnd: null, trialPeriodDays: undefined };
  }

  return { trialEnd: null, trialPeriodDays: TRIAL_DAYS };
}

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
      ctx.practiceId,
    );
    const period = currentPeriodMonth();
    const [smsUsed, aiUsed] = enforced
      ? await Promise.all([
          usageForPractice(ctx.practiceId, "sms", period),
          usageForPractice(ctx.practiceId, "ai_run", period),
        ])
      : [0, 0];

    const hasSubscription = !!practice.stripeSubscriptionId;
    // A current subscription identity is linked only from signed Stripe
    // callbacks or authoritative reconciliation. The Stripe Customer is only
    // a transport identity and does not prove Checkout or setup completed.
    const billingSetupCompleted = hasSubscription;

    return {
      tier: practice.tier ?? "free",
      billingStatus: practice.billingStatus ?? "none",
      trialEndsAt: practice.trialEndsAt ?? null,
      timezone: practice.timezone ?? null,
      hasStripeCustomer: !!practice.stripeCustomerId,
      hasSubscription,
      billingSetupCompleted,
      // Compatibility alias for older consumers. A Stripe Customer is not
      // evidence that Checkout completed or that a subscription is connected.
      hasBillingAccount: billingSetupCompleted,
      billingEnforced: enforced,
      hasFullAccess: hasHostedFullAccess(
        practice.tier,
        practice.billingStatus,
        practice.trialEndsAt,
      ),
      locationCount: counts.locationCount,
      billableSeatCount: counts.billableSeatCount,
      locationUnitPriceMonthlyUsd: CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
      seatUnitPriceMonthlyUsd: CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
      estimatedMonthlyBase: estimatedCloudBaseMonthlyUsd(
        counts.locationCount,
        counts.billableSeatCount,
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
        attributionToken: z.string().trim().min(1).max(4096).optional(),
      }),
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

      const counts = await countBillableLocationsAndSeats(
        ctx.db,
        ctx.practiceId,
      );

      const firstVisitCompleted = await hasFirstRealVisit(
        ctx.db,
        ctx.practiceId,
      );
      const signedAttribution = input.attributionToken
        ? verifySubscriptionCheckoutAttributionToken(
            input.attributionToken,
            ctx.practiceId,
          )
        : null;
      if (input.attributionToken && !signedAttribution) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This billing link is invalid or expired. Open billing again.",
        });
      }
      if (
        signedAttribution?.source === "first_visit_email" &&
        !firstVisitCompleted
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This first-visit billing link is no longer eligible.",
        });
      }
      const checkoutSource: SubscriptionCheckoutSource = signedAttribution
        ? signedAttribution.source
        : firstVisitCompleted
          ? "in_app_post_first_visit"
          : "in_app_pre_first_visit";
      const checkoutSourceEvidenceId =
        signedAttribution?.evidenceId ?? "server-derived:v1";

      const base = appBaseUrl();
      const trialTerms = subscriptionCheckoutTrialTerms({
        billingStatus: practice.billingStatus,
        trialEndsAt: practice.trialEndsAt,
        now: new Date(),
      });
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
        trialEnd: trialTerms.trialEnd,
        trialPeriodDays: trialTerms.trialPeriodDays,
        checkoutSource,
        checkoutSourceEvidenceId,
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
