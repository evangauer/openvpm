import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BuildFlow } from "@/components/build/build-flow";
import {
  billingEnforced,
  cloudCheckoutPriceIds,
  CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  TRIAL_DAYS,
} from "@/lib/billing/plans";
import { newSubscriptionBillingAccount } from "@/lib/billing/stripe-accounts";

export const metadata: Metadata = {
  title: "Build your clinic - OpenVPM",
  description:
    "See OpenVPM with your clinic's name, colors, and services before you start your free trial.",
};

// Reads hosted billing configuration at request time, like registration.
export const dynamic = "force-dynamic";

/**
 * "Build your clinic": the hosted, card-gated signup walkthrough. Self-hosted
 * deployments have no card gate, so they keep the standard registration.
 */
export default function StartPage() {
  if (!billingEnforced()) redirect("/register");
  // Offer annual only when its Stripe price is configured for new signups.
  const annualAvailable = Boolean(
    cloudCheckoutPriceIds("year", newSubscriptionBillingAccount())
      .locationPriceId,
  );
  return (
    <Suspense fallback={null}>
      <BuildFlow
        trialDays={TRIAL_DAYS}
        monthlyPriceUsd={CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}
        annualPriceUsd={
          annualAvailable ? CLOUD_LOCATION_UNIT_PRICE_ANNUAL_USD : null
        }
      />
    </Suspense>
  );
}
