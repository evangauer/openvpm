import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  CadenceProviderError,
  buildAnnualScheduleUpdate,
  buildOwnedScheduleQuantityUpdate,
  inspectCadenceSubscription,
} from "../subscription-cadence-provider";

const PERIOD_START = 1_788_220_800;
const PERIOD_END = 1_790_899_200;

function subscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: "sub_monthly",
    customer: {
      id: "cus_clinic",
      discount: null,
    } as Stripe.Customer,
    metadata: { practiceId: "practice_a" },
    status: "active",
    billing_mode: {
      type: "flexible",
      flexible: { proration_discounts: "included" },
      updated_at: PERIOD_START,
    },
    cancel_at: null,
    cancel_at_period_end: false,
    pending_update: null,
    pause_collection: null,
    schedule: null,
    automatic_tax: { enabled: false, disabled_reason: null, liability: null },
    default_tax_rates: [],
    items: {
      data: [
        {
          id: "si_location",
          price: { id: "price_monthly" },
          quantity: 2,
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
          tax_rates: [{ id: "txr_location" } as Stripe.TaxRate],
        },
        {
          id: "si_metered",
          price: { id: "price_metered" },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
          tax_rates: [],
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function phase(
  overrides: Partial<Stripe.SubscriptionSchedule.Phase> = {},
): Stripe.SubscriptionSchedule.Phase {
  return {
    add_invoice_items: [],
    application_fee_percent: null,
    automatic_tax: { enabled: false, disabled_reason: null, liability: null },
    billing_cycle_anchor: null,
    billing_thresholds: null,
    collection_method: "charge_automatically",
    currency: "usd",
    default_payment_method: null,
    default_tax_rates: [],
    description: "OpenVPM Cloud — monthly",
    discounts: [],
    end_date: PERIOD_END,
    invoice_settings: null,
    items: [
      {
        billing_thresholds: null,
        discounts: [],
        metadata: null,
        plan: "plan_monthly" as never,
        price: "price_monthly",
        quantity: 2,
        tax_rates: [{ id: "txr_location" } as Stripe.TaxRate],
      },
      {
        billing_thresholds: null,
        discounts: [],
        metadata: null,
        plan: "plan_metered" as never,
        price: "price_metered",
        tax_rates: [],
      },
    ],
    metadata: { practiceId: "practice_a", billingCadence: "month" },
    on_behalf_of: null,
    proration_behavior: "none",
    start_date: PERIOD_START,
    transfer_data: null,
    trial: false,
    trial_end: null,
    ...overrides,
  } as Stripe.SubscriptionSchedule.Phase;
}

function schedule(
  overrides: Partial<Stripe.SubscriptionSchedule> = {},
): Stripe.SubscriptionSchedule {
  return {
    id: "sub_sched_owned",
    customer: "cus_clinic",
    subscription: "sub_monthly",
    status: "active",
    current_phase: { start_date: PERIOD_START, end_date: PERIOD_END },
    phases: [phase()],
    end_behavior: "release",
    metadata: {},
    default_settings: {
      application_fee_percent: null,
      automatic_tax: {
        enabled: false,
        disabled_reason: null,
        liability: null,
      },
      billing_cycle_anchor: "automatic",
      billing_thresholds: null,
      collection_method: "charge_automatically",
      default_payment_method: null,
      description: null,
      invoice_settings: {
        account_tax_ids: null,
        custom_fields: null,
        days_until_due: null,
        description: null,
        footer: null,
        issuer: { type: "self" },
      },
      on_behalf_of: null,
      transfer_data: null,
    },
    ...overrides,
  } as unknown as Stripe.SubscriptionSchedule;
}

const inspectInput = {
  practiceId: "practice_a",
  customerId: "cus_clinic",
  subscriptionId: "sub_monthly",
  monthlyPriceId: "price_monthly",
  annualPriceId: "price_annual",
  allowedCompanionPriceIds: ["price_metered"],
  locationQuantity: 2,
};

const authorizedInspection = inspectCadenceSubscription(
  subscription(),
  inspectInput,
);
if (authorizedInspection.outcome !== "authorized") {
  throw new Error("Synthetic cadence fixture must authorize.");
}

const buildInput = {
  operationId: "operation_a",
  ...inspectInput,
  currentPeriodStart: new Date(PERIOD_START * 1000),
  currentPeriodEnd: new Date(PERIOD_END * 1000),
  providerSnapshotFingerprintSha256:
    authorizedInspection.currentPhaseFingerprintSha256,
};

describe("subscription cadence provider authorization", () => {
  it("authorizes one exact monthly item without provider mutation", () => {
    expect(inspectCadenceSubscription(subscription(), inspectInput)).toEqual({
      outcome: "authorized",
      currentLocationItemId: "si_location",
      currentLocationPriceId: "price_monthly",
      currentLocationQuantity: 2,
      currentPeriodStart: new Date(PERIOD_START * 1000),
      currentPeriodEnd: new Date(PERIOD_END * 1000),
      currentPhaseFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it.each([
    [
      "provider identity drift",
      { customer: "cus_other" },
      "provider_identity_mismatch",
    ],
    [
      "non-renewing status",
      { status: "past_due" },
      "provider_status_ineligible",
    ],
    [
      "renewal cancellation",
      { cancel_at_period_end: true },
      "provider_renewal_canceled",
    ],
    [
      "pending provider update",
      { pending_update: {} },
      "provider_pending_update",
    ],
    [
      "paused collection",
      { pause_collection: {} },
      "provider_collection_paused",
    ],
    [
      "classic billing mode",
      { billing_mode: { type: "classic", flexible: null } },
      "provider_billing_mode_ineligible",
    ],
  ] as const)("contains %s", (_label, overrides, code) => {
    expect(
      inspectCadenceSubscription(
        subscription(overrides as Partial<Stripe.Subscription>),
        inspectInput,
      ),
    ).toEqual({ outcome: "manual_review", code });
  });

  it("fails closed on every attached schedule", () => {
    expect(
      inspectCadenceSubscription(
        subscription({ schedule: "sub_sched_custom" }),
        inspectInput,
      ),
    ).toEqual({
      outcome: "manual_review",
      code: "provider_schedule_attached",
      observedScheduleId: "sub_sched_custom",
    });
  });

  it("contains custom billing rules before creating a schedule", () => {
    expect(
      inspectCadenceSubscription(
        subscription({ discounts: ["di_custom"] }),
        inspectInput,
      ),
    ).toEqual({
      outcome: "manual_review",
      code: "provider_billing_custom",
    });
    expect(
      inspectCadenceSubscription(
        subscription({
          customer: {
            id: "cus_clinic",
            discount: { id: "di_customer" },
          } as Stripe.Customer,
        }),
        inspectInput,
      ),
    ).toEqual({
      outcome: "manual_review",
      code: "provider_billing_custom",
    });

    const customItem = subscription();
    customItem.items.data[0] = {
      ...customItem.items.data[0]!,
      billing_thresholds: { usage_gte: 10 },
    } as Stripe.SubscriptionItem;
    expect(inspectCadenceSubscription(customItem, inspectInput)).toEqual({
      outcome: "manual_review",
      code: "provider_billing_custom",
    });
  });

  it("contains duplicate plans and provider quantity drift", () => {
    const duplicate = subscription();
    duplicate.items.data.push({
      ...duplicate.items.data[0]!,
      id: "si_duplicate",
    });
    expect(inspectCadenceSubscription(duplicate, inspectInput)).toEqual({
      outcome: "manual_review",
      code: "provider_plan_ambiguous",
    });
    expect(
      inspectCadenceSubscription(subscription(), {
        ...inspectInput,
        locationQuantity: 3,
      }),
    ).toEqual({
      outcome: "manual_review",
      code: "provider_quantity_stale",
    });
  });

  it("contains unknown or duplicate companion prices", () => {
    const custom = subscription();
    custom.items.data.push({
      ...custom.items.data[1]!,
      id: "si_custom",
      price: { id: "price_custom_addon" } as never,
    });
    expect(inspectCadenceSubscription(custom, inspectInput)).toEqual({
      outcome: "manual_review",
      code: "provider_plan_ambiguous",
    });

    const duplicateMeter = subscription();
    duplicateMeter.items.data.push({
      ...duplicateMeter.items.data[1]!,
      id: "si_metered_duplicate",
    });
    expect(inspectCadenceSubscription(duplicateMeter, inspectInput)).toEqual({
      outcome: "manual_review",
      code: "provider_plan_ambiguous",
    });
  });
});

describe("subscription cadence schedule construction", () => {
  it("preserves the current phase and starts one annual phase without proration", () => {
    const built = buildAnnualScheduleUpdate(schedule(), buildInput);
    expect(built.effectiveAt).toEqual(new Date(PERIOD_END * 1000));
    expect(built.params.proration_behavior).toBe("none");
    expect(built.params.end_behavior).toBe("release");
    expect(built.params.metadata).toMatchObject({
      practiceId: "practice_a",
      openvpmCadenceOperationId: "operation_a",
    });
    const phases = built.params.phases!;
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({
      start_date: PERIOD_START,
      end_date: PERIOD_END,
      proration_behavior: "none",
      items: [
        { price: "price_monthly", quantity: 2 },
        { price: "price_metered" },
      ],
    });
    expect(phases[1]).toMatchObject({
      start_date: PERIOD_END,
      duration: { interval: "year", interval_count: 1 },
      proration_behavior: "none",
      items: [
        {
          price: "price_annual",
          quantity: 2,
          tax_rates: ["txr_location"],
        },
        { price: "price_metered" },
      ],
      metadata: {
        practiceId: "practice_a",
        billingCadence: "year",
        openvpmCadenceOperationId: "operation_a",
      },
    });
    expect(phases[1]?.trial).toBeUndefined();
    expect(phases[1]?.trial_end).toBeUndefined();
  });

  it("updates every owned current/future phase through the schedule API", () => {
    const annual = phase({
      start_date: PERIOD_END,
      end_date: PERIOD_END + 31_536_000,
      items: [
        {
          billing_thresholds: null,
          discounts: [],
          metadata: null,
          plan: "plan_annual" as never,
          price: "price_annual",
          quantity: 2,
          tax_rates: [{ id: "txr_location" } as Stripe.TaxRate],
        },
        {
          billing_thresholds: null,
          discounts: [],
          metadata: null,
          plan: "plan_metered" as never,
          price: "price_metered",
          tax_rates: [],
        },
      ],
    });
    const params = buildOwnedScheduleQuantityUpdate(
      schedule({
        phases: [phase(), annual],
        metadata: {
          practiceId: "practice_a",
          openvpmCadenceChange: "monthly_to_annual_at_renewal_v1",
          openvpmCadenceOperationId: "operation_a",
        },
      }),
      {
        operationId: "operation_a",
        practiceId: "practice_a",
        subscriptionId: "sub_monthly",
        monthlyPriceId: "price_monthly",
        annualPriceId: "price_annual",
        locationQuantity: 4,
        nowSeconds: PERIOD_START,
      },
    );
    expect(params.proration_behavior).toBe("none");
    expect(params.phases).toHaveLength(2);
    expect(params.phases?.[0]?.items).toEqual([
      expect.objectContaining({ price: "price_monthly", quantity: 4 }),
      expect.objectContaining({ price: "price_metered" }),
    ]);
    expect(params.phases?.[1]?.items).toEqual([
      expect.objectContaining({ price: "price_annual", quantity: 4 }),
      expect.objectContaining({ price: "price_metered" }),
    ]);
  });

  it("refuses quantity writes through an unknown schedule", () => {
    expect(() =>
      buildOwnedScheduleQuantityUpdate(schedule(), {
        operationId: "operation_a",
        practiceId: "practice_a",
        subscriptionId: "sub_monthly",
        monthlyPriceId: "price_monthly",
        annualPriceId: "price_annual",
        locationQuantity: 4,
        nowSeconds: PERIOD_START,
      }),
    ).toThrow("unrecognized schedule");
  });

  it("rejects custom billing rules and stale period evidence", () => {
    expect(() =>
      buildAnnualScheduleUpdate(
        schedule({ phases: [phase({ discounts: [{} as never] })] }),
        buildInput,
      ),
    ).toThrowError(CadenceProviderError);
    expect(() =>
      buildAnnualScheduleUpdate(
        schedule({
          default_settings: {
            ...schedule().default_settings,
            transfer_data: {
              amount_percent: 100,
              destination: "acct_custom" as never,
            },
          },
        }),
        buildInput,
      ),
    ).toThrow("unsupported default billing rules");
    expect(() =>
      buildAnnualScheduleUpdate(schedule(), {
        ...buildInput,
        currentPeriodEnd: new Date((PERIOD_END + 60) * 1000),
      }),
    ).toThrow("changed after provider authorization");
  });

  it("recognizes only the exact operation-owned annual phase on replay", () => {
    const annual = phase({
      start_date: PERIOD_END,
      end_date: PERIOD_END + 31_536_000,
      items: [
        {
          billing_thresholds: null,
          discounts: [],
          metadata: null,
          plan: "plan_annual" as never,
          price: "price_annual",
          quantity: 2,
          tax_rates: [{ id: "txr_location" } as Stripe.TaxRate],
        },
        {
          billing_thresholds: null,
          discounts: [],
          metadata: null,
          plan: "plan_metered" as never,
          price: "price_metered",
          tax_rates: [],
        },
      ],
      metadata: {
        practiceId: "practice_a",
        openvpmCadenceOperationId: "operation_a",
      },
      proration_behavior: "none",
    });
    const owned = schedule({
      phases: [phase(), annual],
      metadata: {
        practiceId: "practice_a",
        openvpmCadenceChange: "monthly_to_annual_at_renewal_v1",
        openvpmCadenceOperationId: "operation_a",
      },
    });
    expect(buildAnnualScheduleUpdate(owned, buildInput)).toEqual({
      params: {},
      effectiveAt: new Date(PERIOD_END * 1000),
    });
    expect(() =>
      buildAnnualScheduleUpdate(
        {
          ...owned,
          phases: [
            phase(),
            {
              ...annual,
              items: annual.items.filter(
                (item) => item.price !== "price_metered",
              ),
            },
          ],
        },
        buildInput,
      ),
    ).toThrow("another or mismatched operation");
    expect(() =>
      buildAnnualScheduleUpdate(
        {
          ...owned,
          phases: [
            phase(),
            {
              ...annual,
              items: annual.items.map((item) => ({
                ...item,
                tax_rates: [],
              })),
            },
          ],
        },
        buildInput,
      ),
    ).toThrow("another or mismatched operation");
    expect(() =>
      buildAnnualScheduleUpdate(
        {
          ...owned,
          metadata: {
            ...owned.metadata,
            openvpmCadenceOperationId: "operation_other",
          },
        },
        buildInput,
      ),
    ).toThrow("another or mismatched operation");

    const currentDrift = phase({
      items: phase().items.map((item) =>
        item.price === "price_monthly" ? { ...item, quantity: 3 } : item,
      ),
    });
    expect(() =>
      buildAnnualScheduleUpdate(
        { ...owned, phases: [currentDrift, annual] },
        buildInput,
      ),
    ).toThrow("another or mismatched operation");
  });
});
