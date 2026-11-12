/** Read-only preflight. No Checkout, customers, subscriptions, or charges are created. */
import Stripe from "stripe";

const get = (name) => process.env[`STRIPE_OPENVPM_${name}`]?.trim();
const required = ["ACCOUNT_ID", "SECRET_KEY", "SUBSCRIPTION_WEBHOOK_SECRET", "PRICE_CLOUD_LOCATION", "PRICE_CLOUD_LOCATION_ANNUAL", "PRICE_AI_OVERAGE", "PRICE_SMS_OVERAGE", "BILLING_PORTAL_CONFIGURATION"];
const missing = required.filter((name) => !get(name));
if (missing.length) {
  console.error(JSON.stringify({ ready: false, missing: missing.map((name) => `STRIPE_OPENVPM_${name}`) }));
  process.exit(1);
}

const client = new Stripe(get("SECRET_KEY"), { apiVersion: "2026-07-29.dahlia" });
try {
  const account = await client.accounts.retrieve(null);
  if (account.id !== get("ACCOUNT_ID")) throw new Error("The key belongs to a different account.");
  if (!account.charges_enabled) throw new Error("Charges are not enabled on the OpenVPM account.");
  const priceSpecs = [
    ["PRICE_CLOUD_LOCATION", "month", 7900],
    ["PRICE_CLOUD_LOCATION_ANNUAL", "year", 79000],
  ];
  for (const [name, interval, amount] of priceSpecs) {
    const p = await client.prices.retrieve(get(name));
    if (!p.active || p.currency !== "usd" || p.unit_amount !== amount || p.recurring?.interval !== interval || p.recurring?.interval_count !== 1 || p.recurring?.usage_type !== "licensed") {
      throw new Error(`Invalid ${name}: expected active USD ${amount} cents per ${interval} per location.`);
    }
  }
  for (const [name, overage] of [["PRICE_AI_OVERAGE", 5], ["PRICE_SMS_OVERAGE", 3]]) {
    const p = await client.prices.retrieve(get(name), { expand: ["tiers"] });
    if (!p.active || p.currency !== "usd" || p.recurring?.interval !== "month" || p.recurring?.interval_count !== 1 || p.recurring?.usage_type !== "metered" || !p.recurring.meter || p.billing_scheme !== "tiered" || p.tiers_mode !== "graduated" || p.tiers?.length !== 2 || p.tiers[0].up_to !== 1000 || p.tiers[0].unit_amount !== 0 || (p.tiers[0].flat_amount ?? 0) !== 0 || p.tiers[1].up_to !== null || p.tiers[1].unit_amount !== overage || (p.tiers[1].flat_amount ?? 0) !== 0) {
      throw new Error(`Invalid ${name}: expected 1,000 included units then USD ${overage} cents per unit.`);
    }
    const meter = await client.billing.meters.retrieve(p.recurring.meter);
    const expectedEventName = name === "PRICE_AI_OVERAGE" ? "openvpm_ai_run" : "openvpm_sms";
    if (meter.status !== "active" || meter.event_name !== expectedEventName) throw new Error(`Invalid ${name} meter binding.`);
  }
  const portal = await client.billingPortal.configurations.retrieve(get("BILLING_PORTAL_CONFIGURATION"));
  if (!portal.active || !portal.features.subscription_cancel.enabled || !portal.features.payment_method_update.enabled) throw new Error("The customer portal must allow cancellation and payment-method updates.");
  const events = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.payment_succeeded", "invoice.payment_failed"];
  const destination = "https://app.openvpm.com/api/webhooks/stripe-openvpm-subscription";
  let webhookReady = false;
  for await (const endpoint of client.webhookEndpoints.list({ limit: 100 })) {
    if (endpoint.url === destination && endpoint.status === "enabled" && events.every((event) => endpoint.enabled_events.includes("*") || endpoint.enabled_events.includes(event))) webhookReady = true;
  }
  if (!webhookReady) throw new Error("The dedicated OpenVPM subscription webhook destination is missing or incomplete.");
  console.log(JSON.stringify({ ready: true, accountId: account.id, priceChecks: "passed", portalChecks: "passed", webhookChecks: "passed", automaticTax: get("TAX_ENABLED") === "true", note: "Verify account-specific tax registrations and Stripe trial reminders before promotion; sandbox checkout and signed delivery acceptance are still required." }));
} catch (error) {
  // Stripe error objects can contain request details: print only a safe summary.
  console.error(JSON.stringify({ ready: false, error: error instanceof Stripe.errors.StripeError ? `Stripe API preflight failed (${error.code ?? error.type}).` : error.message }));
  process.exitCode = 1;
}
