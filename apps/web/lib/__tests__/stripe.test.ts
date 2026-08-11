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

async function importStripeWithMock() {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const refundCreate = vi.fn();
  const paymentIntentCapture = vi.fn();
  const paymentIntentCancel = vi.fn();
  const paymentIntentRetrieve = vi.fn();
  const billingPortalCreate = vi.fn();
  const accountCreate = vi.fn();
  const accountRetrieve = vi.fn();
  const accountLinkCreate = vi.fn();
  const accountLoginLinkCreate = vi.fn();
  const constructEvent = vi.fn();
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
      refunds = { create: refundCreate };
      paymentIntents = {
        cancel: paymentIntentCancel,
        capture: paymentIntentCapture,
        retrieve: paymentIntentRetrieve,
      };
      billingPortal = { sessions: { create: billingPortalCreate } };
      accounts = {
        create: accountCreate,
        retrieve: accountRetrieve,
        createLoginLink: accountLoginLinkCreate,
      };
      accountLinks = { create: accountLinkCreate };
      webhooks = { constructEvent };
    },
  }));
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");

  const stripeModule = await import("../stripe");
  return {
    stripeModule,
    checkoutCreate,
    checkoutRetrieve,
    refundCreate,
    paymentIntentCapture,
    paymentIntentCancel,
    paymentIntentRetrieve,
    billingPortalCreate,
    accountCreate,
    accountRetrieve,
    accountLinkCreate,
    accountLoginLinkCreate,
    constructEvent,
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
      SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER
    );
    expect(params.payment_method_collection).toBe("always");
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
      metadata: { practiceId: "practice_123" },
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
      }).customer_email
    ).toBe("admin@example.com");

    expect(
      buildSubscriptionCheckoutSessionParams({
        practiceId: "practice_123",
        customerEmail: "   ",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      }).customer_email
    ).toBeUndefined();
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
      }).customer_email
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
      }).customer_email
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
    });
    expect(params.payment_intent_data).toEqual({
      metadata: {
        invoiceId: "invoice_123",
        captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
        source: "client_invoice_connect",
        stripeConnectAccountId: "acct_123",
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
      /^openvpm_invoice_[a-z]{8}$/
    );
    expect(SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER).toMatch(
      /^openvpm_subscription_[a-z]{8}$/
    );
    expect(INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER).not.toBe(
      SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER
    );
  });

  it("returns safe HTTPS redirect URLs from Stripe sessions", async () => {
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
      })
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
          /^openvpm:invoice-checkout:invoice_123:/
        ),
      })
    );

    await expect(
      stripeModule.createSubscriptionCheckoutSession({
        practiceId: "practice_123",
        customerEmail: "admin@example.com",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/settings?checkout=success",
        cancelUrl: "https://app.example.com/settings?checkout=cancelled",
      })
    ).resolves.toEqual({ url: "https://checkout.stripe.com/c/sub_123" });
    expect(checkoutCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        client_reference_id: "practice_123",
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:subscription-checkout:practice_123:/
        ),
      })
    );

    await expect(
      stripeModule.createBillingPortalSession({
        customerId: "cus_123",
        returnUrl: "https://app.example.com/settings?tab=billing",
      })
    ).resolves.toEqual({
      url: "https://billing.stripe.com/session/portal_123",
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
      })
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
          /^openvpm:invoice-checkout:invoice_123:/
        ),
        stripeAccount: "acct_123",
      })
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
    refundCreate.mockResolvedValue({ id: "re_123" });

    await expect(
      stripeModule.refundStripeCheckoutPayment({
        externalId: "stripe:connect:acct_9:checkout:cs_456",
        amountCents: 12550,
        idempotencyKey: "refund:payment:payment_123",
      })
    ).resolves.toEqual({ refundId: "re_123" });

    expect(checkoutRetrieve).toHaveBeenCalledWith(
      "cs_456",
      {},
      { stripeAccount: "acct_9" }
    );
    expect(refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: "pi_123",
        amount: 12550,
        refund_application_fee: true,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:refund:refund:payment:payment_123:/
        ),
        stripeAccount: "acct_9",
      })
    );
  });

  it("captures only the live invoice balance from a manual authorization", async () => {
    const {
      stripeModule,
      paymentIntentCapture,
      paymentIntentRetrieve,
    } = await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount: 12550,
      amount_capturable: 12550,
      application_fee_amount: 125,
    });
    paymentIntentCapture.mockResolvedValue({ amount_received: 5000 });

    await expect(
      stripeModule.captureStripeCheckoutAuthorization({
        paymentIntentId: "pi_123",
        amountCents: 5000,
        checkoutSessionId: "cs_123",
        connectedAccountId: "acct_123",
      })
    ).resolves.toEqual({ amountCapturedCents: 5000 });

    expect(paymentIntentRetrieve).toHaveBeenCalledWith(
      "pi_123",
      {},
      { stripeAccount: "acct_123" }
    );
    expect(paymentIntentCapture).toHaveBeenCalledWith(
      "pi_123",
      { amount_to_capture: 5000, application_fee_amount: 49 },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-capture:cs_123:/
        ),
        stripeAccount: "acct_123",
      })
    );
  });

  it("overrides a partial Connect capture fee to zero for a one-cent balance", async () => {
    const {
      stripeModule,
      paymentIntentCapture,
      paymentIntentRetrieve,
    } = await importStripeWithMock();
    paymentIntentRetrieve.mockResolvedValue({
      status: "requires_capture",
      amount: 10000,
      amount_capturable: 10000,
      application_fee_amount: 250,
    });
    paymentIntentCapture.mockResolvedValue({ amount_received: 1 });

    await stripeModule.captureStripeCheckoutAuthorization({
      paymentIntentId: "pi_one_cent",
      amountCents: 1,
      checkoutSessionId: "cs_one_cent",
      connectedAccountId: "acct_123",
    });

    expect(paymentIntentCapture).toHaveBeenCalledWith(
      "pi_one_cent",
      { amount_to_capture: 1, application_fee_amount: 0 },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invoice-capture:cs_one_cent:/
        ),
        stripeAccount: "acct_123",
      })
    );
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
      })
    ).resolves.toEqual({ outcome: "authorization_canceled" });
    expect(paymentIntentCancel).toHaveBeenCalledWith(
      "pi_123",
      { cancellation_reason: "abandoned" },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invalid-checkout-cancel:invalid:cs_123:/
        ),
      })
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
      })
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
      })
    ).resolves.toEqual({ outcome: "authorization_canceled" });
    expect(paymentIntentCancel).toHaveBeenCalledWith(
      "pi_connect_cancel",
      { cancellation_reason: "abandoned" },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^openvpm:invalid-checkout-cancel:invalid:cs_connect_cancel:/
        ),
        stripeAccount: "acct_9",
      })
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
      })
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
          /^openvpm:invalid-checkout-refund:invalid:cs_legacy:/
        ),
        stripeAccount: "acct_9",
      })
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
      })
    ).resolves.toEqual({ url: null });

    await expect(
      stripeModule.createSubscriptionCheckoutSession({
        practiceId: "practice_123",
        customerEmail: "admin@example.com",
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        successUrl: "https://app.example.com/settings?checkout=success",
        cancelUrl: "https://app.example.com/settings?checkout=cancelled",
      })
    ).resolves.toEqual({ url: null });

    await expect(
      stripeModule.createBillingPortalSession({
        customerId: "cus_123",
        returnUrl: "https://app.example.com/settings?tab=billing",
      })
    ).resolves.toEqual({ url: null });
  });
});

describe("construct Stripe webhook events", () => {
  it("does not call Stripe verification when endpoint secrets are blank", async () => {
    const { stripeModule, constructEvent } = await importStripeWithMock();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "   ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "\n");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", "\t");

    await expect(
      stripeModule.constructWebhookEvent("{}", "sig_client")
    ).resolves.toBeNull();
    await expect(
      stripeModule.constructConnectWebhookEvent("{}", "sig_connect")
    ).resolves.toBeNull();
    await expect(
      stripeModule.constructSubscriptionWebhookEvent("{}", "sig_sub")
    ).resolves.toBeNull();
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("passes trimmed endpoint secrets to Stripe verification", async () => {
    const { stripeModule, constructEvent } = await importStripeWithMock();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", " whsec_client ");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", " whsec_connect ");
    vi.stubEnv("STRIPE_SUBSCRIPTION_WEBHOOK_SECRET", " whsec_subscription ");
    constructEvent
      .mockReturnValueOnce({ id: "evt_client" })
      .mockReturnValueOnce({ id: "evt_connect" })
      .mockReturnValueOnce({ id: "evt_subscription" });

    await expect(
      stripeModule.constructWebhookEvent("{}", "sig_client")
    ).resolves.toEqual({ id: "evt_client" });
    await expect(
      stripeModule.constructConnectWebhookEvent("{}", "sig_connect")
    ).resolves.toEqual({ id: "evt_connect" });
    await expect(
      stripeModule.constructSubscriptionWebhookEvent("{}", "sig_sub")
    ).resolves.toEqual({ id: "evt_subscription" });

    expect(constructEvent).toHaveBeenNthCalledWith(
      1,
      "{}",
      "sig_client",
      "whsec_client"
    );
    expect(constructEvent).toHaveBeenNthCalledWith(
      2,
      "{}",
      "sig_connect",
      "whsec_connect"
    );
    expect(constructEvent).toHaveBeenNthCalledWith(
      3,
      "{}",
      "sig_sub",
      "whsec_subscription"
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
      parseStripeCheckoutExternalId("stripe:connect:acct_9:checkout:cs_456")
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
