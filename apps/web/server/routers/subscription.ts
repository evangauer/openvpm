import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { createBillingPortalSession } from "@/lib/stripe";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import {
  PLANS,
  PLAN_ORDER,
  billingEnforced,
  cloudCheckoutPriceIds,
  cloudLocationPriceIds,
  cloudMeteredPriceIds,
  estimatedCloudBaseAnnualUsd,
  estimatedCloudBaseMonthlyUsd,
  CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  hasHostedFullAccess,
} from "@/lib/billing/plans";
import { BILLING_CADENCES, CLOUD_BILLING_OPTIONS } from "@/lib/billing/catalog";
import { usageForPractice, currentPeriodMonth } from "@/lib/billing/usage";
import {
  countBillableLocationsAndSeats,
  readBillingSyncState,
  type BillingSyncState,
} from "@/lib/billing/subscription-sync";
import { appBaseUrl } from "@/lib/app-url";
import { billingContactEmail } from "@/lib/billing/contact";
import { RECOVERY_HOLD_BLOCK_MESSAGE } from "@/lib/recovery-hold";
import {
  dispatchSubscriptionCheckoutAttempt,
  readSubscriptionSetupSnapshot,
  reserveSubscriptionCheckoutAttempt,
  subscriptionCheckoutTrialTerms,
} from "@/lib/billing/subscription-checkout-attempts";
import { withTenant } from "@/lib/tenant-db";
import {
  CadenceOperationError,
  dispatchAnnualCadenceOperation,
  readCadenceOperationStatus,
  reserveAnnualCadenceOperation,
  type CadenceOperationStatus,
} from "@/lib/billing/subscription-cadence-operations";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

/** Whether a tier can be bought self-serve (Stripe price configured). */
function purchasable(tier: keyof typeof PLANS): boolean {
  if (tier !== "cloud") return false;
  return cloudLocationPriceIds().length > 0;
}

export const subscriptionRouter = createRouter({
  /** Current plan + status, plus the catalog for display. */
  get: adminProcedure.query(async ({ ctx }) => {
    const enforced = billingEnforced();
    const practice = await readSubscriptionSetupSnapshot(
      ctx.db,
      ctx.practiceId,
      enforced,
    );
    if (!practice) {
      throw practiceNotFound();
    }

    const counts = await countBillableLocationsAndSeats(ctx.db, ctx.practiceId);
    const billingSync: BillingSyncState | null = await readBillingSyncState(
      ctx.db,
      ctx.practiceId,
    );
    const cadenceOperation = await readCadenceOperationStatus(
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

    return {
      tier: practice.tier ?? "free",
      billingStatus: practice.billingStatus ?? "none",
      trialEndsAt: practice.trialEndsAt ?? null,
      timezone: practice.timezone ?? null,
      ...practice.setup,
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
      estimatedAnnualBase: estimatedCloudBaseAnnualUsd(
        counts.locationCount,
        counts.billableSeatCount,
      ),
      annualLocationUnitPriceUsd: CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD,
      currentBillingCadence: billingSync?.billingCadence ?? null,
      cadenceOperation,
      billingOptions: CLOUD_BILLING_OPTIONS.map((option) => ({
        ...option,
        totalUsd:
          option.cadence === "year"
            ? estimatedCloudBaseAnnualUsd(
                counts.locationCount,
                counts.billableSeatCount,
              )
            : estimatedCloudBaseMonthlyUsd(
                counts.locationCount,
                counts.billableSeatCount,
              ),
        purchasable: !!cloudCheckoutPriceIds(option.cadence).locationPriceId,
      })),
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

  /** Narrow, provider-free status used only for bounded Checkout-return polling. */
  getSetupStatus: adminProcedure.query(async ({ ctx }) => {
    const practice = await readSubscriptionSetupSnapshot(
      ctx.db,
      ctx.practiceId,
      billingEnforced(),
    );
    if (!practice) throw practiceNotFound();
    return practice.setup;
  }),

  /** Start a Stripe Checkout for the self-serve Cloud plan. */
  createCheckout: adminProcedure
    .input(
      z.object({
        tier: z.enum(["cloud"]).default("cloud"),
        billingCadence: z.enum(BILLING_CADENCES).default("month"),
        // Where Stripe sends the admin back: the billing page (default) or
        // the guided setup, which resumes where they left off.
        returnTo: z.enum(["settings", "setup"]).default("settings"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const plan = PLANS[input.tier];
      const { locationPriceId } = cloudCheckoutPriceIds(input.billingCadence);
      if (!plan.selfServe || !locationPriceId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This plan isn't available for checkout yet.",
        });
      }

      const practice = await readSubscriptionSetupSnapshot(
        ctx.db,
        ctx.practiceId,
        true,
      );
      if (!practice) {
        throw practiceNotFound();
      }
      if (practice.setup.billingSetupState === "blocked_recovery") {
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
      if (practice.setup.billingSetupCompleted) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "A subscription is already connected. Manage it from Plan & Billing.",
        });
      }
      if (practice.setup.checkoutAction === null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            practice.setup.billingSetupState === "confirming"
              ? "Billing setup is already being confirmed. Wait for the current attempt to finish."
              : "Billing setup needs review before another Checkout can start.",
        });
      }

      const counts = await countBillableLocationsAndSeats(
        ctx.db,
        ctx.practiceId,
      );

      const base = appBaseUrl();
      const now = new Date();
      const trialTerms = subscriptionCheckoutTrialTerms({
        billingStatus: practice.billingStatus,
        trialEndsAt: practice.trialEndsAt,
        now,
      });
      // Checkout carries only the per-location licensed item so the clinic
      // sees one clean product. The metered overage items (AI + SMS) are
      // attached to the subscription server-side after creation
      // (syncPracticeSubscriptionQuantities), not shown at checkout.
      const practiceBillingEmail = billingContactEmail(practice.email);
      const userBillingEmail = billingContactEmail(ctx.session.user.email);
      const customerEmail = practiceBillingEmail ?? userBillingEmail;
      const customerIdentitySource = practice.stripeCustomerId
        ? "stripe_customer"
        : practiceBillingEmail
          ? "practice_email"
          : "user_email";
      const successUrl =
        input.returnTo === "setup"
          ? `${base}/?setup=resume&checkout=success`
          : `${base}/settings?tab=billing&checkout=success&plan=${input.billingCadence}`;
      const cancelUrl =
        input.returnTo === "setup"
          ? `${base}/?setup=resume&checkout=cancelled`
          : `${base}/settings?tab=billing&checkout=cancelled&plan=${input.billingCadence}`;
      const reservation = await reserveSubscriptionCheckoutAttempt(ctx.db, {
        practiceId: ctx.practiceId,
        locationPriceId,
        locationQuantity: counts.locationCount,
        customerId: practice.stripeCustomerId,
        customerEmail: practice.stripeCustomerId ? null : customerEmail,
        customerIdentitySource,
        customerIdentityUserId:
          customerIdentitySource === "user_email" ? ctx.session.user.id : null,
        trialEnd: trialTerms.trialEnd,
        trialPeriodDays: trialTerms.trialPeriodDays,
        billingCadence: input.billingCadence,
        source: "settings",
        returnTarget: input.returnTo,
        successUrl,
        cancelUrl,
      });
      const response: { url: string | null } = { url: null };
      if (!ctx.postCommitEffect) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Billing checkout could not be scheduled safely.",
        });
      }
      ctx.postCommitEffect(async (rootDb) => {
        const dispatched = await dispatchSubscriptionCheckoutAttempt(
          rootDb,
          reservation,
          now,
        );
        response.url = isSafeCheckoutRedirectUrl(dispatched.url)
          ? dispatched.url
          : null;
      });
      return response;
    }),

  /** Open the Stripe Billing Portal to manage/cancel an existing subscription. */
  openBillingPortal: adminProcedure.mutation(async ({ ctx }) => {
    const practice = await readSubscriptionSetupSnapshot(
      ctx.db,
      ctx.practiceId,
      true,
    );
    if (!practice) {
      throw practiceNotFound();
    }
    if (practice.setup.billingSetupState === "blocked_recovery") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: RECOVERY_HOLD_BLOCK_MESSAGE,
      });
    }

    if (!practice.setup.canManageBilling || !practice.stripeCustomerId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "No connected subscription is available to manage. Review billing setup first.",
      });
    }

    if (!ctx.postCommitEffect) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Billing management could not be scheduled safely.",
      });
    }
    const response: { url: string | null } = { url: null };
    ctx.postCommitEffect(async (rootDb) => {
      const current = await withTenant(rootDb, ctx.practiceId, (tx) =>
        readSubscriptionSetupSnapshot(tx, ctx.practiceId, true),
      );
      if (!current?.setup.canManageBilling || !current.stripeCustomerId) return;
      const result = await createBillingPortalSession({
        customerId: current.stripeCustomerId,
        returnUrl: `${appBaseUrl()}/settings?tab=billing`,
      });
      response.url = isSafeCheckoutRedirectUrl(result?.url)
        ? result!.url!
        : null;
    });
    return response;
  }),

  /** Schedule a monthly subscription to become annual at its exact renewal. */
  scheduleAnnualAtRenewal: adminProcedure.mutation(async ({ ctx }) => {
    if (!billingEnforced()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Hosted billing is not enabled for this deployment.",
      });
    }
    const monthlyPriceId = cloudCheckoutPriceIds("month").locationPriceId;
    const annualPriceId = cloudCheckoutPriceIds("year").locationPriceId;
    const { aiOveragePriceId, smsOveragePriceId } = cloudMeteredPriceIds();
    const allowedCompanionPriceIds = [
      aiOveragePriceId,
      smsOveragePriceId,
    ].filter((priceId): priceId is string => Boolean(priceId));
    if (!monthlyPriceId || !annualPriceId) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Monthly and annual hosted billing are not both configured.",
      });
    }
    if (!ctx.postCommitEffect) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The billing change could not be scheduled safely.",
      });
    }

    let reservation: { operationId: string; reused: boolean };
    try {
      reservation = await reserveAnnualCadenceOperation(ctx.db, {
        practiceId: ctx.practiceId,
        requestedBy: ctx.session.user.id,
        monthlyPriceId,
        annualPriceId,
      });
    } catch (error) {
      if (error instanceof CadenceOperationError) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: error.message,
        });
      }
      throw error;
    }

    const response: CadenceOperationStatus & { reused: boolean } = {
      operationId: reservation.operationId,
      state: "processing",
      requestedCadence: "year",
      effectiveAt: null,
      errorCode: null,
      reused: reservation.reused,
    };
    ctx.postCommitEffect(async (rootDb) => {
      const dispatched = await dispatchAnnualCadenceOperation(
        rootDb,
        reservation.operationId,
        { monthlyPriceId, allowedCompanionPriceIds },
      );
      Object.assign(response, dispatched);
    });
    return response;
  }),
});
