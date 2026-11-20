/**
 * Hosted signup started requiring a card before the trial at this instant.
 * Clinics created earlier, and clinics that are not on the OpenVPM billing
 * account, stay in the pre-card cohort so an open no-card trial is not read
 * as a failed card checkout.
 */
export const CARD_GATE_AT = "2026-10-01T19:32:46Z";

export const BILLING_REGIMES = ["pre_card_gate", "card_required"] as const;

export type BillingRegime = (typeof BILLING_REGIMES)[number];

const CARD_GATE_AT_MS = Date.parse(CARD_GATE_AT);

export interface BillingRegimePractice {
  createdAt: Date | string;
  stripeBillingAccount: string | null;
}

/**
 * card_required: created at or after CARD_GATE_AT AND stripe_billing_account
 * is the OpenVPM account. Everything else is pre_card_gate, including a
 * missing or legacy billing account and an unreadable created_at.
 */
export function billingRegimeForPractice(
  practice: BillingRegimePractice,
): BillingRegime {
  const createdAt =
    practice.createdAt instanceof Date
      ? practice.createdAt
      : new Date(practice.createdAt);
  if (Number.isNaN(createdAt.getTime())) return "pre_card_gate";
  if (createdAt.getTime() < CARD_GATE_AT_MS) return "pre_card_gate";
  if (practice.stripeBillingAccount !== "openvpm") return "pre_card_gate";
  return "card_required";
}

export function groupPracticesByBillingRegime<T extends BillingRegimePractice>(
  practices: readonly T[],
): Record<BillingRegime, T[]> {
  const groups: Record<BillingRegime, T[]> = {
    pre_card_gate: [],
    card_required: [],
  };
  for (const practice of practices) {
    groups[billingRegimeForPractice(practice)].push(practice);
  }
  return groups;
}

export interface SignupPaidCounts {
  signups: number;
  checkoutStarted: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
  trialNotYetEnded: number;
}

export function billingRegimeLabel(regime: BillingRegime): string {
  return regime === "card_required" ? "Card required" : "Before the card gate";
}

/** Shared signup → paid sentence for the admin page and the digest. */
export function formatSignupPaidReadout(totals: SignupPaidCounts): string {
  return `${totals.signups} signups → ${totals.checkoutStarted} checkout started → ${totals.paymentMethodCollected} card collected → ${totals.firstPositivePayment} paid`;
}

export function formatTrialNotYetEnded(count: number): string {
  return `${count} trial not yet ended`;
}

export function formatBillingRegimeLine(
  regime: BillingRegime,
  totals: SignupPaidCounts,
): string {
  return `${billingRegimeLabel(regime)}: ${formatSignupPaidReadout(totals)} · ${formatTrialNotYetEnded(totals.trialNotYetEnded)}`;
}
