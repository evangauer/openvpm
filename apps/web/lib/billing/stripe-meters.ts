import { stripe } from "@/lib/stripe";
import type { UsageKind } from "./usage";

/**
 * Stripe Billing Meters bridge. Each metered usage event we record locally is
 * also reported to Stripe as a meter event so Stripe aggregates it over the
 * billing period and bills overage beyond the included allowance (which is the
 * $0 first tier of the metered price). The legacy usage-records API is gone as
 * of API version 2025-03-31.basil; meter events are the supported path.
 *
 * Meter event names must match the `event_name` configured on the Stripe meters
 * (see docs/hosted-cloud-production.md). Customer mapping is by `stripe_customer_id`.
 */
const METER_EVENT_NAMES: Record<UsageKind, string> = {
  ai_run: "openvpm_ai_run",
  sms: "openvpm_sms",
};

export function meterEventName(kind: UsageKind): string {
  return METER_EVENT_NAMES[kind];
}

/**
 * Report a single metered usage event to Stripe. Fire-and-forget: never throws
 * into the caller (usage recording must not fail a clinic's action). No-op when
 * Stripe is not configured. `identifier` makes the event idempotent across retries.
 */
export async function recordMeterEvent(opts: {
  kind: UsageKind;
  stripeCustomerId: string;
  value?: number;
  identifier?: string;
}): Promise<boolean> {
  if (!stripe) return false;
  try {
    await stripe.billing.meterEvents.create({
      event_name: meterEventName(opts.kind),
      payload: {
        stripe_customer_id: opts.stripeCustomerId,
        value: String(Math.max(0, opts.value ?? 1)),
      },
      ...(opts.identifier ? { identifier: opts.identifier } : {}),
    });
    return true;
  } catch (e) {
    console.error("[meter] failed to record Stripe meter event", opts.kind, e);
    return false;
  }
}
