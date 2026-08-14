/**
 * Hosted plan model + entitlements.
 *
 * Open-source posture: the OSS / self-host edition is NEVER crippled. Billing is
 * OFF by default (`HOSTED_BILLING_ENABLED` unset) — self-host runs without
 * hosted subscription gates. We monetize hosting + scale (locations) + heavy
 * usage, not by locking the open core.
 *
 * Pricing (managed Cloud): ONE simple self-serve tier — flat $79/mo or
 * $790/yr per active location, unlimited staff. Hosted entitlements are included while
 * trialing/active, with generous included SMS / AI allowances and metered
 * overage beyond. Enterprise = custom.
 */

import { envFlagEnabled } from "@/lib/env-bool";
import {
  CLOUD_ANNUAL_PRICE_USD,
  CLOUD_MONTHLY_PRICE_USD,
  type BillingCadence,
} from "@/lib/billing/catalog";
import { trialEndOfCalendarDay } from "@/lib/billing/trial-days";

export type PlanTier = "free" | "cloud" | "enterprise";

/**
 * Legacy tier strings (from the earlier starter/pro model) map onto `cloud`, so
 * existing practice rows and any old Stripe prices keep resolving cleanly.
 */
const LEGACY_CLOUD_TIERS = new Set(["starter", "pro", "professional"]);

/** Capabilities. With feature parity these are unlocked on every paid tier. */
export type Feature =
  | "agent" // OpenVPM Agent (AI)
  | "sms" // SMS sending
  | "advancedReporting"
  | "apiAccess" // public /api/v1 + webhooks
  | "multiLocation"
  | "integrations";

export const ALL_FEATURES: Feature[] = [
  "agent",
  "sms",
  "advancedReporting",
  "apiAccess",
  "multiLocation",
  "integrations",
];

/** Managed Cloud list price: flat per active location, unlimited staff. */
export const CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD = CLOUD_MONTHLY_PRICE_USD;
/** Annual founding price: two months free versus twelve monthly payments. */
export const CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD = CLOUD_ANNUAL_PRICE_USD;
/** No per-seat charge under the flat model (kept at 0 for type/back-compat). */
export const CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD = 0;

/**
 * Metered overage list prices (USD per unit) beyond the included monthly
 * allowance. Set ~2-3x our marginal cost so heavy users stay margin-positive
 * while the price is still cheap and transparent for the clinic. The included
 * allowance is modeled as the $0 first tier on the Stripe metered price, so
 * these only bill past `includedAiRunsPerMonth` / `includedSmsPerMonth`.
 */
export const CLOUD_AI_OVERAGE_PRICE_USD = 0.05;
export const CLOUD_SMS_OVERAGE_PRICE_USD = 0.03;

/** Env vars holding Stripe Price IDs for hosted billing (PRIVATE). */
export const STRIPE_PRICE_CLOUD_LOCATION_ENV = "STRIPE_PRICE_CLOUD_LOCATION";
export const STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV =
  "STRIPE_PRICE_CLOUD_LOCATION_ANNUAL";
export const STRIPE_PRICE_CLOUD_USER_ENV = "STRIPE_PRICE_CLOUD_USER";
/** Legacy one-price Cloud env. Kept only for old subscription/webhook mapping. */
export const STRIPE_PRICE_CLOUD_LEGACY_ENV = "STRIPE_PRICE_CLOUD";
export const STRIPE_PRICE_SMS_OVERAGE_ENV = "STRIPE_PRICE_SMS_OVERAGE";
export const STRIPE_PRICE_AI_OVERAGE_ENV = "STRIPE_PRICE_AI_OVERAGE";

function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function stripePriceIdFromEnv(name: string): string | undefined {
  return nonBlank(process.env[name]);
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** Monthly location unit price in USD. null = custom / contact sales. */
  locationUnitPriceMonthlyUsd: number | null;
  /** Monthly staff-seat unit price in USD. null = custom / contact sales. */
  seatUnitPriceMonthlyUsd: number | null;
  blurb: string;
  /** Max staff seats. null = unlimited. */
  seatLimit: number | null;
  /** Max locations. null = unlimited (billed by quantity). */
  locationLimit: number | null;
  /** Premium features included in this tier. */
  features: Feature[];
  /** Included monthly SMS before metered overage. null = unlimited/custom. */
  includedSmsPerMonth: number | null;
  /** Included monthly AI agent runs before metered overage. null = unlimited/custom. */
  includedAiRunsPerMonth: number | null;
  /** USD per AI action beyond the included allowance. null = no metered overage. */
  aiOveragePriceUsd: number | null;
  /** USD per SMS beyond the included allowance. null = no metered overage. */
  smsOveragePriceUsd: number | null;
  /** Env var holding the recurring location Stripe Price ID for this tier. */
  stripeLocationPriceEnv?: string;
  /** Env var holding the recurring staff-user Stripe Price ID for this tier. */
  stripeSeatPriceEnv?: string;
  /** Whether this tier is self-serve purchasable (vs. contact sales). */
  selfServe: boolean;
}

export const PLANS: Record<PlanTier, PlanDefinition> = {
  free: {
    // Self-host gets the ungated app via billingEnforced()=false,
    // NOT via this feature list. On hosted, `free` is also the lapsed/unpaid
    // fallback tier — so its entitlements MUST be empty to gate non-payers.
    tier: "free",
    name: "Free (self-host)",
    locationUnitPriceMonthlyUsd: 0,
    seatUnitPriceMonthlyUsd: 0,
    blurb:
      "Self-host OpenVPM on your own infrastructure. Free forever, no lock-in.",
    seatLimit: null,
    locationLimit: null,
    features: [],
    includedSmsPerMonth: 0,
    includedAiRunsPerMonth: 0,
    aiOveragePriceUsd: null,
    smsOveragePriceUsd: null,
    selfServe: true,
  },
  cloud: {
    tier: "cloud",
    name: "Cloud",
    locationUnitPriceMonthlyUsd: CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
    seatUnitPriceMonthlyUsd: CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
    blurb:
      "We host the managed PIMS: agent access, SMS-ready shared inbox, reporting, scoped API/webhooks, multi-location tools, and supported integration hooks. $79/mo or $790/yr per location, unlimited staff.",
    seatLimit: null, // unlimited staff under the flat model
    locationLimit: null, // billed by location quantity, not capped
    features: [...ALL_FEATURES],
    includedSmsPerMonth: 1000,
    includedAiRunsPerMonth: 1000,
    aiOveragePriceUsd: CLOUD_AI_OVERAGE_PRICE_USD,
    smsOveragePriceUsd: CLOUD_SMS_OVERAGE_PRICE_USD,
    stripeLocationPriceEnv: STRIPE_PRICE_CLOUD_LOCATION_ENV,
    stripeSeatPriceEnv: STRIPE_PRICE_CLOUD_USER_ENV,
    selfServe: true,
  },
  enterprise: {
    tier: "enterprise",
    name: "Enterprise",
    locationUnitPriceMonthlyUsd: null,
    seatUnitPriceMonthlyUsd: null,
    blurb:
      "Dedicated or in-region instance, SSO, BAA/DPA compliance, white-glove migration, and priority support.",
    seatLimit: null,
    locationLimit: null,
    features: [...ALL_FEATURES],
    includedSmsPerMonth: null,
    includedAiRunsPerMonth: null,
    aiOveragePriceUsd: null,
    smsOveragePriceUsd: null,
    selfServe: false,
  },
};

export const PLAN_ORDER: PlanTier[] = ["free", "cloud", "enterprise"];

export function getPlan(tier?: string | null): PlanDefinition {
  const t = tier ?? "free";
  if (LEGACY_CLOUD_TIERS.has(t)) return PLANS.cloud;
  return PLANS[t as PlanTier] ?? PLANS.free;
}

/** Map a Stripe Price ID back to a plan tier (via the configured env vars). */
export function tierForStripePrice(
  priceId: string | null | undefined,
): PlanTier | null {
  const normalizedPriceId = nonBlank(priceId);
  if (!normalizedPriceId) return null;
  const cloudPriceEnvs = [
    STRIPE_PRICE_CLOUD_LOCATION_ENV,
    STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV,
    STRIPE_PRICE_CLOUD_USER_ENV,
    STRIPE_PRICE_CLOUD_LEGACY_ENV,
  ];
  for (const env of cloudPriceEnvs) {
    if (stripePriceIdFromEnv(env) === normalizedPriceId) return "cloud";
  }
  return null;
}

export function cloudCheckoutPriceIds(cadence: BillingCadence = "month"): {
  locationPriceId?: string;
  seatPriceId?: string;
} {
  return {
    locationPriceId: stripePriceIdFromEnv(
      cadence === "year"
        ? STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV
        : STRIPE_PRICE_CLOUD_LOCATION_ENV,
    ),
    seatPriceId: stripePriceIdFromEnv(STRIPE_PRICE_CLOUD_USER_ENV),
  };
}

/** Configured licensed Cloud prices that quantity sync may encounter. */
export function cloudLocationPriceIds(): Array<{
  cadence: BillingCadence;
  priceId: string;
}> {
  return (["month", "year"] as const).flatMap((cadence) => {
    const priceId = cloudCheckoutPriceIds(cadence).locationPriceId;
    return priceId ? [{ cadence, priceId }] : [];
  });
}

/** Map a configured Cloud location Price back to its billing cadence. */
export function billingCadenceForStripePrice(
  priceId: string | null | undefined,
): BillingCadence | null {
  const normalizedPriceId = nonBlank(priceId);
  if (!normalizedPriceId) return null;
  return (
    cloudLocationPriceIds().find((entry) => entry.priceId === normalizedPriceId)
      ?.cadence ?? null
  );
}

/**
 * Metered overage Stripe Price IDs (AI + SMS), if configured. These are added
 * as additional, quantity-less subscription items at checkout so Stripe meters
 * usage and bills overage beyond the included allowance. Absent = no overage
 * billing wired (the app still records usage and alerts ops on spikes).
 */
export function cloudMeteredPriceIds(): {
  aiOveragePriceId?: string;
  smsOveragePriceId?: string;
} {
  return {
    aiOveragePriceId: stripePriceIdFromEnv(STRIPE_PRICE_AI_OVERAGE_ENV),
    smsOveragePriceId: stripePriceIdFromEnv(STRIPE_PRICE_SMS_OVERAGE_ENV),
  };
}

export function estimatedCloudBaseMonthlyUsd(
  locationCount: number,
  billableSeatCount: number,
): number {
  return (
    Math.max(1, locationCount) * CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD +
    Math.max(0, billableSeatCount) * CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
  );
}

export function estimatedCloudBaseAnnualUsd(
  locationCount: number,
  billableSeatCount: number,
): number {
  return (
    Math.max(1, locationCount) * CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD +
    Math.max(0, billableSeatCount) * CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
  );
}

/** Normalize a Stripe subscription status to our billingStatus values. */
export function normalizeBillingStatus(
  status: string | null | undefined,
): string {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return status ?? "none";
  }
}

/** Pure: does this tier include this feature? (With parity, every paid tier does.) */
export function planHasFeature(
  tier: string | null | undefined,
  feature: Feature,
): boolean {
  return getPlan(tier).features.includes(feature);
}

/** Length of the new-practice free trial on the hosted service. */
export const TRIAL_DAYS = 14;

/**
 * Whether hosted signups start a card-free trial. This is the DEFAULT: a new
 * practice is granted a `trialing` window at signup with NO Stripe
 * subscription — the user lands straight in the product and only enters card
 * details to convert. Set HOSTED_NO_CARD_TRIAL=false to reinstate the legacy
 * card-collected Stripe Checkout wall at signup (kept as a reversible lever
 * while we gather conversion data).
 */
export function noCardTrialEnabled(): boolean {
  return process.env.HOSTED_NO_CARD_TRIAL?.trim().toLowerCase() !== "false";
}

/** The trial-end timestamp for a trial starting now (or at `from`). */
export function trialEndsAtFrom(from: Date = new Date()): Date {
  return trialEndOfCalendarDay(TRIAL_DAYS, "America/New_York", from);
}

/** Whether a practice is in an unexpired trial window. */
export function isTrialActive(
  billingStatus: string | null | undefined,
  trialEndsAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (billingStatus !== "trialing" || !trialEndsAt) return false;
  return new Date(trialEndsAt).getTime() > now.getTime();
}

/**
 * Hosted write access: active trial, active paid/custom subscription, or a
 * paid/custom subscription in Stripe's retrying `past_due` state. Stripe's
 * terminal `unpaid` state remains read-only.
 */
export function hasHostedFullAccess(
  tier: string | null | undefined,
  billingStatus: string | null | undefined,
  trialEndsAt: Date | string | null | undefined,
  now: Date = new Date(),
  enforced: boolean = billingEnforced(),
): boolean {
  if (!enforced) return true;
  if (isTrialActive(billingStatus, trialEndsAt, now)) return true;
  if (billingStatus !== "active" && billingStatus !== "past_due") return false;
  return getPlan(tier).tier !== "free";
}

/**
 * The tier whose entitlements actually apply right now. An active trial grants
 * full Cloud access; once it lapses we fall back to the stored tier.
 */
export function effectiveTier(
  tier: string | null | undefined,
  billingStatus: string | null | undefined,
  trialEndsAt: Date | string | null | undefined,
  now: Date = new Date(),
): PlanTier {
  if (isTrialActive(billingStatus, trialEndsAt, now)) return "cloud";
  const t = tier ?? "free";
  if (LEGACY_CLOUD_TIERS.has(t)) return "cloud";
  return PLANS[t as PlanTier] ? (t as PlanTier) : "free";
}

/**
 * Whether hosted billing is enforced (i.e. we're the managed service). Off by
 * default so self-host / OSS runs with everything unlocked.
 */
export function billingEnforced(): boolean {
  return envFlagEnabled("HOSTED_BILLING_ENABLED");
}

/**
 * Effective entitlement check. When billing is not enforced (self-host), every
 * feature is entitled. `enforced` is injectable for testing.
 */
export function isEntitled(
  tier: string | null | undefined,
  feature: Feature,
  enforced: boolean = billingEnforced(),
): boolean {
  if (!enforced) return true;
  return planHasFeature(tier, feature);
}

/** Seat-limit check. Unlimited (null) or self-host (not enforced) always passes. */
export function withinSeatLimit(
  tier: string | null | undefined,
  currentSeats: number,
  enforced: boolean = billingEnforced(),
): boolean {
  if (!enforced) return true;
  const limit = getPlan(tier).seatLimit;
  return limit === null || currentSeats < limit;
}

/** Location-limit check. Unlimited (null) or self-host (not enforced) always passes. */
export function withinLocationLimit(
  tier: string | null | undefined,
  currentLocations: number,
  enforced: boolean = billingEnforced(),
): boolean {
  if (!enforced) return true;
  const limit = getPlan(tier).locationLimit;
  return limit === null || currentLocations < limit;
}
