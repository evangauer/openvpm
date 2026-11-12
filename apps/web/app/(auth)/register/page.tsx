import RegisterForm from "./register-form";
import {
  billingEnforced,
  noCardTrialEnabled,
  TRIAL_DAYS,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
} from "@/lib/billing/plans";
import { previewPercent } from "@/lib/billing/preview";
import { builderPercent } from "@/lib/build/catalog";
import { redirect } from "next/navigation";
import { acquisitionFromSearchParams } from "@/lib/acquisition";
import { usesClinicBuilder } from "@/lib/registration-entry";

// Render the same server configuration used by registration, including rollbacks.
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hostedBilling = billingEnforced();
  const cardRequired = hostedBilling && !noCardTrialEnabled();
  const builderShare = builderPercent();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }
  if (
    usesClinicBuilder({
      cardRequired,
      builderPercent: builderShare,
      funnelId: acquisitionFromSearchParams(params)?.funnelId,
    })
  ) {
    redirect(`/start?${params.toString()}`);
  }
  return (
    <RegisterForm
      hostedBilling={hostedBilling}
      cardRequired={cardRequired}
      trialDays={TRIAL_DAYS}
      previewPercent={previewPercent()}
      builderPercent={builderShare}
      monthlyPriceUsd={CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}
    />
  );
}
