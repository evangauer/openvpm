import { and, eq, isNull, sql } from "drizzle-orm";
import { locations, practices, users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { stripe } from "@/lib/stripe";
import {
  STRIPE_PRICE_CLOUD_LEGACY_ENV,
  billingEnforced,
  cloudCheckoutPriceIds,
  cloudMeteredPriceIds,
  estimatedCloudBaseMonthlyUsd,
  stripePriceIdFromEnv,
} from "./plans";

export type BillingSyncStatus = "ok" | "skipped" | "legacy" | "error";

export interface BillingSyncState {
  status: BillingSyncStatus;
  message: string;
  updatedAt: string;
  locationCount: number;
  billableSeatCount: number;
}

export interface BillableCounts {
  locationCount: number;
  billableSeatCount: number;
}

interface PracticeSettings {
  billingSync?: BillingSyncState;
  [k: string]: unknown;
}

export function countBillableStaffRows(
  rows: Array<{ deletedAt?: Date | string | null }>
): number {
  return rows.filter((row) => !row.deletedAt).length;
}

export async function countBillableLocationsAndSeats(
  db: Database,
  practiceId: string
): Promise<BillableCounts> {
  const [locationRow, staffRow] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(locations)
      .where(and(eq(locations.practiceId, practiceId), isNull(locations.deletedAt))),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.practiceId, practiceId), isNull(users.deletedAt))),
  ]);

  return {
    locationCount: Math.max(1, Number(locationRow[0]?.c ?? 0)),
    billableSeatCount: Math.max(0, Number(staffRow[0]?.c ?? 0)),
  };
}

async function writeBillingSyncState(
  db: Database,
  practiceId: string,
  state: BillingSyncState
): Promise<void> {
  await db
    .update(practices)
    .set({
      settings: sql`coalesce(${practices.settings}, '{}'::jsonb)
        || ${JSON.stringify({ billingSync: state })}::jsonb`,
    })
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)));
}

function buildState(
  status: BillingSyncStatus,
  message: string,
  counts: BillableCounts
): BillingSyncState {
  return {
    status,
    message,
    updatedAt: new Date().toISOString(),
    ...counts,
  };
}

export async function readBillingSyncState(
  db: Database,
  practiceId: string
): Promise<BillingSyncState | null> {
  const [practice] = await db
    .select({ settings: practices.settings })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) return null;

  const settings = (practice.settings ?? {}) as PracticeSettings;
  return settings.billingSync ?? null;
}

export async function syncPracticeSubscriptionQuantities(opts: {
  db: Database;
  practiceId: string;
  subscriptionId?: string | null;
  alertOnError?: boolean;
}): Promise<BillingSyncState> {
  const { db, practiceId } = opts;
  const [practice] = await db
    .select({
      stripeSubscriptionId: practices.stripeSubscriptionId,
      recoveryHold: practices.recoveryHold,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("share", { of: practices });

  if (!practice) {
    return buildState(
      "skipped",
      "Practice is unavailable for billing sync.",
      { locationCount: 0, billableSeatCount: 0 }
    );
  }

  if (practice.recoveryHold) {
    return buildState(
      "skipped",
      "Subscription quantity sync is paused during protected recovery.",
      { locationCount: 0, billableSeatCount: 0 }
    );
  }

  const counts = await countBillableLocationsAndSeats(db, practiceId);

  if (!billingEnforced()) {
    return buildState("skipped", "Self-host billing is not enforced.", counts);
  }

  const subscriptionId = opts.subscriptionId ?? practice.stripeSubscriptionId ?? null;
  if (!subscriptionId) {
    const state = buildState("skipped", "No Stripe subscription to sync yet.", counts);
    await writeBillingSyncState(db, practiceId, state);
    return state;
  }

  const { locationPriceId, seatPriceId } = cloudCheckoutPriceIds();
  if (!locationPriceId) {
    const state = buildState(
      "error",
      "Stripe Cloud location price ID is not configured.",
      counts
    );
    await writeBillingSyncState(db, practiceId, state);
    return state;
  }

  if (!stripe) {
    const state = buildState("error", "Stripe API key is not configured.", counts);
    await writeBillingSyncState(db, practiceId, state);
    return state;
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const items = subscription.items.data;
    const locationItem = items.find((item) => item.price?.id === locationPriceId);
    // Flat model bills locations only; legacy subscriptions may also carry a
    // per-seat item, which we keep in sync for back-compat when present.
    const seatItem = seatPriceId
      ? items.find((item) => item.price?.id === seatPriceId)
      : undefined;
    const legacyPriceId = stripePriceIdFromEnv(STRIPE_PRICE_CLOUD_LEGACY_ENV);
    const hasLegacyItem =
      !!legacyPriceId && items.some((item) => item.price?.id === legacyPriceId);

    if (!locationItem) {
      const state = buildState(
        hasLegacyItem ? "legacy" : "error",
        hasLegacyItem
          ? "Legacy Cloud subscription detected; quantity sync skipped."
          : "Stripe subscription is missing the Cloud location item.",
        counts
      );
      await writeBillingSyncState(db, practiceId, state);
      if (!hasLegacyItem && opts.alertOnError !== false) {
        await alertOps(
          "Subscription quantity sync failed",
          `${state.message} practice=${practiceId} subscription=${subscriptionId}`
        );
      }
      return state;
    }

    const updates: Promise<unknown>[] = [
      stripe.subscriptionItems.update(locationItem.id, {
        quantity: counts.locationCount,
      }),
    ];
    if (seatItem) {
      updates.push(
        stripe.subscriptionItems.update(seatItem.id, {
          quantity: counts.billableSeatCount,
        })
      );
    }

    // Checkout shows only the per-location price (one clean product for the
    // clinic); the metered overage items (AI + SMS) are attached here after
    // the subscription exists. Idempotent: only add what is missing, so this
    // also self-heals subscriptions created before overage prices existed.
    const { aiOveragePriceId, smsOveragePriceId } = cloudMeteredPriceIds();
    for (const meteredPriceId of [aiOveragePriceId, smsOveragePriceId]) {
      if (
        meteredPriceId &&
        !items.some((item) => item.price?.id === meteredPriceId)
      ) {
        updates.push(
          stripe.subscriptionItems.create({
            subscription: subscriptionId,
            price: meteredPriceId,
          })
        );
      }
    }
    await Promise.all(updates);

    const state = buildState(
      "ok",
      `Synced ${counts.locationCount} location(s)${
        seatItem ? ` and ${counts.billableSeatCount} staff seat(s)` : ", unlimited staff"
      }. Estimated base ${estimatedCloudBaseMonthlyUsd(counts.locationCount, counts.billableSeatCount)} USD/mo.`,
      counts
    );
    await writeBillingSyncState(db, practiceId, state);
    return state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const state = buildState("error", message, counts);
    await writeBillingSyncState(db, practiceId, state);
    if (opts.alertOnError !== false) {
      await alertOps(
        "Subscription quantity sync failed",
        `practice=${practiceId} subscription=${subscriptionId}: ${message}`
      );
    }
    return state;
  }
}
