function configuredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function stripeSecretKey(): string | null {
  return configuredEnv("STRIPE_SECRET_KEY");
}

export function stripeExpectedAccountId(): string | null {
  return configuredEnv("STRIPE_EXPECTED_ACCOUNT_ID");
}

export function stripeSubscriptionPaymentMethodConfigurationId():
  | string
  | null {
  return configuredEnv("STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION");
}

export function stripeBillingPortalConfigurationId(): string | null {
  return configuredEnv("STRIPE_BILLING_PORTAL_CONFIGURATION");
}

export function stripeConfigured(): boolean {
  return stripeSecretKey() !== null;
}

export type StripeCredentialMode = "test" | "live" | "unknown";

export function stripeCredentialMode(
  key: string | null = stripeSecretKey(),
): StripeCredentialMode {
  if (!key) return "unknown";
  if (/^[sr]k_test_/.test(key)) return "test";
  if (/^[sr]k_live_/.test(key)) return "live";
  return "unknown";
}

export function stripeRuntimeModeCheck(): {
  ok: boolean;
  mode: StripeCredentialMode;
  deployment: "preview" | "production" | null;
} {
  const mode = stripeCredentialMode();
  const deployment =
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "production"
      ? process.env.VERCEL_ENV
      : null;

  // Local and self-hosted operators may use either Stripe mode. Vercel's
  // deployment identity is authoritative for hosted safety: an unreadable
  // Sensitive value must still be provably test-only before Preview can make
  // a Stripe API call, and Production must never silently run test billing.
  if (!deployment) return { ok: true, mode, deployment };
  return {
    ok:
      (deployment === "preview" && mode === "test") ||
      (deployment === "production" && mode === "live"),
    mode,
    deployment,
  };
}

export function stripeWebhookSecret(): string | null {
  return configuredEnv("STRIPE_WEBHOOK_SECRET");
}

export function stripeSubscriptionWebhookSecret(): string | null {
  return configuredEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET");
}

export function stripeConnectWebhookSecret(): string | null {
  return configuredEnv("STRIPE_CONNECT_WEBHOOK_SECRET");
}

export function stripeConnectV2WebhookSecret(): string | null {
  return configuredEnv("STRIPE_CONNECT_V2_WEBHOOK_SECRET");
}

export function stripeConnectApplicationFeeBps(): number {
  const value = configuredEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS");
  if (!value) return 0;

  // Hosted billing must never reinterpret or silently clamp an operator typo.
  // Basis points are a whole number and 100% would leave no clinic proceeds.
  if (!/^[1-9]\d{0,3}$/.test(value)) return 0;
  const parsed = Number(value);
  if (parsed >= 10_000) return 0;

  return parsed;
}

export function stripeConnectApplicationFeeConfigured(): boolean {
  return stripeConnectApplicationFeeBps() > 0;
}
