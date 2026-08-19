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
  object?: string | null;
  closed?: boolean | null;
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  configuration?: {
    merchant?: {
      capabilities?: {
        card_payments?: { status?: string | null } | null;
        stripe_balance?: {
          payouts?: { status?: string | null } | null;
        } | null;
      } | null;
    } | null;
  } | null;
  identity?: {
    entity_type?: string | null;
    business_details?: unknown;
    individual?: unknown;
  } | null;
  requirements?: {
    currently_due?: string[] | null;
    disabled_reason?: string | null;
    entries?: Array<{
      awaiting_action_from?: string | null;
      description?: string | null;
      minimum_deadline?: { status?: string | null } | null;
    }> | null;
  } | null;
};

export function isChargeableStripeConnectAccount(
  row: {
    onboardingStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  } | null,
): boolean {
  return (
    !!row &&
    row.onboardingStatus === "active" &&
    row.chargesEnabled &&
    row.payoutsEnabled
  );
}

/**
 * A connected account may be reprovisioned after a platform-account cutover
 * only when the persisted state proves that clinic onboarding never became
 * operational. This deliberately excludes submitted, chargeable, payout-
 * capable, and rejected accounts so a platform change cannot silently replace
 * an account that may hold money or completed identity information.
 */
export function canSafelyReprovisionStripeConnectAccount(row: {
  onboardingStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsDisabledReason: string | null;
}): boolean {
  return (
    row.onboardingStatus !== "active" &&
    !row.chargesEnabled &&
    !row.payoutsEnabled &&
    !row.detailsSubmitted &&
    (row.requirementsDisabledReason == null ||
      row.requirementsDisabledReason === "requirements.past_due")
  );
}

/**
 * The practice's chargeable Stripe Connect account id, or null. On hosted,
 * client card money must land in the practice's own Stripe account — every
 * client-facing checkout (staff and portal) gates on this.
 */
export async function getChargeableStripeConnectAccountId(
  db: Database,
  practiceId: string,
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
        isNull(practicePaymentAccounts.deletedAt),
      ),
    )
    .limit(1);

  return isChargeableStripeConnectAccount(row ?? null)
    ? row!.stripeAccountId
    : null;
}

export function stripeConnectApplicationFeeAmount(
  paymentAmountCents: number,
): number | undefined {
  const bps = stripeConnectApplicationFeeBps();
  if (bps <= 0 || paymentAmountCents <= 1) return undefined;
  const fee = Math.floor((paymentAmountCents * bps) / 10_000);
  if (fee <= 0) return undefined;
  // Always leave at least one cent of a client payment with the clinic.
  return Math.min(fee, paymentAmountCents - 1);
}

export function stripeConnectAccountState(
  account: StripeConnectAccountLike,
): StripeConnectAccountState {
  if (account.object === "v2.core.account" || account.configuration) {
    const cardStatus =
      account.configuration?.merchant?.capabilities?.card_payments?.status ??
      null;
    const payoutStatus =
      account.configuration?.merchant?.capabilities?.stripe_balance?.payouts
        ?.status ?? null;
    const userRequirements = (account.requirements?.entries ?? []).filter(
      (entry) =>
        entry.awaiting_action_from === "user" &&
        (entry.minimum_deadline?.status === "currently_due" ||
          entry.minimum_deadline?.status === "past_due"),
    );
    const requirementsCurrentlyDue = userRequirements
      .map((entry) => entry.description)
      .filter((entry): entry is string => Boolean(entry));
    const pastDue = userRequirements.some(
      (entry) => entry.minimum_deadline?.status === "past_due",
    );
    const restricted = [cardStatus, payoutStatus].some(
      (status) => status === "restricted" || status === "unsupported",
    );
    const chargesEnabled = cardStatus === "active";
    const payoutsEnabled = payoutStatus === "active";
    const detailsSubmitted = Boolean(
      account.identity?.entity_type ||
        account.identity?.business_details ||
        account.identity?.individual,
    );
    const disabledReason = account.closed
      ? "account.closed"
      : pastDue
        ? "requirements.past_due"
        : restricted
          ? "capability.restricted"
          : null;

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

  const requirementsCurrentlyDue = [
    ...(account.requirements?.currently_due ?? []),
  ];
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
