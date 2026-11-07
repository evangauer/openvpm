function configuredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function stripeSecretKey(): string | null {
  return configuredEnv("STRIPE_SECRET_KEY");
}

export function stripeConfigured(): boolean {
  return stripeSecretKey() !== null;
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

export function stripeConnectApplicationFeeBps(): number {
  const value = configuredEnv("STRIPE_CONNECT_APPLICATION_FEE_BPS");
  if (!value) return 0;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;

  return Math.max(0, Math.min(10_000, Math.trunc(parsed)));
}

export function stripeConnectApplicationFeeConfigured(): boolean {
  return stripeConnectApplicationFeeBps() > 0;
}
