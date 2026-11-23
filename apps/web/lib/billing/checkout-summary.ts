import type { PlanDefinition } from "@/lib/billing/plans";
import {
  getPlan,
  isTrialActive,
  TRIAL_DAYS,
  trialEndsAtFrom,
} from "@/lib/billing/plans";
import {
  CLOUD_ANNUAL_PRICE_USD,
  CLOUD_MONTHLY_PRICE_USD,
  type BillingCadence,
} from "@/lib/billing/catalog";

/**
 * Checkout copy uses the same clinic-day clock as `trialEndOfCalendarDay`.
 * Stripe's `trial_period_days` ends on this calendar date in Eastern Time.
 */
export const CHECKOUT_TRIAL_TIME_ZONE = "America/New_York";

/** Where a cancelled signup goes so the next click opens Stripe Checkout. */
export const RESUME_CHECKOUT_PATH =
  "/settings?tab=billing&resume=checkout&plan=month";

const DAY_MS = 24 * 60 * 60 * 1000;

function finitePositive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function formatCheckoutAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/**
 * Monthly Cloud price for pre-checkout copy. A caller-supplied configured
 * price wins; otherwise the plan's monthly location price; otherwise the
 * catalog amount carried on that plan.
 */
export function resolveCheckoutMonthlyPriceUsd(input?: {
  configuredPriceUsd?: number | null;
  plan?: Pick<PlanDefinition, "locationUnitPriceMonthlyUsd"> | null;
}): number {
  const configured = finitePositive(input?.configuredPriceUsd);
  if (configured != null) return configured;
  const metadata = finitePositive(
    (input?.plan ?? getPlan("cloud")).locationUnitPriceMonthlyUsd,
  );
  if (metadata != null) return metadata;
  return CLOUD_MONTHLY_PRICE_USD;
}

/** Annual Cloud price. Configured amount, otherwise the catalog price. */
export function resolveCheckoutAnnualPriceUsd(input?: {
  configuredPriceUsd?: number | null;
}): number {
  return finitePositive(input?.configuredPriceUsd) ?? CLOUD_ANNUAL_PRICE_USD;
}

export function formatCheckoutPriceLabel(
  amount: number,
  cadence: BillingCadence = "month",
): string {
  const suffix = cadence === "year" ? "/yr" : "/mo";
  return `$${formatCheckoutAmount(amount)}${suffix}`;
}

/** Format a trial end on the Eastern Time calendar day Stripe will charge. */
export function formatCheckoutTrialEnd(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CHECKOUT_TRIAL_TIME_ZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Instant Stripe stores as `trial_end` when Checkout is given
 * `trial_period_days` and no explicit end. The displayed calendar day is this
 * instant in America/New_York, which is also the day `trialEndsAtFrom` closes.
 */
export function stripeTrialPeriodEnd(
  from: Date,
  days: number = TRIAL_DAYS,
): Date {
  return new Date(from.getTime() + Math.max(0, days) * DAY_MS);
}

/**
 * Trial end shown before Checkout. An in-progress trial keeps the timestamp
 * Stripe will receive as `trial_end`. A new trial uses `trialEndsAtFrom`,
 * whose Eastern Time date matches `trial_period_days`.
 */
export function resolveDisplayedTrialEnd(input?: {
  now?: Date;
  existingTrialEndsAt?: Date | string | null;
}): Date {
  const now = input?.now ?? new Date();
  if (input?.existingTrialEndsAt) {
    const existing = new Date(input.existingTrialEndsAt);
    if (!Number.isNaN(existing.getTime()) && existing.getTime() > now.getTime()) {
      return existing;
    }
  }
  return trialEndsAtFrom(now);
}

export interface CheckoutTrialSummary {
  trialEndsAt: Date;
  trialEndLabel: string;
  priceUsd: number;
  priceLabel: string;
  cadence: BillingCadence;
  text: string;
}

export function checkoutTrialSummary(input?: {
  now?: Date;
  configuredPriceUsd?: number | null;
  plan?: Pick<PlanDefinition, "locationUnitPriceMonthlyUsd"> | null;
  cadence?: BillingCadence;
  existingTrialEndsAt?: Date | string | null;
}): CheckoutTrialSummary {
  const cadence = input?.cadence ?? "month";
  const priceUsd =
    cadence === "year"
      ? resolveCheckoutAnnualPriceUsd({
          configuredPriceUsd: input?.configuredPriceUsd,
        })
      : resolveCheckoutMonthlyPriceUsd({
          configuredPriceUsd: input?.configuredPriceUsd,
          plan: input?.plan,
        });
  const trialEndsAt = resolveDisplayedTrialEnd({
    now: input?.now,
    existingTrialEndsAt: input?.existingTrialEndsAt,
  });
  const trialEndLabel = formatCheckoutTrialEnd(trialEndsAt);
  const priceLabel = formatCheckoutPriceLabel(priceUsd, cadence);
  return {
    trialEndsAt,
    trialEndLabel,
    priceUsd,
    priceLabel,
    cadence,
    text: `$0 today, trial ends ${trialEndLabel}, then ${priceLabel}`,
  };
}

/**
 * Resume Checkout is for clinics that still need a first subscription and are
 * not inside an active or trialing window. Active and trialing practices are
 * hidden even when the stored trial date is missing or already past.
 */
export function canResumeHostedCheckout(input: {
  billingEnforced?: boolean;
  hasSubscription: boolean;
  billingStatus?: string | null;
  trialEndsAt?: Date | string | null;
  now?: Date;
}): boolean {
  if (input.billingEnforced === false) return false;
  if (input.hasSubscription) return false;
  const status = input.billingStatus ?? "none";
  if (status === "active" || status === "trialing") return false;
  if (isTrialActive(status, input.trialEndsAt, input.now ?? new Date())) {
    return false;
  }
  return true;
}
