import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { usageRecords, practices } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "./plans";
import { recordMeterEvent } from "./stripe-meters";

export type UsageKind = "sms" | "ai_run";

/**
 * Soft abuse thresholds. Overage past the included allowance (1,000/mo) now
 * bills via Stripe meters, so these sit well ABOVE the allowance and only flag
 * genuinely abnormal volume to ops — not normal paid overage. We never hard-cap.
 */
export const ABUSE_ALERT_THRESHOLDS: Record<UsageKind, number> = {
  sms: 5000,
  ai_run: 5000,
};

/** Pure: did `kind` cross its abuse threshold moving from `before` to `after`? */
export function crossesAbuseThreshold(
  kind: UsageKind,
  before: number,
  after: number
): boolean {
  const threshold = ABUSE_ALERT_THRESHOLDS[kind];
  if (!threshold) return false;
  return before < threshold && after >= threshold;
}

/** Current billing period as YYYY-MM (UTC). */
export function currentPeriodMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Record a metered usage event. No-op on self-host (billing not enforced).
 * Fire-and-forget safe: never throws into the caller.
 */
export async function recordUsage(opts: {
  practiceId: string;
  kind: UsageKind;
  quantity?: number;
  now?: Date;
}): Promise<void> {
  if (!billingEnforced()) return; // self-host never meters
  const quantity = opts.quantity ?? 1;
  const periodMonth = currentPeriodMonth(opts.now);
  try {
    await withSystem(db, (tx) =>
      tx.insert(usageRecords).values({
        practiceId: opts.practiceId,
        kind: opts.kind,
        quantity,
        periodMonth,
      })
    );
    await maybeAlertOnSpike(opts.practiceId, opts.kind, periodMonth, quantity);
    await maybeMeterToStripe(opts.practiceId, opts.kind, quantity);
  } catch (e) {
    console.error("[usage] failed to record", opts.kind, e);
  }
}

/**
 * Report the event to Stripe's meter so overage bills automatically. Only fires
 * once the practice has a Stripe customer (i.e. a subscription exists) — usage
 * during the pre-checkout no-card trial has no customer and stays free. The
 * local `usageRecords` row remains the source of truth for display/reconcile.
 */
async function maybeMeterToStripe(
  practiceId: string,
  kind: UsageKind,
  quantity: number
): Promise<void> {
  try {
    const [practice] = await withSystem(db, (tx) =>
      tx
        .select({ stripeCustomerId: practices.stripeCustomerId })
        .from(practices)
        .where(eq(practices.id, practiceId))
        .limit(1)
    );
    if (!practice?.stripeCustomerId) return;
    await recordMeterEvent({
      kind,
      stripeCustomerId: practice.stripeCustomerId,
      value: quantity,
      identifier: randomUUID(),
    });
  } catch (e) {
    console.error("[usage] meter event failed", kind, e);
  }
}

/**
 * Fire a single ops alert when a practice's monthly usage crosses an abuse
 * threshold. Naturally fire-once: only the insert that pushes the running total
 * across the boundary satisfies `before < threshold <= after`. Never throws.
 */
async function maybeAlertOnSpike(
  practiceId: string,
  kind: UsageKind,
  periodMonth: string,
  quantity: number
): Promise<void> {
  if (!ABUSE_ALERT_THRESHOLDS[kind]) return;
  try {
    const after = await usageForPractice(practiceId, kind, periodMonth);
    const before = after - quantity;
    if (crossesAbuseThreshold(kind, before, after)) {
      await alertOps(
        `usage spike: ${kind}`,
        `Practice ${practiceId} crossed ${ABUSE_ALERT_THRESHOLDS[kind]} ${kind} events in ${periodMonth} (now ${after}). Overage is billed past the included allowance — review for abuse.`
      );
    }
  } catch (e) {
    console.error("[usage] spike check failed", kind, e);
  }
}

/** Sum a practice's usage of one kind in a period (defaults to current month). */
export async function usageForPractice(
  practiceId: string,
  kind: UsageKind,
  periodMonth: string = currentPeriodMonth()
): Promise<number> {
  const [row] = await withSystem(db, (tx) =>
    tx
      .select({ total: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::int` })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.practiceId, practiceId),
          eq(usageRecords.kind, kind),
          eq(usageRecords.periodMonth, periodMonth)
        )
      )
  );
  return Number(row?.total ?? 0);
}
