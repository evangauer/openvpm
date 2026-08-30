import type Stripe from "stripe";

export type StripeBillingPriceRole =
  | "location_monthly"
  | "location_annual"
  | "ai_metered_monthly"
  | "sms_metered_monthly";

export type StripeBillingPriceSpec = {
  role: StripeBillingPriceRole;
  priceId: string;
  interval: "month" | "year";
  usageType: "licensed" | "metered";
};

export type StripeBillingInventoryFinding = {
  severity: "error" | "warning";
  code: string;
  resourceId: string;
  detail: string;
};

function resourceId(
  resource: string | { id: string } | Stripe.DeletedCustomer | null,
): string | null {
  if (!resource) return null;
  return typeof resource === "string" ? resource : resource.id;
}

export function validateStripeBillingPrices(
  entries: Array<{ spec: StripeBillingPriceSpec; price: Stripe.Price }>,
): StripeBillingInventoryFinding[] {
  const findings: StripeBillingInventoryFinding[] = [];
  const currencies = new Set<string>();
  const rolesByPriceId = new Map<string, StripeBillingPriceRole[]>();

  for (const { spec, price } of entries) {
    const roles = rolesByPriceId.get(price.id) ?? [];
    roles.push(spec.role);
    rolesByPriceId.set(price.id, roles);
    const recurring = price.recurring;
    currencies.add(price.currency);
    if (!price.active) {
      findings.push({
        severity: "error",
        code: "price_inactive",
        resourceId: price.id,
        detail: `${spec.role} is inactive.`,
      });
    }
    if (!recurring) {
      findings.push({
        severity: "error",
        code: "price_not_recurring",
        resourceId: price.id,
        detail: `${spec.role} is not recurring.`,
      });
      continue;
    }
    if (
      recurring.interval !== spec.interval ||
      recurring.interval_count !== 1
    ) {
      findings.push({
        severity: "error",
        code: "price_interval_mismatch",
        resourceId: price.id,
        detail: `${spec.role} must recur every 1 ${spec.interval}.`,
      });
    }
    if (recurring.usage_type !== spec.usageType) {
      findings.push({
        severity: "error",
        code: "price_usage_type_mismatch",
        resourceId: price.id,
        detail: `${spec.role} must use ${spec.usageType} usage.`,
      });
    }
  }

  for (const [priceId, roles] of rolesByPriceId) {
    if (roles.length > 1) {
      findings.push({
        severity: "error",
        code: "price_role_collision",
        resourceId: priceId,
        detail: `One Stripe price is configured for multiple roles: ${roles.join(", ")}.`,
      });
    }
  }

  if (currencies.size > 1) {
    findings.push({
      severity: "error",
      code: "price_currency_mismatch",
      resourceId: "configured_prices",
      detail: "Configured hosted prices do not share one currency.",
    });
  }
  return findings;
}

export type StripeBillingSubscriptionSummary = {
  total: number;
  billingModes: Record<string, number>;
  cadences: Record<string, number>;
  attachedSchedules: number;
  findings: StripeBillingInventoryFinding[];
};

export function summarizeStripeBillingSubscriptions(input: {
  subscriptions: Stripe.Subscription[];
  monthlyLocationPriceId: string;
  annualLocationPriceId: string;
  companionPriceIds: string[];
}): StripeBillingSubscriptionSummary {
  const billingModes: Record<string, number> = {};
  const cadences: Record<string, number> = {};
  const findings: StripeBillingInventoryFinding[] = [];
  let attachedSchedules = 0;

  for (const subscription of input.subscriptions) {
    const itemPriceIds = subscription.items.data
      .map((item) => resourceId(item.price))
      .filter((value): value is string => Boolean(value));
    const hasMonthly = itemPriceIds.includes(input.monthlyLocationPriceId);
    const hasAnnual = itemPriceIds.includes(input.annualLocationPriceId);
    const cadence = hasMonthly && hasAnnual
      ? "ambiguous"
      : hasAnnual
        ? "annual"
        : hasMonthly
          ? "monthly"
          : "unrecognized";
    const billingMode = subscription.billing_mode?.type ?? "unknown";
    billingModes[billingMode] = (billingModes[billingMode] ?? 0) + 1;
    cadences[cadence] = (cadences[cadence] ?? 0) + 1;
    if (resourceId(subscription.schedule)) attachedSchedules += 1;

    if (cadence === "ambiguous" || cadence === "unrecognized") {
      findings.push({
        severity: "error",
        code: `subscription_${cadence}_location_price`,
        resourceId: subscription.id,
        detail:
          cadence === "ambiguous"
            ? "Subscription contains both monthly and annual location prices."
            : "Subscription contains neither configured location price.",
      });
      continue;
    }
    if (cadence === "annual" && billingMode !== "flexible") {
      findings.push({
        severity: "error",
        code: "annual_subscription_not_flexible",
        resourceId: subscription.id,
        detail:
          "Annual subscription is not eligible for monthly metered companions.",
      });
    }
    if (cadence === "monthly" && billingMode !== "flexible") {
      findings.push({
        severity: "warning",
        code: "monthly_subscription_not_flexible",
        resourceId: subscription.id,
        detail:
          "Monthly subscription requires an explicit operator decision before annual cadence automation.",
      });
    }
    for (const companionPriceId of input.companionPriceIds) {
      if (!itemPriceIds.includes(companionPriceId)) {
        findings.push({
          severity: "error",
          code: "subscription_companion_missing",
          resourceId: subscription.id,
          detail: `Subscription is missing configured companion ${companionPriceId}.`,
        });
      }
    }
  }

  return {
    total: input.subscriptions.length,
    billingModes,
    cadences,
    attachedSchedules,
    findings,
  };
}

export function assertStripeInventoryCredential(input: {
  key: string;
  allowLiveReadOnly: boolean;
  liveConfirmation?: string;
}): "test" | "live" {
  const mode = input.key.includes("_live_") ? "live" : "test";
  if (mode === "live") {
    if (
      !input.allowLiveReadOnly ||
      input.liveConfirmation !== "OPENVPM_STRIPE_LIVE_READ_ONLY"
    ) {
      throw new Error(
        "Live Stripe inventory requires --allow-live-read-only and STRIPE_LIVE_READ_ONLY_CONFIRMATION=OPENVPM_STRIPE_LIVE_READ_ONLY.",
      );
    }
  }
  return mode;
}
