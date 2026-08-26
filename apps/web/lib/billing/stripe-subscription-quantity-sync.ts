import type { Database } from "@openpims/db/client";
import { db } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { syncPracticeSubscriptionQuantities } from "./subscription-sync";
import {
  claimPracticeSubscriptionQuantitySync,
  claimStripeSubscriptionQuantitySync,
  listRetryablePracticeSubscriptionQuantitySyncs,
  listRetryableStripeSubscriptionQuantitySyncs,
  requestPracticeSubscriptionQuantitySync,
  resolvePracticeSubscriptionQuantitySync,
  resolveStripeSubscriptionQuantitySync,
} from "./stripe-events";

function completedStatus(
  result: Awaited<ReturnType<typeof syncPracticeSubscriptionQuantities>>,
) {
  return (
    result.status === "ok" ||
    result.status === "legacy" ||
    (result.status === "skipped" &&
      !result.message.toLowerCase().includes("recovery") &&
      !result.message.toLowerCase().includes("lease"))
  );
}

export async function runDurableSubscriptionQuantitySync(
  eventId: string,
  rootDb: Database = db,
): Promise<boolean> {
  const claim = await withSystem(rootDb, (tx) =>
    claimStripeSubscriptionQuantitySync(tx, { eventId, now: new Date() }),
  );
  if (claim.state === "none") return true;
  if (claim.state === "busy") return false;
  let completed = false;
  try {
    completed = completedStatus(
      await syncPracticeSubscriptionQuantities({
        db: rootDb,
        practiceId: claim.job.practiceId,
        subscriptionId: claim.job.subscriptionId,
        leaseToken: claim.job.leaseToken,
        leaseExpiresAt: claim.job.leaseExpiresAt,
        alertOnError: false,
        idempotencyKeyPrefix: `stripe-event:${eventId}`,
      }),
    );
  } catch {
    completed = false;
  }
  const resolved = await withSystem(rootDb, (tx) =>
    resolveStripeSubscriptionQuantitySync(tx, {
      eventId,
      leaseToken: claim.job.leaseToken,
      outcome: completed ? "completed" : "retry",
    }),
  );
  if (!resolved)
    throw new Error("Subscription quantity job lease CAS was lost.");
  if (!completed) {
    await alertOps(
      "Subscription quantity reconciliation deferred",
      `event=${boundedIdentifier(eventId)} remains durably retryable`,
    );
  }
  return completed;
}

export async function requestAndRunPracticeSubscriptionQuantitySync(
  practiceId: string,
  rootDb: Database = db,
): Promise<boolean> {
  const requested = await withSystem(rootDb, (tx) =>
    requestPracticeSubscriptionQuantitySync(tx, { practiceId }),
  );
  if (!requested) return true;
  return runDurablePracticeSubscriptionQuantitySync(practiceId, rootDb);
}

export async function runDurablePracticeSubscriptionQuantitySync(
  practiceId: string,
  rootDb: Database = db,
): Promise<boolean> {
  const claim = await withSystem(rootDb, (tx) =>
    claimPracticeSubscriptionQuantitySync(tx, { practiceId, now: new Date() }),
  );
  if (claim.state === "none") return true;
  if (claim.state === "busy") return false;
  let completed = false;
  try {
    completed = completedStatus(
      await syncPracticeSubscriptionQuantities({
        db: rootDb,
        practiceId,
        subscriptionId: claim.job.subscriptionId,
        leaseToken: claim.job.leaseToken,
        leaseExpiresAt: claim.job.leaseExpiresAt,
        alertOnError: false,
        idempotencyKeyPrefix: `practice:${practiceId}:subscription:${claim.job.subscriptionId}:revision:${claim.job.requestedRevision}`,
      }),
    );
  } catch {
    completed = false;
  }
  const resolved = await withSystem(rootDb, (tx) =>
    resolvePracticeSubscriptionQuantitySync(tx, {
      practiceId,
      leaseToken: claim.job.leaseToken,
      requestedRevision: claim.job.requestedRevision,
      outcome: completed ? "completed" : "retry",
    }),
  );
  if (!resolved) throw new Error("Practice quantity job lease CAS was lost.");
  if (!completed) {
    await alertOps(
      "Practice subscription quantity reconciliation deferred",
      `practice=${boundedIdentifier(practiceId)} revision=${claim.job.requestedRevision} remains durably retryable`,
    );
  }
  return completed;
}

export async function runDurableSubscriptionQuantitySyncBatch(
  limit = 25,
): Promise<{ candidates: number; completed: number; deferred: number }> {
  const eventIds = await withSystem(db, (tx) =>
    listRetryableStripeSubscriptionQuantitySyncs(tx, {
      now: new Date(),
      limit,
    }),
  );
  let completed = 0;
  for (const eventId of eventIds) {
    if (await runDurableSubscriptionQuantitySync(eventId)) completed++;
  }
  return {
    candidates: eventIds.length,
    completed,
    deferred: eventIds.length - completed,
  };
}

export async function runDurablePracticeSubscriptionQuantitySyncBatch(
  limit = 25,
): Promise<{ candidates: number; completed: number; deferred: number }> {
  const practiceIds = await withSystem(db, (tx) =>
    listRetryablePracticeSubscriptionQuantitySyncs(tx, {
      now: new Date(),
      limit,
    }),
  );
  let completed = 0;
  for (const practiceId of practiceIds) {
    if (await runDurablePracticeSubscriptionQuantitySync(practiceId))
      completed++;
  }
  return {
    candidates: practiceIds.length,
    completed,
    deferred: practiceIds.length - completed,
  };
}

function boundedIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 128) || "unknown";
}
