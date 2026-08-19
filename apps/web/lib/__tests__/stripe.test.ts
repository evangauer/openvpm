import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInvoiceCheckoutSessionParams,
  buildSubscriptionCheckoutSessionParams,
  INVOICE_CHECKOUT_CAPTURE_MODE,
  INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER,
  STRIPE_API_VERSION,
  STRIPE_TAX_ENABLED_ENV,
  SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER,
} from "../stripe";
import { TRIAL_DAYS } from "../billing/plans";

afterEach(() => {
  vi.doUnmock("stripe");
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function importStripeWithMock(
  options: { preserveStripeKey?: boolean } = {},
) {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const refundCreate = vi.fn();
  const refundRetrieve = vi.fn();
  const paymentIntentCapture = vi.fn();
  const paymentIntentCancel = vi.fn();
  const paymentIntentRetrieve = vi.fn();
  const chargeRetrieve = vi.fn();
  const balanceTransactionRetrieve = vi.fn();
  const balanceTransactionList = vi.fn();
  const payoutRetrieve = vi.fn();
  const billingPortalCreate = vi.fn();
  const subscriptionRetrieve = vi.fn();
  const subscriptionScheduleCreate = vi.fn();
  const subscriptionScheduleRetrieve = vi.fn();
  const subscriptionScheduleUpdate = vi.fn();
  const accountCreate = vi.fn();
  const accountRetrieve = vi.fn();
  const accountRetrieveCurrent = vi.fn();
  const accountLinkCreate = vi.fn();
  const accountLoginLinkCreate = vi.fn();
  const constructEvent = vi.fn();
  const parseEventNotification = vi.fn();
  const stripeConstruct = vi.fn();

  vi.resetModules();
  vi.doMock("stripe", () => ({
    default: class StripeMock {
      constructor(...args: unknown[]) {
        stripeConstruct(...args);
      }

      checkout = {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve },
      };
      refunds = { create: refundCreate, retrieve: refundRetrieve };
      paymentIntents = {
        cancel: paymentIntentCancel,
        capture: paymentIntentCapture,
        retrieve: paymentIntentRetrieve,
      };
      charges = { retrieve: chargeRetrieve };
      balanceTransactions = {
        retrieve: balanceTransactionRetrieve,
        list: balanceTransactionList,
      };
      payouts = { retrieve: payoutRetrieve };
      billingPortal = { sessions: { create: billingPortalCreate } };
      subscriptions = { retrieve: subscriptionRetrieve };
      subscriptionSchedules = {
        create: subscriptionScheduleCreate,
        retrieve: subscriptionScheduleRetrieve,
        update: subscriptionScheduleUpdate,
      };
      v2 = {
        core: {
          accounts: { create: accountCreate, retrieve: accountRetrieve },
          accountLinks: { create: accountLinkCreate },
        },
      };
      accounts = {
        retrieveCurrent: accountRetrieveCurrent,
        createLoginLink: accountLoginLinkCreate,
      };
      webhooks = { constructEvent };
      parseEventNotification = parseEventNotification;
    },
  }));
  if (!options.preserveStripeKey) {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  }
  vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "acct_openvpm");
  accountRetrieveCurrent.mockResolvedValue({ id: "acct_openvpm" });

  const stripeModule = await import("../stripe");
  return {
    stripeModule,
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    refundRetrieve,
    paymentIntentCapture,
    paymentIntentCancel,
    paymentIntentRetrieve,
    chargeRetrieve,
    balanceTransactionRetrieve,
    balanceTransactionList,
    payoutRetrieve,
    billingPortalCreate,
    subscriptionRetrieve,
    subscriptionScheduleCreate,
    subscriptionScheduleRetrieve,
    subscriptionScheduleUpdate,
    accountCreate,
    accountRetrieve,
    accountRetrieveCurrent,
    accountLinkCreate,
    accountLoginLinkCreate,
    constructEvent,
    parseEventNotification,
    stripeConstruct,
  };
}

describe("buildSubscriptionCheckoutSessionParams", () => {
  it("creates a card-collected trial subscription checkout with location and staff items", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerEmail: "admin@example.com",
      lineItems: [
        { priceId: "price_location", quantity: 2 },
        { priceId: "price_user", quantity: 7 },
      ],
      trialPeriodDays: TRIAL_DAYS,
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.mode).toBe("subscription");
    expect(params.integration_identifier).toBe(
      SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER,
    );
    expect(params.payment_method_collection).toBe("always");
    expect(params.excluded_payment_method_types).toEqual([
      "amazon_pay",
      "cashapp",
      "klarna",
    ]);
    expect(params.customer_email).toBe("admin@example.com");
    expect(params.line_items).toEqual([
      { price: "price_location", quantity: 2 },
      { price: "price_user", quantity: 7 },
    ]);
    expect(params.subscription_data).toMatchObject({
      metadata: { practiceId: "practice_123" },
      trial_period_days: TRIAL_DAYS,
      trial_settings: {
        end_behavior: { missing_payment_method: "cancel" },
      },
    });
  });

  it("adds metered overage items without a quantity", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      lineItems: [
        { priceId: "price_location", quantity: 3 },
        { priceId: "price_ai_overage", metered: true },
        { priceId: "price_sms_overage", metered: true },
      ],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.line_items).toEqual([
      { price: "price_location", quantity: 3 },
      { price: "price_ai_overage" },
      { price: "price_sms_overage" },
    ]);
  });

  it("uses the pinned subscription payment method configuration when present", () => {
    vi.stubEnv(
      "STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION",
      " pmc_openvpm ",
    );

    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerEmail: "admin@example.com",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.payment_method_configuration).toBe("pmc_openvpm");
    expect(params.payment_method_types).toBeUndefined();
  });

  it("requires payment collection when no trial is passed", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.payment_method_collection).toBe("always");
    expect(params.subscription_data).toEqual({
      description: "OpenVPM Cloud — monthly",
      metadata: {
        practiceId: "practice_123",
        billingCadence: "month",
        source: "settings",
      },
    });
  });

  it("labels annual billing in Checkout and subscription metadata", () => {
    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      billingCadence: "year",
      source: "settings",
      lineItems: [{ priceId: "price_annual", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.line_items).toEqual([{ price: "price_annual", quantity: 1 }]);
    expect(params.metadata).toEqual({
      practiceId: "practice_123",
      billingCadence: "year",
      source: "settings",
    });
    expect(params.subscription_data).toMatchObject({
      description: "OpenVPM Cloud — annual",
      metadata: { billingCadence: "year" },
    });
  });

  it("enables Stripe Tax for hosted subscriptions when configured", () => {
    vi.stubEnv(STRIPE_TAX_ENABLED_ENV, " true ");

    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerEmail: "admin@example.com",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.tax_id_collection).toEqual({
      enabled: true,
      required: "if_supported",
    });
    expect(params.customer_update).toBeUndefined();
  });

  it("lets Checkout persist collected tax address on existing customers", () => {
    vi.stubEnv(STRIPE_TAX_ENABLED_ENV, "true");

    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerId: "cus_123",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.customer).toBe("cus_123");
    expect(params.customer_update).toEqual({
      address: "auto",
      name: "auto",
    });
  });

  it("leaves Stripe Tax disabled for blank configured values", () => {
    vi.stubEnv(STRIPE_TAX_ENABLED_ENV, "   ");

    const params = buildSubscriptionCheckoutSessionParams({
      practiceId: "practice_123",
      customerEmail: "admin@example.com",
      lineItems: [{ priceId: "price_location", quantity: 1 }],
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.automatic_tax).toBeUndefined();
    expect(params.tax_id_collection).toBeUndefined();
    expect(params.customer_update).toBeUndefined();
  });

  it("normalizes subscription checkout customer emails and omits blanks", () => {
    expect(
      buildSubscriptionCheckoutSessionParams({
        practiceId: "practice_123",
        customerEmail: " Admin@Example.COM ",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      }).customer_email,
    ).toBe("admin@example.com");

    expect(
      buildSubscriptionCheckoutSessionParams({
        practiceId: "practice_123",
        customerEmail: "   ",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      }).customer_email,
    ).toBeUndefined();
  });
});

describe("verifyStripeAccountIdentity", () => {
  it("verifies the configured credential without exposing account identifiers", async () => {
    vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "acct_openvpm");
    const { stripeModule, accountRetrieveCurrent } =
      await importStripeWithMock();
    accountRetrieveCurrent.mockResolvedValue({ id: "acct_openvpm" });

    await expect(stripeModule.verifyStripeAccountIdentity()).resolves.toEqual({
      ok: true,
      detail: "Stripe account identity verified",
    });
    expect(accountRetrieveCurrent).toHaveBeenCalledWith();
  });

  it("rejects a live Stripe credential before any Preview API call", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_crossed_environment");
    vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "acct_openvpm");
    const { stripeModule, accountRetrieveCurrent } =
      await importStripeWithMock({ preserveStripeKey: true });

    await expect(stripeModule.verifyStripeAccountIdentity()).resolves.toEqual({
      ok: false,
      detail: "Stripe credential mode does not match this deployment",
    });
    expect(accountRetrieveCurrent).not.toHaveBeenCalled();
  });

  it("fails closed when the configured credential belongs to another account", async () => {
    vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "acct_openvpm");
    const { stripeModule, accountRetrieveCurrent } =
      await importStripeWithMock();
    accountRetrieveCurrent.mockResolvedValue({ id: "acct_other" });

    const result = await stripeModule.verifyStripeAccountIdentity();
    expect(result).toEqual({
      ok: false,
      detail: "Stripe account identity does not match",
    });
    expect(JSON.stringify(result)).not.toContain("acct_openvpm");
    expect(JSON.stringify(result)).not.toContain("acct_other");
  });
});

describe("buildInvoiceCheckoutSessionParams", () => {
  it("creates a client invoice payment checkout session", () => {
    const params = buildInvoiceCheckoutSessionParams({
      invoiceId: "invoice_123",
      amount: 12550,
      clientEmail: "client@example.com",
      clientName: "Jane Client",
      description: "Invoice payment for Biscuit",
      currency: "USD",
      successUrl: "https://app.example.com/billing?payment=success",
      cancelUrl: "https://app.example.com/billing?payment=cancelled",
    });

    expect(params).toMatchObject({
      mode: "payment",
      integration_identifier: INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER,
      customer_email: "client@example.com",
      client_reference_id: "invoice_123",
      metadata: {
        invoiceId: "invoice_123",
        captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
        source: "client_invoice",
      },
      payment_intent_data: {
        capture_method: "manual",
        metadata: {
          invoiceId: "invoice_123",
          captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
          source: "client_invoice",
        },
      },
      success_url: "https://app.example.com/billing?payment=success",
      cancel_url: "https://app.example.com/billing?payment=cancelled",
    });
    expect(params.line_items).toEqual([
      {
        price_data: {
          currency: "usd",
          product_data: { name: "Invoice payment for Biscuit" },
          unit_amount: 12550,
        },
        quantity: 1,
      },
    ]);
    // Let Stripe dynamically show every eligible method for this currency and
    // manual-capture flow (including wallets) instead of forcing card-only.
    expect(params.payment_method_types).toBeUndefined();
  });

  it("omits customer email when a client has no email on file", () => {
    const params = buildInvoiceCheckoutSessionParams({
      invoiceId: "invoice_123",
      amount: 5000,
      clientEmail: null,
      clientName: "Jane Client",
      description: "Invoice payment",
      successUrl: "https://app.example.com/success",
      cancelUrl: "https://app.example.com/cancel",
    });

    expect(params.customer_email).toBeUndefined();
  });

  it("normalizes invoice checkout client emails and omits blanks", () => {
    expect(
      buildInvoiceCheckoutSessionParams({
        invoiceId: "invoice_123",
        amount: 5000,
        clientEmail: " Client@Example.COM ",
        clientName: "Jane Client",
        description: "Invoice payment",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      }).customer_email,
    ).toBe("client@example.com");

    expect(
      buildInvoiceCheckoutSessionParams({
        invoiceId: "invoice_123",
        amount: 5000,
        clientEmail: "   ",
        clientName: "Jane Client",
        description: "Invoice payment",
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      }).customer_email,
    ).toBeUndefined();
  });

  it("does not add Stripe Tax to already-totaled clinic invoice payments", () => {
    vi.stubEnv(STRIPE_TAX_ENABLED_ENV, "true");

    const params = buildInvoiceCheckoutSessionParams({
      invoiceId: "invoice_123",
      amount: 12550,
      clientEmail: "client@example.com",
      clientName: "Jane Client",
      description: "Invoice payment for Biscuit",
      successUrl: "https://app.example.com/billing?payment=success",
      cancelUrl: "https://app.example.com/billing?payment=cancelled",
    });

    expect(params.automatic_tax).toBeUndefined();
    expect(params.tax_id_collection).toBeUndefined();
  });

  it("can create client invoice checkout on a connected Stripe account", () => {
    const params = buildInvoiceCheckoutSessionParams({
      invoiceId: "invoice_123",
      amount: 12550,
      clientEmail: "client@example.com",
      clientName: "Jane Client",
      description: "Invoice payment for Biscuit",
      connectedAccountId: "acct_123",
      applicationFeeAmount: 125,
      successUrl: "https://app.example.com/billing?payment=success",
      cancelUrl: "https://app.example.com/billing?payment=cancelled",
    });

    expect(params.metadata).toEqual({
      invoiceId: "invoice_123",
      captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
      source: "client_invoice_connect",
      stripeConnectAccountId: "acct_123",
      openvpmApplicationFeeAmount: "125",
    });
    expect(params.payment_intent_data).toEqual({
      metadata: {
        invoiceId: "invoice_123",
        captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
        source: "client_invoice_connect",
        stripeConnectAccountId: "acct_123",
        openvpmApplicationFeeAmount: "125",
      },
      capture_method: "manual",
      application_fee_amount: 125,
    });
  });
});

describe("create Stripe hosted sessions", () => {
  it("pins the Stripe API contract used by every server-side request", async () => {
    const { stripeConstruct } = await importStripeWithMock();

    expect(stripeConstruct).toHaveBeenCalledExactlyOnceWith("sk_test_123", {
      apiVersion: STRIPE_API_VERSION,
    });
  });

  it("uses stable, distinct Checkout integration identifiers", () => {
    expect(INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER).toMatch(
      /^openvpm_invoice_[a-z]{8}$/,
    );
    expect(SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER).toMatch(
      /^openvpm_subscription_[a-z]{8}$/,
    );
    expect(INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER).not.toBe(
      SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER,
    );
  });

  it("verifies the platform identity before reading connected account state", async () => {
    const { stripeModule, accountRetrieve, accountRetrieveCurrent } =
      await importStripeWithMock();
    accountRetrieve.mockResolvedValue({ id: "acct_clinic" });

    await expect(
      stripeModule.retrieveConnectAccount("acct_clinic"),
    ).resolves.toEqual({ id: "acct_clinic" });

    expect(accountRetrieveCurrent).toHaveBeenCalledTimes(1);
    expect(accountRetrieve).toHaveBeenCalledWith("acct_clinic", {
      include: ["configuration.merchant", "identity", "requirements"],
    });
    expect(accountRetrieveCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      accountRetrieve.mock.invocationCallOrder[0]!,
    );
  });

  it("returns safe HTTPS redirect URLs from Stripe sessions", async () => {
    vi.stubEnv("STRIPE_BILLING_PORTAL_CONFIGURATION", "bpc_openvpm");
    const { stripeModule, checkoutCreate, billingPortalCreate } =
      await importStripeWithMock();
    checkoutCreate
      .mockResolvedValueOnce({ url: "https://checkout.stripe.com/c/pay_123" })
      .mockResolvedValueOnce({ url: "https://checkout.stripe.com/c/sub_123" });
    billingPortalCreate.mockResolvedValueOnce({
      url: "https://billing.stripe.com/session/portal_123",
    });

    await expect(
      stripeModule.createCheckoutSession({
        invoiceId: "invoice_123",
        amount: 12550,
        clientName: "Jane Client",
        description: "Invoice payment",
        successUrl: "https://app.example.com/billing?payment=success",
        cancelUrl: "https://app.example.com/billing?payment=cancelled",
      }),
    ).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay_123" });
    expect(checkoutCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: {
          invoiceId: "invoice_123",
          captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
          source: "client_invoice",
        },
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-checkout:invoice_123:/,
        ),
      }),
    );

    await expect(
      stripeModule.createSubscriptionCheckoutSession({
        practiceId: "practice_123",
        customerEmail: "admin@example.com",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/settings?checkout=success",
        cancelUrl: "https://app.example.com/settings?checkout=cancelled",
      }),
    ).resolves.toEqual({ url: "https://checkout.stripe.com/c/sub_123" });
    expect(checkoutCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        client_reference_id: "practice_123",
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:subscription-checkout:practice_123:/,
        ),
      }),
    );

    await expect(
      stripeModule.createBillingPortalSession({
        customerId: "cus_123",
        returnUrl: "https://app.example.com/settings?tab=billing",
      }),
    ).resolves.toEqual({
      url: "https://billing.stripe.com/session/portal_123",
    });
    expect(billingPortalCreate).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://app.example.com/settings?tab=billing",
      configuration: "bpc_openvpm",
    });
  });

  it("passes the connected account option when creating clinic-owned invoice checkout", async () => {
    const { stripeModule, checkoutCreate } = await importStripeWithMock();
    checkoutCreate.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/c/pay_123",
    });

    await expect(
      stripeModule.createCheckoutSession({
        invoiceId: "invoice_123",
        amount: 12550,
        clientName: "Jane Client",
        description: "Invoice payment",
        connectedAccountId: "acct_123",
        successUrl: "https://app.example.com/billing?payment=success",
        cancelUrl: "https://app.example.com/billing?payment=cancelled",
      }),
    ).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay_123" });

    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "client_invoice_connect",
          stripeConnectAccountId: "acct_123",
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-checkout:invoice_123:/,
        ),
        stripeAccount: "acct_123",
      }),
    );
  });

  it("reuses checkout idempotency keys only for identical money requests", async () => {
    const { stripeModule, checkoutCreate } = await importStripeWithMock();
    checkoutCreate.mockResolvedValue({
      url: "https://checkout.stripe.com/c/pay_123",
    });
    const base = {
      invoiceId: "invoice_123",
      clientName: "Jane Client",
      description: "Invoice payment",
      successUrl: "https://app.example.com/billing?payment=success",
      cancelUrl: "https://app.example.com/billing?payment=cancelled",
    };

    await stripeModule.createCheckoutSession({ ...base, amount: 12550 });
    await stripeModule.createCheckoutSession({ ...base, amount: 12550 });
    await stripeModule.createCheckoutSession({ ...base, amount: 10000 });

    const firstKey = checkoutCreate.mock.calls[0]?.[1]?.idempotencyKey;
    const retryKey = checkoutCreate.mock.calls[1]?.[1]?.idempotencyKey;
    const changedAmountKey = checkoutCreate.mock.calls[2]?.[1]?.idempotencyKey;
    expect(firstKey).toBe(retryKey);
    expect(firstKey).not.toBe(changedAmountKey);
  });

  it("uses a stable local refund identity for Stripe retries", async () => {
    const { stripeModule, checkoutRetrieve, refundCreate } =
      await importStripeWithMock();
    checkoutRetrieve.mockResolvedValue({ payment_intent: "pi_123" });
    refundCreate.mockResolvedValue({
      id: "re_123",
      amount: 12550,
      currency: "usd",
      status: "succeeded",
      created: 1_787_000_000,
      balance_transaction: {
        id: "txn_refund_123",
        amount: -12550,
        fee: 0,
        net: -12550,
      },
    });

    await expect(
      stripeModule.refundStripeCheckoutPayment({
        externalId: "stripe:connect:acct_9:checkout:cs_456",
        amountCents: 12550,
        idempotencyKey: "refund:payment:payment_123",
      }),
    ).resolves.toEqual({
      refundId: "re_123",
      connectedAccountId: "acct_9",
      amountCents: 12550,
      currency: "usd",
      status: "succeeded",
      balanceTransactionId: "txn_refund_123",
      balanceAmountCents: -12550,
      balanceFeeCents: 0,
      balanceNetCents: -12550,
      providerCreatedAt: new Date(1_787_000_000_000),
    });

    expect(checkoutRetrieve).toHaveBeenCalledWith(
      "cs_456",
      {},
      { stripeAccount: "acct_9" },
    );
    expect(refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_123",
        amount: 12550,
        expand: ["balance_transaction"],
        refund_application_fee: true,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:refund:refund:payment:payment_123:/,
        ),
        stripeAccount: "acct_9",
      }),
    );
  });

  it("retrieves an exact completed payout-to-balance-transaction mapping", async () => {
    const {
      stripeModule,
      payoutRetrieve,
      balanceTransactionList,
    } = await importStripeWithMock();
    payoutRetrieve.mockResolvedValue({
      id: "po_123",
      amount: 4800,
      currency: "usd",
      status: "paid",
      automatic: true,
      reconciliation_status: "completed",
      arrival_date: 1_787_100_000,
      created: 1_787_000_000,
      failure_code: null,
      failure_message: null,
    });
    balanceTransactionList.mockReturnValue([
      { id: "txn_charge_1" },
      { id: "txn_charge_2" },
    ]);

    await expect(
      stripeModule.retrieveStripePayoutReconciliation({
        connectedAccountId: "acct_123",
        payoutId: "po_123",
      }),
    ).resolves.toMatchObject({
      payoutId: "po_123",
      amountCents: 4800,
      status: "paid",
      reconciliationComplete: true,
      balanceTransactionIds: ["txn_charge_1", "txn_charge_2"],
    });
    expect(balanceTransactionList).toHaveBeenCalledWith(
      { payout: "po_123", limit: 100 },
      { stripeAccount: "acct_123" },
    );
  });

  it("captures only the live invoice balance from a manual authorization", async () => {
    const { stripeModule, paymentIntentCapture, paymentIntentRetrieve } =
      await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount: 12550,
      amount_capturable: 12550,
      application_fee_amount: 125,
    });
    paymentIntentCapture.mockResolvedValue({
      amount_received: 5000,
      application_fee_amount: 49,
    });

    await expect(
      stripeModule.captureStripeCheckoutAuthorization({
        paymentIntentId: "pi_123",
        amountCents: 5000,
        checkoutSessionId: "cs_123",
        connectedAccountId: "acct_123",
        expectedApplicationFeeAmount: 125,
      }),
    ).resolves.toEqual({
      amountCapturedCents: 5000,
      applicationFeeAmountCents: 49,
    });

    expect(paymentIntentRetrieve).toHaveBeenCalledWith(
      "pi_123",
      {},
      { stripeAccount: "acct_123" },
    );
    expect(paymentIntentCapture).toHaveBeenCalledWith(
      "pi_123",
      { amount_to_capture: 5000, application_fee_amount: 49 },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-capture:cs_123:/,
        ),
        stripeAccount: "acct_123",
      }),
    );
  });

  it("overrides a partial Connect capture fee to zero for a one-cent balance", async () => {
    const { stripeModule, paymentIntentCapture, paymentIntentRetrieve } =
      await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount: 10000,
      amount_capturable: 10000,
      application_fee_amount: 250,
    });
    paymentIntentCapture.mockResolvedValue({
      amount_received: 1,
      application_fee_amount: 0,
    });

    await stripeModule.captureStripeCheckoutAuthorization({
      paymentIntentId: "pi_one_cent",
      amountCents: 1,
      checkoutSessionId: "cs_one_cent",
      connectedAccountId: "acct_123",
      expectedApplicationFeeAmount: 250,
    });

    expect(paymentIntentCapture).toHaveBeenCalledWith(
      "pi_one_cent",
      { amount_to_capture: 1, application_fee_amount: 0 },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-capture:cs_one_cent:/,
        ),
        stripeAccount: "acct_123",
      }),
    );
  });

  it("refuses to capture a Connect authorization with a missing application fee", async () => {
    const { stripeModule, paymentIntentCapture, paymentIntentRetrieve } =
      await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount: 10_000,
      amount_capturable: 10_000,
      application_fee_amount: null,
    });

    await expect(
      stripeModule.captureStripeCheckoutAuthorization({
        paymentIntentId: "pi_missing_fee",
        amountCents: 10_000,
        checkoutSessionId: "cs_missing_fee",
        connectedAccountId: "acct_123",
        expectedApplicationFeeAmount: 100,
      }),
    ).rejects.toThrow("does not contain the expected OpenVPM application fee");
    expect(paymentIntentCapture).not.toHaveBeenCalled();
  });

  it("cancels an invalid manual Checkout authorization immediately", async () => {
    const {
      stripeModule,
      checkoutRetrieve,
      paymentIntentCancel,
      paymentIntentRetrieve,
      refundCreate,
    } = await importStripeWithMock();
    checkoutRetrieve.mockResolvedValue({ payment_intent: "pi_123" });
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount_received: 0,
    });

    await expect(
      stripeModule.refundInvalidStripeCheckoutPayment({
        externalId: "stripe:checkout:cs_123",
        amountCents: 12550,
        idempotencyKey: "invalid:cs_123",
      }),
    ).resolves.toEqual({ outcome: "authorization_canceled" });
    expect(paymentIntentCancel).toHaveBeenCalledWith(
      "pi_123",
      { cancellation_reason: "abandoned" },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invalid-checkout-cancel:invalid:cs_123:/,
        ),
      }),
    );
    expect(refundCreate).not.toHaveBeenCalled();
  });

  it("treats an already-canceled invalid authorization as a safe replay", async () => {
    const {
      stripeModule,
      checkoutRetrieve,
      paymentIntentCancel,
      paymentIntentRetrieve,
    } = await importStripeWithMock();
    checkoutRetrieve.mockResolvedValue({ payment_intent: "pi_canceled" });
    paymentIntentRetrieve.mockResolvedValue({
      status: "canceled",
      amount_received: 0,
    });

    await expect(
      stripeModule.refundInvalidStripeCheckoutPayment({
        externalId: "stripe:checkout:cs_canceled",
        amountCents: 12550,
        idempotencyKey: "invalid:cs_canceled",
      }),
    ).resolves.toEqual({ outcome: "no_funds" });
    expect(paymentIntentCancel).not.toHaveBeenCalled();
  });

  it("cancels invalid Connect authorization on the event account", async () => {
    const {
      stripeModule,
      checkoutRetrieve,
      paymentIntentCancel,
      paymentIntentRetrieve,
    } = await importStripeWithMock();
    checkoutRetrieve.mockResolvedValue({ payment_intent: "pi_connect_cancel" });
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount_received: 0,
    });
    paymentIntentCancel.mockResolvedValue({ status: "canceled" });

    await expect(
      stripeModule.refundInvalidStripeCheckoutPayment({
        externalId: "stripe:connect:acct_9:checkout:cs_connect_cancel",
        amountCents: 12550,
        idempotencyKey: "invalid:cs_connect_cancel",
      }),
    ).resolves.toEqual({ outcome: "authorization_canceled" });
    expect(paymentIntentCancel).toHaveBeenCalledWith(
      "pi_connect_cancel",
      { cancellation_reason: "abandoned" },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invalid-checkout-cancel:invalid:cs_connect_cancel:/,
        ),
        stripeAccount: "acct_9",
      }),
    );
  });

  it("refunds the full captured legacy payment from Stripe's authoritative amount", async () => {
    const {
      stripeModule,
      checkoutRetrieve,
      paymentIntentRetrieve,
      refundCreate,
    } = await importStripeWithMock();
    checkoutRetrieve.mockResolvedValue({ payment_intent: "pi_legacy" });
    paymentIntentRetrieve.mockResolvedValue({
      status: "succeeded",
      amount_received: 12550,
    });
    refundCreate.mockResolvedValue({ id: "re_legacy" });

    await expect(
      stripeModule.refundInvalidStripeCheckoutPayment({
        externalId: "stripe:connect:acct_9:checkout:cs_legacy",
        // Checkout Session amount_total is nullable/stale; it must not cap the
        // reversal of funds Stripe says were captured.
        amountCents: 0,
        idempotencyKey: "invalid:cs_legacy",
      }),
    ).resolves.toEqual({
      outcome: "refunded",
      refundId: "re_legacy",
      amountCents: 12550,
    });
    expect(refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_legacy",
        amount: 12550,
        refund_application_fee: true,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invalid-checkout-refund:invalid:cs_legacy:/,
        ),
        stripeAccount: "acct_9",
      }),
    );
  });

  it("returns null URLs when Stripe responds with unsafe redirects", async () => {
    const { stripeModule, checkoutCreate, billingPortalCreate } =
      await importStripeWithMock();
    checkoutCreate
      .mockResolvedValueOnce({ url: "http://checkout.stripe.com/c/pay_123" })
      .mockResolvedValueOnce({ url: "javascript:alert(1)" });
    billingPortalCreate.mockResolvedValueOnce({
      url: "https://user:pass@billing.stripe.com/session/portal_123",
    });

    await expect(
      stripeModule.createCheckoutSession({
        invoiceId: "invoice_123",
        amount: 12550,
        clientName: "Jane Client",
        description: "Invoice payment",
        successUrl: "https://app.example.com/billing?payment=success",
        cancelUrl: "https://app.example.com/billing?payment=cancelled",
      }),
    ).resolves.toEqual({ url: null });

    await expect(
      stripeModule.createSubscriptionCheckoutSession({
        practiceId: "practice_123",
        customerEmail: "admin@example.com",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/settings?checkout=success",
        cancelUrl: "https://app.example.com/settings?checkout=cancelled",
      }),
    ).resolves.toEqual({ url: null });

    await expect(
      stripeModule.createBillingPortalSession({
        customerId: "cus_123",
        returnUrl: "https://app.example.com/settings?tab=billing",
      }),
    ).resolves.toEqual({ url: null });
  });
});

describe("Stripe Connect settlement evidence", () => {
  it("proves gross, processor fee, application fee, and clinic net", async () => {
    const { stripeModule, paymentIntentRetrieve } =
      await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
      amount_received: 10000,
      application_fee_amount: 25,
      latest_charge: {
        id: "ch_123",
        balance_transaction: {
          id: "txn_123",
          amount: 10000,
          fee: 315,
          net: 9685,
          currency: "usd",
          status: "pending",
          available_on: 1787184000,
        },
      },
    });

    await expect(
      stripeModule.retrieveStripeCheckoutSettlement({
        connectedAccountId: "acct_clinic",
        checkoutSessionId: "cs_123",
        paymentIntentId: "pi_123",
        expectedGrossCents: 10000,
        expectedApplicationFeeCents: 25,
      }),
    ).resolves.toEqual({
      connectedAccountId: "acct_clinic",
      checkoutSessionId: "cs_123",
      paymentIntentId: "pi_123",
      chargeId: "ch_123",
      balanceTransactionId: "txn_123",
      currency: "usd",
      grossAmountCents: 10000,
      processorFeeCents: 290,
      applicationFeeCents: 25,
      clinicNetCents: 9685,
      balanceStatus: "pending",
      availableOn: new Date(1787184000 * 1000),
    });
    expect(paymentIntentRetrieve).toHaveBeenCalledWith(
      "pi_123",
      { expand: ["latest_charge.balance_transaction"] },
      { stripeAccount: "acct_clinic" },
    );
  });

  it("rejects a settlement whose Stripe fee identity does not balance", async () => {
    const { stripeModule, paymentIntentRetrieve } =
      await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      id: "pi_bad",
      status: "succeeded",
      amount_received: 10000,
      application_fee_amount: 25,
      latest_charge: {
        id: "ch_bad",
        balance_transaction: {
          id: "txn_bad",
          amount: 10000,
          fee: 315,
          net: 9700,
          currency: "usd",
          status: "available",
          available_on: 1787184000,
        },
      },
    });

    await expect(
      stripeModule.retrieveStripeCheckoutSettlement({
        connectedAccountId: "acct_clinic",
        checkoutSessionId: "cs_bad",
        paymentIntentId: "pi_bad",
        expectedGrossCents: 10000,
        expectedApplicationFeeCents: 25,
      }),
    ).rejects.toThrow("balance identity is inconsistent");
  });
});

describe("subscription cadence scheduling", () => {
  function phase(input: {
    price: string;
    start: number;
    end: number;
    quantity?: number;
    cadence: "month" | "year";
  }) {
    return {
      add_invoice_items: [],
      application_fee_percent: null,
      automatic_tax: { enabled: true, liability: null },
      billing_cycle_anchor: "phase_start",
      billing_thresholds: null,
      collection_method: "charge_automatically",
      currency: "usd",
      default_payment_method: "pm_123",
      default_tax_rates: [],
      description: `OpenVPM Cloud — ${input.cadence === "year" ? "annual" : "monthly"}`,
      discounts: [],
      end_date: input.end,
      invoice_settings: null,
      items: [
        {
          billing_thresholds: null,
          discounts: [],
          metadata: null,
          plan: input.price,
          price: input.price,
          quantity: input.quantity,
          tax_rates: [],
        },
      ],
      metadata: {
        practiceId: "practice_123",
        billingCadence: input.cadence,
      },
      on_behalf_of: null,
      proration_behavior: "none",
      start_date: input.start,
      transfer_data: null,
      trial_end: null,
    };
  }

  it("schedules annual billing at renewal without changing the live phase", async () => {
    const {
      stripeModule,
      subscriptionRetrieve,
      subscriptionScheduleCreate,
      subscriptionScheduleUpdate,
    } = await importStripeWithMock();
    const current = phase({
      price: "price_monthly",
      start: 1_785_000_000,
      end: 1_787_678_400,
      quantity: 2,
      cadence: "month",
    });
    const annual = phase({
      price: "price_annual",
      start: current.end_date,
      end: 1_819_214_400,
      quantity: 2,
      cadence: "year",
    });
    subscriptionRetrieve.mockResolvedValue({
      id: "sub_123",
      status: "active",
      customer: "cus_123",
      metadata: { practiceId: "practice_123" },
      schedule: null,
      items: { data: [{ price: { id: "price_monthly" } }] },
    });
    subscriptionScheduleCreate.mockResolvedValue({
      id: "sub_sched_123",
      metadata: {},
      current_phase: {
        start_date: current.start_date,
        end_date: current.end_date,
      },
      phases: [current],
    });
    subscriptionScheduleUpdate.mockResolvedValue({
      id: "sub_sched_123",
      metadata: {
        practiceId: "practice_123",
        openvpmCadenceChange: "monthly_to_annual_at_renewal",
      },
      phases: [current, annual],
    });

    await expect(
      stripeModule.scheduleSubscriptionAnnualAtRenewal({
        subscriptionId: "sub_123",
        customerId: "cus_123",
        practiceId: "practice_123",
        monthlyPriceId: "price_monthly",
        annualPriceId: "price_annual",
        locationCount: 2,
      }),
    ).resolves.toEqual({
      effectiveAt: new Date(current.end_date * 1000).toISOString(),
      alreadyScheduled: false,
    });
    expect(subscriptionScheduleCreate).toHaveBeenCalledWith(
      { from_subscription: "sub_123" },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(subscriptionScheduleUpdate).toHaveBeenCalledWith(
      "sub_sched_123",
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            start_date: current.start_date,
            end_date: current.end_date,
          }),
          expect.objectContaining({
            start_date: current.end_date,
            duration: { interval: "year", interval_count: 1 },
            items: [{ price: "price_annual", quantity: 2 }],
            proration_behavior: "none",
          }),
        ],
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("fails closed when the Stripe subscription belongs to another clinic", async () => {
    const {
      stripeModule,
      subscriptionRetrieve,
      subscriptionScheduleCreate,
    } = await importStripeWithMock();
    subscriptionRetrieve.mockResolvedValue({
      id: "sub_123",
      status: "active",
      customer: "cus_other",
      metadata: { practiceId: "practice_other" },
      schedule: null,
      items: { data: [{ price: { id: "price_monthly" } }] },
    });

    await expect(
      stripeModule.scheduleSubscriptionAnnualAtRenewal({
        subscriptionId: "sub_123",
        customerId: "cus_123",
        practiceId: "practice_123",
        monthlyPriceId: "price_monthly",
        annualPriceId: "price_annual",
        locationCount: 1,
      }),
    ).rejects.toThrow("does not belong to this clinic");
    expect(subscriptionScheduleCreate).not.toHaveBeenCalled();
  });
});

describe("construct Stripe webhook events", () => {
  it("does not call Stripe verification when endpoint secrets are blank", async () => {
    const { stripeModule, constructEvent } = await importStripeWithMock();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "   ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "\n");
    vi.stubEnv("STRIPE_CONNECT_V2_WEBHOOK_SECRET", " ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "\t");

    await expect(
      stripeModule.constructWebhookEvent("{}", "sig_client"),
    ).resolves.toBeNull();
    await expect(
      stripeModule.constructConnectWebhookEvent("{}", "sig_connect"),
    ).resolves.toBeNull();
    await expect(
      stripeModule.constructConnectV2EventNotification("{}", "sig_connect_v2"),
    ).resolves.toBeNull();
    await expect(
      stripeModule.constructSubscriptionWebhookEvent("{}", "sig_sub"),
    ).resolves.toBeNull();
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("passes trimmed endpoint secrets to Stripe verification", async () => {
    const { stripeModule, constructEvent, parseEventNotification } =
      await importStripeWithMock();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", " whsec_client ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", " whsec_connect ");
    vi.stubEnv("STRIPE_CONNECT_V2_WEBHOOK_SECRET", " whsec_connect_v2 ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", " whsec_subscription ");
    constructEvent
      .mockReturnValueOnce({ id: "evt_client" })
      .mockReturnValueOnce({ id: "evt_connect" })
      .mockReturnValueOnce({ id: "evt_subscription" });
    parseEventNotification.mockReturnValueOnce({ id: "evt_connect_v2" });

    await expect(
      stripeModule.constructWebhookEvent("{}", "sig_client"),
    ).resolves.toEqual({ id: "evt_client" });
    await expect(
      stripeModule.constructConnectWebhookEvent("{}", "sig_connect"),
    ).resolves.toEqual({ id: "evt_connect" });
    await expect(
      stripeModule.constructSubscriptionWebhookEvent("{}", "sig_sub"),
    ).resolves.toEqual({ id: "evt_subscription" });
    await expect(
      stripeModule.constructConnectV2EventNotification("{}", "sig_connect_v2"),
    ).resolves.toEqual({ id: "evt_connect_v2" });

    expect(constructEvent).toHaveBeenNthCalledWith(
      1,
      "{}",
      "sig_client",
      "whsec_client",
    );
    expect(constructEvent).toHaveBeenNthCalledWith(
      2,
      "{}",
      "sig_connect",
      "whsec_connect",
    );
    expect(constructEvent).toHaveBeenNthCalledWith(
      3,
      "{}",
      "sig_sub",
      "whsec_subscription",
    );
    expect(parseEventNotification).toHaveBeenCalledWith(
      "{}",
      "sig_connect_v2",
      "whsec_connect_v2",
    );
  });
});

describe("parseStripeCheckoutExternalId", () => {
  it("parses platform and Connect checkout external ids", async () => {
    const { parseStripeCheckoutExternalId } = await import("@/lib/stripe");

    expect(parseStripeCheckoutExternalId("stripe:checkout:cs_123")).toEqual({
      sessionId: "cs_123",
    });
    expect(
      parseStripeCheckoutExternalId("stripe:connect:acct_9:checkout:cs_456"),
    ).toEqual({ connectedAccountId: "acct_9", sessionId: "cs_456" });
  });

  it("returns null for manual payments and unknown formats", async () => {
    const { parseStripeCheckoutExternalId } = await import("@/lib/stripe");

    expect(parseStripeCheckoutExternalId(null)).toBeNull();
    expect(parseStripeCheckoutExternalId(undefined)).toBeNull();
    expect(parseStripeCheckoutExternalId("refund:payment:abc")).toBeNull();
    expect(parseStripeCheckoutExternalId("stripe:refund:re_1")).toBeNull();
  });
});

describe("isMissingStripeConnectedAccountError", () => {
  it("accepts only Stripe resource-missing account lookup errors", async () => {
    const { isMissingStripeConnectedAccountError } =
      await import("@/lib/stripe");

    expect(
      isMissingStripeConnectedAccountError({
        code: "resource_missing",
        statusCode: 404,
      }),
    ).toBe(true);
    expect(
      isMissingStripeConnectedAccountError({
        code: "not_found",
        statusCode: 404,
      }),
    ).toBe(true);
    expect(
      isMissingStripeConnectedAccountError({
        code: "resource_missing",
        statusCode: 500,
      }),
    ).toBe(false);
    expect(
      isMissingStripeConnectedAccountError({ code: "api_connection_error" }),
    ).toBe(false);
  });
});
