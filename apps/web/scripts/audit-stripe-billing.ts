#!/usr/bin/env node

import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../lib/stripe";
import { stripeSecretKey } from "../lib/stripe-config";
import {
  STRIPE_PRICE_AI_OVERAGE_ENV,
  STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV,
  STRIPE_PRICE_CLOUD_LOCATION_ENV,
  STRIPE_PRICE_SMS_OVERAGE_ENV,
  stripePriceIdFromEnv,
} from "../lib/billing/plans";
import {
  assertStripeInventoryCredential,
  summarizeStripeBillingSubscriptions,
  validateStripeBillingPrices,
  type StripeBillingInventoryFinding,
  type StripeBillingPriceSpec,
} from "../lib/billing/stripe-billing-inventory";

function requiredPrice(envName: string): string {
  const value = stripePriceIdFromEnv(envName);
  if (!value) throw new Error(`${envName} is required.`);
  return value;
}

async function collectSubscriptions(
  stripe: Stripe,
  priceIds: string[],
): Promise<Stripe.Subscription[]> {
  const subscriptions = new Map<string, Stripe.Subscription>();
  for (const price of priceIds) {
    for await (const subscription of stripe.subscriptions.list({
      price,
      limit: 100,
      expand: ["data.items.data.price"],
    })) {
      subscriptions.set(subscription.id, subscription);
    }
  }
  return [...subscriptions.values()];
}

export async function runStripeBillingInventory(args: string[]) {
  const key = stripeSecretKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY is required.");
  const mode = assertStripeInventoryCredential({
    key,
    allowLiveReadOnly: args.includes("--allow-live-read-only"),
    liveConfirmation: process.env.STRIPE_LIVE_READ_ONLY_CONFIRMATION,
  });
  const monthlyLocationPriceId = requiredPrice(
    STRIPE_PRICE_CLOUD_LOCATION_ENV,
  );
  const annualLocationPriceId = requiredPrice(
    STRIPE_PRICE_CLOUD_LOCATION_ANNUAL_ENV,
  );
  const aiPriceId = stripePriceIdFromEnv(STRIPE_PRICE_AI_OVERAGE_ENV);
  const smsPriceId = stripePriceIdFromEnv(STRIPE_PRICE_SMS_OVERAGE_ENV);
  const companionPriceIds = [aiPriceId, smsPriceId].filter(
    (priceId): priceId is string => Boolean(priceId),
  );
  const configurationFindings: StripeBillingInventoryFinding[] = [];
  if (!aiPriceId) {
    configurationFindings.push({
      severity: "warning",
      code: "optional_price_not_configured",
      resourceId: STRIPE_PRICE_AI_OVERAGE_ENV,
      detail: "AI metered overage is not configured.",
    });
  }
  if (!smsPriceId) {
    configurationFindings.push({
      severity: "warning",
      code: "optional_price_not_configured",
      resourceId: STRIPE_PRICE_SMS_OVERAGE_ENV,
      detail: "SMS metered overage is not configured.",
    });
  }
  const specs: StripeBillingPriceSpec[] = [
    {
      role: "location_monthly",
      priceId: monthlyLocationPriceId,
      interval: "month",
      usageType: "licensed",
    },
    {
      role: "location_annual",
      priceId: annualLocationPriceId,
      interval: "year",
      usageType: "licensed",
    },
    ...(aiPriceId
      ? [
          {
            role: "ai_metered_monthly" as const,
            priceId: aiPriceId,
            interval: "month" as const,
            usageType: "metered" as const,
          },
        ]
      : []),
    ...(smsPriceId
      ? [
          {
            role: "sms_metered_monthly" as const,
            priceId: smsPriceId,
            interval: "month" as const,
            usageType: "metered" as const,
          },
        ]
      : []),
  ];

  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
  const prices = await Promise.all(
    specs.map(async (spec) => ({
      spec,
      price: await stripe.prices.retrieve(spec.priceId),
    })),
  );
  const subscriptions = await collectSubscriptions(stripe, [
    monthlyLocationPriceId,
    annualLocationPriceId,
  ]);
  const priceFindings = validateStripeBillingPrices(prices);
  const subscriptionSummary = summarizeStripeBillingSubscriptions({
    subscriptions,
    monthlyLocationPriceId,
    annualLocationPriceId,
    companionPriceIds,
  });
  const findings: StripeBillingInventoryFinding[] = [
    ...configurationFindings,
    ...priceFindings,
    ...subscriptionSummary.findings,
  ];
  return {
    generatedAt: new Date().toISOString(),
    mode,
    apiVersion: STRIPE_API_VERSION,
    configuredPrices: specs.map(({ role, priceId }) => ({ role, priceId })),
    subscriptions: subscriptionSummary,
    findings,
    counts: {
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning")
        .length,
    },
  };
}

if (process.argv[1]?.endsWith("audit-stripe-billing.ts")) {
  runStripeBillingInventory(process.argv.slice(2))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.counts.errors > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(
        "Stripe billing inventory failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      process.exitCode = 1;
    });
}
