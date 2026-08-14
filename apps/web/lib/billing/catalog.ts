export const BILLING_CADENCES = ["month", "year"] as const;

export type BillingCadence = (typeof BILLING_CADENCES)[number];

export interface CloudBillingOption {
  cadence: BillingCadence;
  name: string;
  priceUsd: number;
  shortIntervalLabel: string;
  supportingText: string;
  savingsUsd: number;
}

export const CLOUD_MONTHLY_PRICE_USD = 79;
export const CLOUD_ANNUAL_PRICE_USD = 790;
export const CLOUD_ANNUAL_SAVINGS_USD =
  CLOUD_MONTHLY_PRICE_USD * 12 - CLOUD_ANNUAL_PRICE_USD;

export const CLOUD_BILLING_OPTIONS: readonly CloudBillingOption[] = [
  {
    cadence: "month",
    name: "Monthly",
    priceUsd: CLOUD_MONTHLY_PRICE_USD,
    shortIntervalLabel: "/mo",
    supportingText: "Pay month to month. Cancel anytime.",
    savingsUsd: 0,
  },
  {
    cadence: "year",
    name: "Annual",
    priceUsd: CLOUD_ANNUAL_PRICE_USD,
    shortIntervalLabel: "/yr",
    supportingText: "Two months free, billed once each year.",
    savingsUsd: CLOUD_ANNUAL_SAVINGS_USD,
  },
] as const;

export function billingCadenceFromQuery(
  value: string | null | undefined,
  fallback: BillingCadence = "year",
): BillingCadence {
  return value === "month" || value === "year" ? value : fallback;
}
