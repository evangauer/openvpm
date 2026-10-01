import RegisterForm from "./register-form";
import {
  billingEnforced,
  noCardTrialEnabled,
  TRIAL_DAYS,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
} from "@/lib/billing/plans";

// Render the same server configuration used by registration, including rollbacks.
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  const hostedBilling = billingEnforced();
  return (
    <RegisterForm
      hostedBilling={hostedBilling}
      cardRequired={hostedBilling && !noCardTrialEnabled()}
      trialDays={TRIAL_DAYS}
      monthlyPriceUsd={CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}
    />
  );
}
