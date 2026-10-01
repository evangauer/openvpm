/** Subscription accounts are persisted per clinic; client payments keep the legacy key. */
export type SubscriptionBillingAccount = "legacy" | "openvpm";

export function subscriptionBillingAccount(value?: string | null): SubscriptionBillingAccount {
  if (!value || value === "legacy") return "legacy";
  if (value === "openvpm") return "openvpm";
  throw new Error("Unrecognized subscription billing account.");
}

/** A separate account is an explicit rollout choice, never inferred from a secret. */
export function newSubscriptionBillingAccount(): SubscriptionBillingAccount {
  return process.env.STRIPE_OPENVPM_ACCOUNT_ID?.trim() ? "openvpm" : "legacy";
}

export function subscriptionBillingEnv(name: string, account: SubscriptionBillingAccount): string {
  return account === "openvpm" ? name.replace(/^STRIPE_/, "STRIPE_OPENVPM_") : name;
}
