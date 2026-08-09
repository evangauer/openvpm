import { and, eq, isNull } from "drizzle-orm";
import { practicePaymentAccounts } from "@openpims/db";
import type { Database } from "@openpims/db/client";
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

export function isChargeableStripeConnectAccount(
  row: {
    onboardingStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  } | null
): boolean {
  return (
    !!row &&
    row.onboardingStatus === "active" &&
    row.chargesEnabled &&
    row.payoutsEnabled
  );
}

/**
 * The practice's chargeable Stripe Connect account id, or null. On hosted,
 * client card money must land in the practice's own Stripe account — every
 * client-facing checkout (staff and portal) gates on this.
 */
export async function getChargeableStripeConnectAccountId(
  db: Database,
  practiceId: string
): Promise<string | null> {
  const [row] = await db
    .select({
      stripeAccountId: practicePaymentAccounts.stripeAccountId,
      onboardingStatus: practicePaymentAccounts.onboardingStatus,
      chargesEnabled: practicePaymentAccounts.chargesEnabled,
      payoutsEnabled: practicePaymentAccounts.payoutsEnabled,
    })
    .from(practicePaymentAccounts)
    .where(
      and(
        eq(practicePaymentAccounts.practiceId, practiceId),
        eq(practicePaymentAccounts.provider, STRIPE_CONNECT_PROVIDER),
        isNull(practicePaymentAccounts.deletedAt)
      )
    )
    .limit(1);

  return isChargeableStripeConnectAccount(row ?? null)
    ? row!.stripeAccountId
    : null;
}

export function stripeConnectApplicationFeeAmount(
  paymentAmountCents: number
): number | undefined {
  const bps = stripeConnectApplicationFeeBps();
  if (bps <= 0 || paymentAmountCents <= 1) return undefined;
  const fee = Math.floor((paymentAmountCents * bps) / 10_000);
  if (fee <= 0) return undefined;
  // Always leave at least one cent of a client payment with the clinic.
  return Math.min(fee, paymentAmountCents - 1);
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
