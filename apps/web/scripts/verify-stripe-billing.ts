import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../lib/stripe";
import { stripeConnectApplicationFeeBps } from "../lib/stripe-config";

const TERMS_URL = "https://app.openvpm.com/legal/terms";
const PRIVACY_URL = "https://app.openvpm.com/legal/privacy";
const EXPECTED_TAX_BEHAVIOR = "exclusive";

type Check = { label: string; ok: boolean; detail?: string };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing:${name}`);
  return value;
}

function productName(product: Stripe.Price["product"]): string | null {
  return typeof product === "object" && "name" in product
    ? product.name
    : null;
}

function productTaxCode(product: Stripe.Price["product"]): string | null {
  if (typeof product !== "object" || !("tax_code" in product)) return null;
  const taxCode = product.tax_code;
  return typeof taxCode === "string" ? taxCode : (taxCode?.id ?? null);
}

function registrationKey(registration: Stripe.Tax.Registration): string | null {
  if (registration.country !== "US") return null;
  const options = registration.country_options.us;
  if (!options) return null;
  return `US-${options.state.toUpperCase()}:${options.type}`;
}

function requiredTaxRegistrations(value: string): string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))].sort();
}

function sameMembers(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    expected.every((entry) => actual.includes(entry))
  );
}

function zeroOrUnset(value: number | null): boolean {
  // Stripe serializes a tier with no flat fee as null. Older fixtures and
  // some API versions returned zero for the same pricing semantics.
  return value === null || value === 0;
}

function activePaymentMethods(
  configuration: Stripe.PaymentMethodConfiguration,
): string[] {
  return Object.entries(configuration)
    .filter(([, value]) => {
      if (!value || typeof value !== "object") return false;
      return "available" in value && value.available === true;
    })
    .map(([name]) => name)
    .sort();
}

async function main(): Promise<void> {
  const secretKey = requiredEnv("STRIPE_SECRET_KEY");
  const expectedAccountId = requiredEnv("STRIPE_EXPECTED_ACCOUNT_ID");
  const monthlyPriceId = requiredEnv("STRIPE_PRICE_CLOUD_LOCATION");
  const annualPriceId = requiredEnv("STRIPE_PRICE_CLOUD_LOCATION_ANNUAL");
  const aiPriceId = requiredEnv("STRIPE_PRICE_AI_OVERAGE");
  const smsPriceId = requiredEnv("STRIPE_PRICE_SMS_OVERAGE");
  const paymentConfigurationId = requiredEnv(
    "STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION",
  );
  const portalConfigurationId = requiredEnv(
    "STRIPE_BILLING_PORTAL_CONFIGURATION",
  );
  const expectedCloudTaxCode = requiredEnv("STRIPE_CLOUD_PRODUCT_TAX_CODE");
  const expectedTaxRegistrations = requiredTaxRegistrations(
    requiredEnv("STRIPE_REQUIRED_TAX_REGISTRATIONS"),
  );
  const taxEnabled = requiredEnv("STRIPE_TAX_ENABLED");
  const connectV2Enabled = requiredEnv("STRIPE_CONNECT_V2_ENABLED");
  const hostedBillingEnabled = requiredEnv("HOSTED_BILLING_ENABLED");
  const expectedLivemode = /_(live)_/.test(secretKey);
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const checks: Check[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checks.push({ label, ok, ...(detail ? { detail } : {}) });
  };

  const account = await stripe.accounts.retrieveCurrent();
  check("credential belongs to expected account", account.id === expectedAccountId);
  check(
    "Connect application fee is 25 basis points",
    stripeConnectApplicationFeeBps() === 25,
  );
  check("Accounts v2 launch gate is enabled", connectV2Enabled === "true");
  check("hosted billing is enabled", hostedBillingEnabled === "true");

  const [
    monthly,
    annual,
    ai,
    sms,
    paymentConfiguration,
    portal,
    taxSettings,
    activeTaxRegistrations,
  ] =
    await Promise.all([
      stripe.prices.retrieve(monthlyPriceId, { expand: ["product", "tiers"] }),
      stripe.prices.retrieve(annualPriceId, { expand: ["product", "tiers"] }),
      stripe.prices.retrieve(aiPriceId, { expand: ["product", "tiers"] }),
      stripe.prices.retrieve(smsPriceId, { expand: ["product", "tiers"] }),
      stripe.paymentMethodConfigurations.retrieve(paymentConfigurationId),
      stripe.billingPortal.configurations.retrieve(portalConfigurationId),
      stripe.tax.settings.retrieve(),
      stripe.tax.registrations.list({ status: "active", limit: 100 }),
    ]);

  for (const [label, price] of [
    ["monthly Cloud price", monthly],
    ["annual Cloud price", annual],
    ["AI overage price", ai],
    ["SMS overage price", sms],
  ] as const) {
    check(`${label} is active in expected mode`, price.active && price.livemode === expectedLivemode);
    check(`${label} uses OpenVPM Cloud product`, productName(price.product) === "OpenVPM Cloud");
  }

  check(
    "monthly Cloud price is USD 79 per month",
    monthly.currency === "usd" &&
      monthly.unit_amount === 7_900 &&
      monthly.recurring?.interval === "month" &&
      monthly.recurring.interval_count === 1 &&
      monthly.recurring.usage_type === "licensed",
  );
  check(
    "annual Cloud price is USD 790 per year",
    annual.currency === "usd" &&
      annual.unit_amount === 79_000 &&
      annual.recurring?.interval === "year" &&
      annual.recurring.interval_count === 1 &&
      annual.recurring.usage_type === "licensed" &&
      annual.lookup_key === "openvpm_cloud_location_annual",
  );

  const verifyMeteredPrice = async (
    label: string,
    price: Stripe.Price,
    expectedEventName: string,
    expectedDisplayName: string,
    expectedUnitAmount: number,
  ) => {
    const tiers = price.tiers ?? [];
    check(
      `${label} has the intended graduated allowance`,
      price.currency === "usd" &&
        price.billing_scheme === "tiered" &&
        price.tiers_mode === "graduated" &&
        price.recurring?.usage_type === "metered" &&
        price.recurring.interval === "month" &&
        tiers.length === 2 &&
        tiers[0]?.up_to === 1_000 &&
        tiers[0]?.unit_amount === 0 &&
        zeroOrUnset(tiers[0]?.flat_amount ?? null) &&
        tiers[1]?.up_to === null &&
        tiers[1]?.unit_amount === expectedUnitAmount &&
        zeroOrUnset(tiers[1]?.flat_amount ?? null),
    );
    const meterId = price.recurring?.meter;
    if (!meterId) {
      check(`${label} has an attached meter`, false);
      return;
    }
    const meter = await stripe.billing.meters.retrieve(meterId);
    check(
      `${label} meter is active and correctly mapped`,
      meter.status === "active" &&
        meter.livemode === expectedLivemode &&
        meter.event_name === expectedEventName &&
        meter.display_name === expectedDisplayName &&
        meter.default_aggregation.formula === "sum" &&
        meter.customer_mapping.type === "by_id" &&
        meter.customer_mapping.event_payload_key === "stripe_customer_id" &&
        meter.value_settings.event_payload_key === "value",
    );
  };

  await verifyMeteredPrice(
    "AI overage price",
    ai,
    "openvpm_ai_run",
    "OpenVPM AI actions",
    5,
  );
  await verifyMeteredPrice(
    "SMS overage price",
    sms,
    "openvpm_sms",
    "OpenVPM SMS messages",
    3,
  );

  const enabledMethods = activePaymentMethods(paymentConfiguration);
  check(
    "payment configuration is active in expected mode",
    paymentConfiguration.active &&
      paymentConfiguration.livemode === expectedLivemode,
  );
  check(
    "payment configuration offers only card and ACH",
    sameMembers(enabledMethods, ["card", "us_bank_account"]),
    enabledMethods.length > 0 ? `enabled: ${enabledMethods.join(", ")}` : undefined,
  );

  const portalFeatures = portal.features;
  check("Billing Portal configuration is active", portal.active && portal.livemode === expectedLivemode);
  check("Billing Portal shows invoices", portalFeatures.invoice_history.enabled);
  check(
    "Billing Portal allows payment updates through pinned methods",
    portalFeatures.payment_method_update.enabled &&
      portalFeatures.payment_method_update.payment_method_configuration ===
        paymentConfigurationId,
  );
  check(
    "Billing Portal cancellation is end-of-period with a reason",
    portalFeatures.subscription_cancel.enabled &&
      portalFeatures.subscription_cancel.mode === "at_period_end" &&
      portalFeatures.subscription_cancel.cancellation_reason.enabled,
  );
  check(
    "Billing Portal does not permit plan or quantity changes",
    !portalFeatures.subscription_update.enabled,
  );
  check(
    "Billing Portal uses OpenVPM legal links",
    portal.business_profile.terms_of_service_url === TERMS_URL &&
      portal.business_profile.privacy_policy_url === PRIVACY_URL,
  );

  check("hosted subscription tax is enabled", taxEnabled === "true");
  check(
    "Stripe Tax is active in expected mode",
    taxSettings.status === "active" && taxSettings.livemode === expectedLivemode,
  );
  // Get Talky temporarily hosts more than one product. Pinning tax behavior on
  // the OpenVPM prices avoids changing the account-wide default for unrelated
  // products while still making every OpenVPM renewal deterministic.
  check(
    "OpenVPM prices use exclusive tax behavior",
    [monthly, annual, ai, sms].every(
      (price) => price.tax_behavior === EXPECTED_TAX_BEHAVIOR,
    ),
  );
  check(
    "OpenVPM Cloud uses the expected tax classification",
    productTaxCode(monthly.product) === expectedCloudTaxCode &&
      productTaxCode(annual.product) === expectedCloudTaxCode &&
      productTaxCode(ai.product) === expectedCloudTaxCode &&
      productTaxCode(sms.product) === expectedCloudTaxCode,
  );
  const activeRegistrationKeys = activeTaxRegistrations.data
    .map(registrationKey)
    .filter((entry): entry is string => entry !== null)
    .sort();
  check(
    "required tax registrations are active",
    expectedTaxRegistrations.length > 0 &&
      expectedTaxRegistrations.every((entry) =>
        activeRegistrationKeys.includes(entry),
      ),
    activeRegistrationKeys.length > 0
      ? `active: ${activeRegistrationKeys.join(", ")}`
      : "no active US registrations",
  );

  for (const result of checks) {
    const detail = result.detail ? ` (${result.detail})` : "";
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${result.label}${detail}\n`);
  }
  const failures = checks.filter((result) => !result.ok).length;
  if (failures > 0) {
    throw new Error(`${failures} Stripe billing preflight check(s) failed`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  const safeMessage = message.startsWith("missing:")
    ? `required configuration is missing (${message.slice("missing:".length)})`
    : message.includes("preflight check")
      ? message
      : "Stripe billing preflight could not complete";
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
