import { stripeConnectApplicationFeeBps } from "@/lib/stripe-config";

export const STRIPE_CONNECT_PROVIDER = "stripe_connect";

export type PaymentAccountStatus =
  | "pending"
  | "active"
  | "action_required"
  | "disabled";

export type StripeConnectAccountState = {
  onboardingStatus: PaymentAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
  requirementsDisabledReason: string | null;
  lastSyncedAt: Date;
};

type StripeConnectAccountLike = {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  requirements?: {
    currently_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
};

export function stripeConnectApplicationFeeAmount(
  paymentAmountCents: number
): number | undefined {
  const bps = stripeConnectApplicationFeeBps();
  if (bps <= 0 || paymentAmountCents <= 0) return undefined;
  return Math.floor((paymentAmountCents * bps) / 10_000);
}

export function stripeConnectAccountState(
  account: StripeConnectAccountLike
): StripeConnectAccountState {
  const requirementsCurrentlyDue = [...(account.requirements?.currently_due ?? [])];
  const disabledReason = account.requirements?.disabled_reason ?? null;
  const chargesEnabled = Boolean(account.charges_enabled);
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);

  let onboardingStatus: PaymentAccountStatus = "pending";
  if (disabledReason) {
    onboardingStatus = "disabled";
  } else if (chargesEnabled && payoutsEnabled) {
    onboardingStatus = "active";
  } else if (requirementsCurrentlyDue.length > 0) {
    onboardingStatus = "action_required";
  }

  return {
    onboardingStatus,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    requirementsCurrentlyDue,
    requirementsDisabledReason: disabledReason,
    lastSyncedAt: new Date(),
  };
}
