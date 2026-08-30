import { createHash } from "node:crypto";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";

const CADENCE_CHANGE_KIND = "monthly_to_annual_at_renewal_v1";

export type CadenceProviderInspection =
  | {
      outcome: "authorized";
      currentLocationItemId: string;
      currentLocationPriceId: string;
      currentLocationQuantity: number;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      currentPhaseFingerprintSha256: string;
    }
  | {
      outcome: "manual_review";
      code:
        | "provider_identity_mismatch"
        | "provider_status_ineligible"
        | "provider_already_annual"
        | "provider_plan_ambiguous"
        | "provider_quantity_stale"
        | "provider_renewal_canceled"
        | "provider_pending_update"
        | "provider_collection_paused"
        | "provider_billing_custom"
        | "provider_schedule_attached";
      observedScheduleId?: string;
    };

export type CadenceProvider = {
  inspectSubscription(input: {
    operationId: string;
    practiceId: string;
    customerId: string;
    subscriptionId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    allowedCompanionPriceIds: readonly string[];
    locationQuantity: number;
  }): Promise<CadenceProviderInspection>;
  createSchedule(input: {
    operationId: string;
    practiceId: string;
    customerId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<{ scheduleId: string }>;
  configureSchedule(input: {
    operationId: string;
    practiceId: string;
    customerId: string;
    subscriptionId: string;
    scheduleId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    locationQuantity: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    providerSnapshotFingerprintSha256: string;
    idempotencyKey: string;
  }): Promise<{ effectiveAt: Date }>;
};

export class CadenceProviderError extends Error {
  constructor(
    public readonly code:
      | "provider_unconfigured"
      | "provider_response_invalid"
      | "provider_schedule_mismatch"
      | "provider_schedule_custom",
    message: string,
  ) {
    super(message);
    this.name = "CadenceProviderError";
  }
}

function resourceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function safeDate(seconds: number): Date | null {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const value = new Date(seconds * 1000);
  return Number.isFinite(value.getTime()) ? value : null;
}

function canonicalResourceIds(
  values: readonly unknown[] | null | undefined,
): string[] {
  const ids = (values ?? []).map(resourceId);
  if (ids.some((id) => id === null)) {
    throw new CadenceProviderError(
      "provider_response_invalid",
      "Stripe returned tax configuration without a stable identity.",
    );
  }
  return (ids as string[]).sort((left, right) => left.localeCompare(right));
}

function automaticTaxEvidence(value: unknown): {
  enabled: boolean;
  liability: { type: string; accountId: string | null } | null;
} {
  if (!value || typeof value !== "object") {
    return { enabled: false, liability: null };
  }
  const tax = value as {
    enabled?: unknown;
    liability?: { type?: unknown; account?: unknown } | null;
  };
  const liability = tax.liability;
  return {
    enabled: tax.enabled === true,
    liability:
      liability && typeof liability.type === "string"
        ? {
            type: liability.type,
            accountId: resourceId(liability.account),
          }
        : null,
  };
}

function phaseFingerprint(
  periodStartSeconds: number,
  periodEndSeconds: number,
  items: Array<{
    priceId: string;
    quantity: number | null;
    taxRateIds: string[];
  }>,
  tax: {
    defaultTaxRateIds: string[];
    automaticTax: ReturnType<typeof automaticTaxEvidence>;
  },
): string {
  const canonicalItems = [...items].sort(
    (a, b) =>
      a.priceId.localeCompare(b.priceId) ||
      (a.quantity ?? -1) - (b.quantity ?? -1),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        periodStartSeconds,
        periodEndSeconds,
        items: canonicalItems,
        tax,
      }),
    )
    .digest("hex");
}

function schedulePhaseFingerprint(
  phase: Stripe.SubscriptionSchedule.Phase,
  defaultAutomaticTax?: unknown,
): string {
  const items = phase.items.map((item) => {
    const priceId = resourceId(item.price);
    if (!priceId) {
      throw new CadenceProviderError(
        "provider_response_invalid",
        "The subscription schedule contains an item without a price identity.",
      );
    }
    return {
      priceId,
      quantity: item.quantity ?? null,
      taxRateIds: canonicalResourceIds(item.tax_rates),
    };
  });
  return phaseFingerprint(phase.start_date, phase.end_date, items, {
    defaultTaxRateIds: canonicalResourceIds(phase.default_tax_rates),
    automaticTax: automaticTaxEvidence(
      phase.automatic_tax ?? defaultAutomaticTax,
    ),
  });
}

function schedulePhaseTaxFingerprint(
  phase: Stripe.SubscriptionSchedule.Phase,
  locationPriceId: string,
  defaultAutomaticTax?: unknown,
): string {
  const locationItems = phase.items.filter(
    (item) => resourceId(item.price) === locationPriceId,
  );
  if (locationItems.length !== 1) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The subscription schedule has ambiguous licensed tax configuration.",
    );
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        automaticTax: automaticTaxEvidence(
          phase.automatic_tax ?? defaultAutomaticTax,
        ),
        defaultTaxRateIds: canonicalResourceIds(phase.default_tax_rates),
        itemTaxRateIds: canonicalResourceIds(locationItems[0]!.tax_rates),
      }),
    )
    .digest("hex");
}

export function inspectCadenceSubscription(
  subscription: Stripe.Subscription,
  input: {
    practiceId: string;
    customerId: string;
    subscriptionId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    allowedCompanionPriceIds: readonly string[];
    locationQuantity: number;
  },
): CadenceProviderInspection {
  const customer = subscription.customer;
  if (
    subscription.id !== input.subscriptionId ||
    resourceId(subscription.customer) !== input.customerId ||
    subscription.metadata.practiceId !== input.practiceId ||
    typeof customer === "string" ||
    ("deleted" in customer && customer.deleted === true)
  ) {
    return { outcome: "manual_review", code: "provider_identity_mismatch" };
  }
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return { outcome: "manual_review", code: "provider_status_ineligible" };
  }
  if (subscription.cancel_at_period_end || subscription.cancel_at !== null) {
    return { outcome: "manual_review", code: "provider_renewal_canceled" };
  }
  if (subscription.pending_update !== null) {
    return { outcome: "manual_review", code: "provider_pending_update" };
  }
  if (subscription.pause_collection !== null) {
    return { outcome: "manual_review", code: "provider_collection_paused" };
  }
  if (
    subscription.application_fee_percent != null ||
    subscription.billing_thresholds != null ||
    (subscription.discounts?.length ?? 0) > 0 ||
    subscription.on_behalf_of != null ||
    subscription.pending_invoice_item_interval != null ||
    subscription.transfer_data != null ||
    ("discount" in customer && customer.discount != null) ||
    subscription.items.data.some(
      (item) =>
        item.billing_thresholds != null || (item.discounts?.length ?? 0) > 0,
    )
  ) {
    return { outcome: "manual_review", code: "provider_billing_custom" };
  }
  const scheduleId = resourceId(subscription.schedule);
  if (scheduleId) {
    return {
      outcome: "manual_review",
      code: "provider_schedule_attached",
      observedScheduleId: scheduleId,
    };
  }

  const annualItems = subscription.items.data.filter(
    (item) => resourceId(item.price) === input.annualPriceId,
  );
  if (annualItems.length > 0) {
    return { outcome: "manual_review", code: "provider_already_annual" };
  }
  const monthlyItems = subscription.items.data.filter(
    (item) => resourceId(item.price) === input.monthlyPriceId,
  );
  if (monthlyItems.length !== 1) {
    return { outcome: "manual_review", code: "provider_plan_ambiguous" };
  }
  const monthlyItem = monthlyItems[0]!;
  const quantity = monthlyItem.quantity;
  const periodStart = safeDate(monthlyItem.current_period_start);
  const periodEnd = safeDate(monthlyItem.current_period_end);
  if (
    !monthlyItem.id ||
    quantity === undefined ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !periodStart ||
    !periodEnd ||
    periodEnd <= periodStart
  ) {
    return { outcome: "manual_review", code: "provider_plan_ambiguous" };
  }
  if (quantity !== input.locationQuantity) {
    return { outcome: "manual_review", code: "provider_quantity_stale" };
  }
  const allowedCompanionPrices = new Set(
    input.allowedCompanionPriceIds.filter(
      (priceId) =>
        priceId &&
        priceId !== input.monthlyPriceId &&
        priceId !== input.annualPriceId,
    ),
  );
  const seenCompanionPrices = new Set<string>();
  const canonicalItems: Array<{
    priceId: string;
    quantity: number | null;
    taxRateIds: string[];
  }> = [];
  let defaultTaxRateIds: string[];
  try {
    defaultTaxRateIds = canonicalResourceIds(subscription.default_tax_rates);
  } catch {
    return { outcome: "manual_review", code: "provider_plan_ambiguous" };
  }
  for (const item of subscription.items.data) {
    const priceId = resourceId(item.price);
    const itemPeriodStart = safeDate(item.current_period_start);
    const itemPeriodEnd = safeDate(item.current_period_end);
    if (
      !priceId ||
      !itemPeriodStart ||
      !itemPeriodEnd ||
      itemPeriodStart.getTime() !== periodStart.getTime() ||
      itemPeriodEnd.getTime() !== periodEnd.getTime()
    ) {
      return { outcome: "manual_review", code: "provider_plan_ambiguous" };
    }
    if (priceId !== input.monthlyPriceId) {
      if (
        !allowedCompanionPrices.has(priceId) ||
        seenCompanionPrices.has(priceId)
      ) {
        return { outcome: "manual_review", code: "provider_plan_ambiguous" };
      }
      seenCompanionPrices.add(priceId);
    }
    let taxRateIds: string[];
    try {
      taxRateIds = canonicalResourceIds(item.tax_rates);
    } catch {
      return { outcome: "manual_review", code: "provider_plan_ambiguous" };
    }
    canonicalItems.push({
      priceId,
      quantity: item.quantity ?? null,
      taxRateIds,
    });
  }
  return {
    outcome: "authorized",
    currentLocationItemId: monthlyItem.id,
    currentLocationPriceId: input.monthlyPriceId,
    currentLocationQuantity: quantity,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    currentPhaseFingerprintSha256: phaseFingerprint(
      Math.floor(periodStart.getTime() / 1000),
      Math.floor(periodEnd.getTime() / 1000),
      canonicalItems,
      {
        defaultTaxRateIds,
        automaticTax: automaticTaxEvidence(subscription.automatic_tax),
      },
    ),
  };
}

function phaseToUpdateParams(
  phase: Stripe.SubscriptionSchedule.Phase,
): Stripe.SubscriptionScheduleUpdateParams.Phase {
  if (
    phase.add_invoice_items.length > 0 ||
    phase.application_fee_percent !== null ||
    phase.billing_thresholds !== null ||
    phase.discounts.length > 0 ||
    phase.on_behalf_of !== null ||
    phase.transfer_data !== null ||
    phase.items.some(
      (item) => item.billing_thresholds !== null || item.discounts.length > 0,
    )
  ) {
    throw new CadenceProviderError(
      "provider_schedule_custom",
      "The subscription schedule contains unsupported custom billing rules.",
    );
  }
  const items = phase.items.map((item) => {
    const price = resourceId(item.price);
    if (!price) {
      throw new CadenceProviderError(
        "provider_response_invalid",
        "The subscription schedule contains an item without a price identity.",
      );
    }
    const taxRates = canonicalResourceIds(item.tax_rates);
    return {
      price,
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      ...(taxRates?.length ? { tax_rates: taxRates } : {}),
    };
  });
  const defaultTaxRates = canonicalResourceIds(phase.default_tax_rates);
  const defaultPaymentMethod = resourceId(phase.default_payment_method);
  const automaticTax = phase.automatic_tax
    ? {
        enabled: phase.automatic_tax.enabled,
        ...(phase.automatic_tax.liability
          ? {
              liability: {
                type: phase.automatic_tax.liability.type,
                ...(resourceId(phase.automatic_tax.liability.account)
                  ? {
                      account: resourceId(
                        phase.automatic_tax.liability.account,
                      )!,
                    }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;
  const invoiceSettings = phase.invoice_settings
    ? {
        ...(phase.invoice_settings.account_tax_ids
          ? {
              account_tax_ids: phase.invoice_settings.account_tax_ids
                .map(resourceId)
                .filter((id): id is string => id !== null),
            }
          : {}),
        ...(phase.invoice_settings.custom_fields
          ? { custom_fields: phase.invoice_settings.custom_fields }
          : {}),
        ...(phase.invoice_settings.days_until_due !== null
          ? { days_until_due: phase.invoice_settings.days_until_due }
          : {}),
        ...(phase.invoice_settings.description !== null
          ? { description: phase.invoice_settings.description }
          : {}),
        ...(phase.invoice_settings.footer !== null
          ? { footer: phase.invoice_settings.footer }
          : {}),
        ...(phase.invoice_settings.issuer
          ? {
              issuer: {
                type: phase.invoice_settings.issuer.type,
                ...(resourceId(phase.invoice_settings.issuer.account)
                  ? {
                      account: resourceId(
                        phase.invoice_settings.issuer.account,
                      )!,
                    }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;
  return {
    items,
    start_date: phase.start_date,
    end_date: phase.end_date,
    ...(automaticTax ? { automatic_tax: automaticTax } : {}),
    ...(phase.billing_cycle_anchor
      ? { billing_cycle_anchor: phase.billing_cycle_anchor }
      : {}),
    ...(phase.collection_method
      ? { collection_method: phase.collection_method }
      : {}),
    ...(phase.currency ? { currency: phase.currency } : {}),
    ...(defaultPaymentMethod
      ? { default_payment_method: defaultPaymentMethod }
      : {}),
    ...(defaultTaxRates?.length ? { default_tax_rates: defaultTaxRates } : {}),
    ...(phase.description !== null ? { description: phase.description } : {}),
    ...(invoiceSettings ? { invoice_settings: invoiceSettings } : {}),
    ...(phase.metadata ? { metadata: phase.metadata } : {}),
    proration_behavior: "none",
    ...(phase.trial ? { trial: true } : {}),
    ...(phase.trial_end !== null ? { trial_end: phase.trial_end } : {}),
  };
}

function matchingCurrentPhase(
  schedule: Stripe.SubscriptionSchedule,
): Stripe.SubscriptionSchedule.Phase {
  if (schedule.status !== "active" || !schedule.current_phase) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The created subscription schedule is not active.",
    );
  }
  const matches = schedule.phases.filter(
    (phase) =>
      phase.start_date === schedule.current_phase!.start_date &&
      phase.end_date === schedule.current_phase!.end_date,
  );
  const activeOrFuture = schedule.phases.filter(
    (phase) => phase.end_date > schedule.current_phase!.start_date,
  );
  if (matches.length !== 1 || activeOrFuture.length !== 1) {
    throw new CadenceProviderError(
      "provider_schedule_custom",
      "The created subscription schedule has unexpected phases.",
    );
  }
  return matches[0]!;
}

function validateScheduleIdentity(
  schedule: Stripe.SubscriptionSchedule,
  input: { customerId: string; subscriptionId: string },
): void {
  if (
    resourceId(schedule.customer) !== input.customerId ||
    resourceId(schedule.subscription) !== input.subscriptionId
  ) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The subscription schedule does not match the authorized subscription.",
    );
  }
}

function assertScheduleDefaultsSupported(
  schedule: Stripe.SubscriptionSchedule,
): void {
  const defaults = schedule.default_settings;
  if (!defaults) {
    throw new CadenceProviderError(
      "provider_response_invalid",
      "The subscription schedule did not include its default settings.",
    );
  }
  if (
    defaults.application_fee_percent != null ||
    defaults.billing_thresholds != null ||
    defaults.on_behalf_of != null ||
    defaults.transfer_data != null
  ) {
    throw new CadenceProviderError(
      "provider_schedule_custom",
      "The subscription schedule contains unsupported default billing rules.",
    );
  }
}

function configuredAnnualPhase(
  schedule: Stripe.SubscriptionSchedule,
  input: {
    operationId: string;
    practiceId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    locationQuantity: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    providerSnapshotFingerprintSha256: string;
  },
): Stripe.SubscriptionSchedule.Phase | null {
  if (
    schedule.metadata?.openvpmCadenceChange !== CADENCE_CHANGE_KIND ||
    schedule.metadata?.openvpmCadenceOperationId !== input.operationId ||
    schedule.metadata?.practiceId !== input.practiceId
  ) {
    return null;
  }
  const expectedCurrentStart = Math.floor(
    input.currentPeriodStart.getTime() / 1000,
  );
  const expectedStart = Math.floor(input.currentPeriodEnd.getTime() / 1000);
  const current = schedule.phases.filter(
    (phase) =>
      phase.start_date === expectedCurrentStart &&
      phase.end_date === expectedStart &&
      phase.proration_behavior === "none" &&
      phase.items.filter(
        (item) => resourceId(item.price) === input.monthlyPriceId,
      ).length === 1,
  );
  const annual = schedule.phases.filter(
    (phase) =>
      phase.start_date === expectedStart &&
      phase.proration_behavior === "none" &&
      phase.items.length === 1 &&
      resourceId(phase.items[0]?.price) === input.annualPriceId &&
      phase.items[0]?.quantity === input.locationQuantity,
  );
  if (
    schedule.status !== "active" ||
    schedule.end_behavior !== "release" ||
    schedule.phases.length !== 2 ||
    schedule.current_phase?.start_date !== expectedCurrentStart ||
    schedule.current_phase?.end_date !== expectedStart ||
    current.length !== 1 ||
    annual.length !== 1 ||
    schedulePhaseFingerprint(
      current[0]!,
      schedule.default_settings.automatic_tax,
    ) !== input.providerSnapshotFingerprintSha256 ||
    schedulePhaseTaxFingerprint(
      current[0]!,
      input.monthlyPriceId,
      schedule.default_settings.automatic_tax,
    ) !==
      schedulePhaseTaxFingerprint(
        annual[0]!,
        input.annualPriceId,
        schedule.default_settings.automatic_tax,
      )
  ) {
    return null;
  }
  return annual[0]!;
}

export function buildAnnualScheduleUpdate(
  schedule: Stripe.SubscriptionSchedule,
  input: {
    operationId: string;
    practiceId: string;
    customerId: string;
    subscriptionId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    locationQuantity: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    providerSnapshotFingerprintSha256: string;
  },
): {
  params: Stripe.SubscriptionScheduleUpdateParams;
  effectiveAt: Date;
} {
  validateScheduleIdentity(schedule, input);
  assertScheduleDefaultsSupported(schedule);
  if (
    schedule.metadata?.openvpmCadenceChange ||
    schedule.metadata?.openvpmCadenceOperationId
  ) {
    const existing = configuredAnnualPhase(schedule, input);
    if (!existing) {
      throw new CadenceProviderError(
        "provider_schedule_custom",
        "The subscription schedule is owned by another or mismatched operation.",
      );
    }
    return { params: {}, effectiveAt: new Date(existing.start_date * 1000) };
  }
  const current = matchingCurrentPhase(schedule);
  const expectedStart = Math.floor(input.currentPeriodStart.getTime() / 1000);
  const expectedEnd = Math.floor(input.currentPeriodEnd.getTime() / 1000);
  if (
    current.start_date !== expectedStart ||
    current.end_date !== expectedEnd ||
    current.items.filter(
      (item) => resourceId(item.price) === input.monthlyPriceId,
    ).length !== 1 ||
    current.items.some(
      (item) => resourceId(item.price) === input.annualPriceId,
    ) ||
    schedulePhaseFingerprint(
      current,
      schedule.default_settings.automatic_tax,
    ) !== input.providerSnapshotFingerprintSha256
  ) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The subscription schedule changed after provider authorization.",
    );
  }
  const currentParams = phaseToUpdateParams(current);
  const currentLocationItem = currentParams.items.find(
    (item) => item.price === input.monthlyPriceId,
  );
  if (!currentLocationItem) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The current schedule phase lost its licensed item.",
    );
  }
  currentParams.items = currentParams.items.map((item) =>
    item.price === input.monthlyPriceId
      ? { ...item, quantity: input.locationQuantity }
      : item,
  );
  const { price: _currentPrice, ...currentLocationConfiguration } =
    currentLocationItem;
  const futureParams: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    ...currentParams,
    items: [
      {
        ...currentLocationConfiguration,
        price: input.annualPriceId,
        quantity: input.locationQuantity,
      },
    ],
    start_date: expectedEnd,
    end_date: undefined,
    duration: { interval: "year", interval_count: 1 },
    description: "OpenVPM Cloud — annual",
    metadata: {
      ...(current.metadata ?? {}),
      practiceId: input.practiceId,
      billingCadence: "year",
      source: "settings",
      openvpmCadenceChange: CADENCE_CHANGE_KIND,
      openvpmCadenceOperationId: input.operationId,
    },
    trial: undefined,
    trial_end: undefined,
    proration_behavior: "none",
  };
  return {
    effectiveAt: input.currentPeriodEnd,
    params: {
      end_behavior: "release",
      metadata: {
        ...(schedule.metadata ?? {}),
        practiceId: input.practiceId,
        openvpmCadenceChange: CADENCE_CHANGE_KIND,
        openvpmCadenceOperationId: input.operationId,
      },
      phases: [currentParams, futureParams],
      proration_behavior: "none",
    },
  };
}

export function buildOwnedScheduleQuantityUpdate(
  schedule: Stripe.SubscriptionSchedule,
  input: {
    operationId: string;
    practiceId: string;
    subscriptionId: string;
    monthlyPriceId: string;
    annualPriceId: string;
    locationQuantity: number;
    nowSeconds: number;
  },
): Stripe.SubscriptionScheduleUpdateParams {
  if (
    schedule.metadata?.openvpmCadenceChange !== CADENCE_CHANGE_KIND ||
    schedule.metadata?.openvpmCadenceOperationId !== input.operationId ||
    schedule.metadata?.practiceId !== input.practiceId ||
    resourceId(schedule.subscription) !== input.subscriptionId ||
    schedule.status !== "active"
  ) {
    throw new CadenceProviderError(
      "provider_schedule_custom",
      "Subscription quantity sync found an unrecognized schedule.",
    );
  }
  const phases = schedule.phases
    .filter((phase) => phase.end_date > input.nowSeconds)
    .map((phase) => {
      const locationItems = phase.items.filter((item) => {
        const price = resourceId(item.price);
        return price === input.monthlyPriceId || price === input.annualPriceId;
      });
      if (locationItems.length !== 1) {
        throw new CadenceProviderError(
          "provider_schedule_custom",
          "A managed schedule phase has ambiguous location pricing.",
        );
      }
      const params = phaseToUpdateParams(phase);
      params.items = params.items.map((item) =>
        item.price === input.monthlyPriceId ||
        item.price === input.annualPriceId
          ? { ...item, quantity: input.locationQuantity }
          : item,
      );
      return params;
    });
  if (phases.length === 0) {
    throw new CadenceProviderError(
      "provider_schedule_mismatch",
      "The managed schedule has no current or future phase.",
    );
  }
  return {
    end_behavior: schedule.end_behavior,
    metadata: schedule.metadata ?? {},
    phases,
    proration_behavior: "none",
  };
}

function assertOwnedScheduleQuantity(
  schedule: Stripe.SubscriptionSchedule,
  input: {
    monthlyPriceId: string;
    annualPriceId: string;
    locationQuantity: number;
    nowSeconds: number;
  },
): void {
  const phases = schedule.phases.filter(
    (phase) => phase.end_date > input.nowSeconds,
  );
  if (
    phases.length === 0 ||
    phases.some((phase) => {
      const items = phase.items.filter((item) => {
        const price = resourceId(item.price);
        return price === input.monthlyPriceId || price === input.annualPriceId;
      });
      return (
        items.length !== 1 || items[0]?.quantity !== input.locationQuantity
      );
    })
  ) {
    throw new CadenceProviderError(
      "provider_response_invalid",
      "Stripe did not confirm the scheduled location quantity.",
    );
  }
}

export async function syncOwnedAnnualScheduleLocationQuantity(input: {
  subscription: Stripe.Subscription;
  practiceId: string;
  monthlyPriceId: string;
  annualPriceId: string;
  locationQuantity: number;
  idempotencyKey: string;
}): Promise<"none" | "updated"> {
  const scheduleId = resourceId(input.subscription.schedule);
  if (!scheduleId) return "none";
  const client = requireStripe();
  const schedule = await client.subscriptionSchedules.retrieve(scheduleId);
  const operationId = schedule.metadata?.openvpmCadenceOperationId?.trim();
  if (!operationId) {
    throw new CadenceProviderError(
      "provider_schedule_custom",
      "Subscription quantity sync found a schedule without operation identity.",
    );
  }
  const params = buildOwnedScheduleQuantityUpdate(schedule, {
    operationId,
    practiceId: input.practiceId,
    subscriptionId: input.subscription.id,
    monthlyPriceId: input.monthlyPriceId,
    annualPriceId: input.annualPriceId,
    locationQuantity: input.locationQuantity,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  const updated = await client.subscriptionSchedules.update(
    scheduleId,
    params,
    { idempotencyKey: input.idempotencyKey },
  );
  buildOwnedScheduleQuantityUpdate(updated, {
    operationId,
    practiceId: input.practiceId,
    subscriptionId: input.subscription.id,
    monthlyPriceId: input.monthlyPriceId,
    annualPriceId: input.annualPriceId,
    locationQuantity: input.locationQuantity,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  assertOwnedScheduleQuantity(updated, {
    monthlyPriceId: input.monthlyPriceId,
    annualPriceId: input.annualPriceId,
    locationQuantity: input.locationQuantity,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  return "updated";
}

function requireStripe(): Stripe {
  if (!stripe) {
    throw new CadenceProviderError(
      "provider_unconfigured",
      "Stripe is not configured for subscription cadence changes.",
    );
  }
  return stripe;
}

export const stripeCadenceProvider: CadenceProvider = {
  async inspectSubscription(input) {
    const subscription = await requireStripe().subscriptions.retrieve(
      input.subscriptionId,
      { expand: ["customer"] },
    );
    return inspectCadenceSubscription(subscription, input);
  },

  async createSchedule(input) {
    const schedule = await requireStripe().subscriptionSchedules.create(
      { from_subscription: input.subscriptionId },
      { idempotencyKey: input.idempotencyKey },
    );
    validateScheduleIdentity(schedule, input);
    matchingCurrentPhase(schedule);
    if (!schedule.id) {
      throw new CadenceProviderError(
        "provider_response_invalid",
        "Stripe did not return a subscription schedule identity.",
      );
    }
    return { scheduleId: schedule.id };
  },

  async configureSchedule(input) {
    const client = requireStripe();
    const schedule = await client.subscriptionSchedules.retrieve(
      input.scheduleId,
    );
    const built = buildAnnualScheduleUpdate(schedule, input);
    if (Object.keys(built.params).length === 0) {
      return { effectiveAt: built.effectiveAt };
    }
    const updated = await client.subscriptionSchedules.update(
      input.scheduleId,
      built.params,
      { idempotencyKey: input.idempotencyKey },
    );
    validateScheduleIdentity(updated, input);
    const annualPhase = configuredAnnualPhase(updated, input);
    if (!annualPhase) {
      throw new CadenceProviderError(
        "provider_response_invalid",
        "Stripe did not confirm the exact annual renewal phase.",
      );
    }
    return { effectiveAt: new Date(annualPhase.start_date * 1000) };
  },
};
