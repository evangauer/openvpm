import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { usageRecords, practices } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "./plans";
import { recordMeterEvent } from "./stripe-meters";

export type UsageKind = "sms" | "ai_run";
type MeterUsageResult = "metered" | "skipped" | "failed";

export interface UsageReconciliationResult {
  attempted: number;
  metered: number;
  skipped: number;
}

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

export function meterIdentifierForUsageRecord(usageRecordId: string): string {
  return `usage:${usageRecordId}`;
}

/**
 * Record a metered usage event. No-op on self-host (billing not enforced).
 * Caller-safe: logs failures internally and never throws into the user workflow.
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
    const [activePractice] = await withSystem(db, (tx) =>
      tx
        .select({
          id: practices.id,
          recoveryHold: practices.recoveryHold,
        })
        .from(practices)
        .where(
          and(
            eq(practices.id, opts.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .limit(1)
    );
    if (!activePractice) return;

    const [usageRecord] = await withSystem(db, (tx) =>
      tx.insert(usageRecords).values({
        practiceId: opts.practiceId,
        kind: opts.kind,
        quantity,
        periodMonth,
      }).returning({ id: usageRecords.id })
    );
    if (!usageRecord) return;
    // Keep the local usage ledger complete while a clinic is held, but defer
    // all provider and ops delivery until recovery is explicitly released.
    if (activePractice.recoveryHold) return;
    await maybeAlertOnSpike(opts.practiceId, opts.kind, periodMonth, quantity);
    await maybeMeterToStripe({
      usageRecordId: usageRecord.id,
      practiceId: opts.practiceId,
      kind: opts.kind,
      quantity,
    });
  } catch (e) {
    console.error("[usage] failed to record", opts.kind, e);
  }
}

/**
 * Report the event to Stripe's meter so overage bills automatically. Only fires
 * once the practice has a Stripe customer (i.e. a subscription exists) — usage
 * before the card-collected hosted checkout completes has no customer and stays
 * local. The local `usageRecords` row remains the source of truth for
 * display/reconcile.
 */
async function maybeMeterToStripe(opts: {
  usageRecordId: string;
  practiceId: string;
  kind: UsageKind;
  quantity: number;
}): Promise<MeterUsageResult> {
  try {
    return await withSystem(db, async (tx) => {
      const [practice] = await tx
        .select({
          stripeCustomerId: practices.stripeCustomerId,
          recoveryHold: practices.recoveryHold,
        })
        .from(practices)
        .where(
          and(
            eq(practices.id, opts.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .limit(1)
        .for("share", { of: practices });
      if (!practice?.stripeCustomerId || practice.recoveryHold) {
        return "skipped";
      }
      const identifier = meterIdentifierForUsageRecord(opts.usageRecordId);
      const metered = await recordMeterEvent({
        kind: opts.kind,
        stripeCustomerId: practice.stripeCustomerId,
        value: opts.quantity,
        identifier,
      });
      if (metered) {
        await tx
          .update(usageRecords)
          .set({
            stripeMeterIdentifier: identifier,
            stripeMeteredAt: new Date(),
          })
          .where(
            and(
              eq(usageRecords.id, opts.usageRecordId),
              isNull(usageRecords.deletedAt)
            )
          );
        return "metered";
      }
      return "failed";
    });
  } catch (e) {
    console.error("[usage] meter event failed", opts.kind, e);
    return "failed";
  }
}

export async function reconcileUnmeteredUsage(opts: {
  limit?: number;
} = {}): Promise<UsageReconciliationResult> {
  if (!billingEnforced()) return { attempted: 0, metered: 0, skipped: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await withSystem(db, (tx) =>
    tx
      .select({
        id: usageRecords.id,
        practiceId: usageRecords.practiceId,
        kind: usageRecords.kind,
        quantity: usageRecords.quantity,
      })
      .from(usageRecords)
      .innerJoin(
        practices,
        and(
          eq(practices.id, usageRecords.practiceId),
          isNull(practices.deletedAt),
          eq(practices.recoveryHold, false),
          isNotNull(practices.stripeCustomerId)
        )
      )
      .where(
        and(
          isNull(usageRecords.stripeMeteredAt),
          isNull(usageRecords.deletedAt)
        )
      )
      .limit(limit)
  );

  let metered = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await maybeMeterToStripe({
      usageRecordId: row.id,
      practiceId: row.practiceId,
      kind: row.kind as UsageKind,
      quantity: row.quantity,
    });
    if (result === "metered") metered++;
    if (result === "skipped") skipped++;
  }

  return { attempted: rows.length, metered, skipped };
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
          eq(usageRecords.periodMonth, periodMonth),
          isNull(usageRecords.deletedAt)
        )
      )
  );
  return Number(row?.total ?? 0);
}
