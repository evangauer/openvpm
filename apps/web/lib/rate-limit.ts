import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { rateLimitBuckets } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

export const RATE_LIMIT_KEY_MAX_LENGTH = 255;
const HASH_SUFFIX_LENGTH = 64;
const HASH_SEPARATOR = ":sha256:";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
}

export function rateLimitRetryAfterSeconds(
  resetAt: Date,
  now: Date = new Date()
): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
}

export function rateLimitResponseHeaders(
  limit: number,
  result: Pick<RateLimitResult, "remaining" | "resetAt">
): Record<string, string> {
  return {
    "Retry-After": String(rateLimitRetryAfterSeconds(result.resetAt)),
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": result.resetAt.toISOString(),
  };
}

export function normalizeRateLimitKey(key: string): string {
  if (key.length <= RATE_LIMIT_KEY_MAX_LENGTH) return key;

  const hash = createHash("sha256").update(key).digest("hex");
  const prefixLength =
    RATE_LIMIT_KEY_MAX_LENGTH - HASH_SEPARATOR.length - HASH_SUFFIX_LENGTH;
  return `${key.slice(0, prefixLength)}${HASH_SEPARATOR}${hash}`;
}

/**
 * Durable fixed-window rate limiter backed by Postgres. This works across
 * serverless instances and process restarts, unlike the old in-memory Map.
 */
export async function rateLimit(options: {
  key: string;
  limit: number;
  windowMs: number;
  now?: Date;
}): Promise<RateLimitResult> {
  const now = options.now ?? new Date();
  const resetAt = new Date(now.getTime() + options.windowMs);
  const nowIso = now.toISOString();
  const resetAtIso = resetAt.toISOString();
  const key = normalizeRateLimitKey(options.key);

  const [bucket] = await withSystem(db, (tx) =>
    tx
      .insert(rateLimitBuckets)
      .values({
        key,
        count: 1,
        resetAt,
      })
      .onConflictDoUpdate({
        target: rateLimitBuckets.key,
        set: {
          count: sql<number>`case when ${rateLimitBuckets.resetAt} <= ${nowIso}::timestamptz then 1 else ${rateLimitBuckets.count} + 1 end`,
          resetAt: sql<Date>`case when ${rateLimitBuckets.resetAt} <= ${nowIso}::timestamptz then ${resetAtIso}::timestamptz else ${rateLimitBuckets.resetAt} end`,
          updatedAt: now,
        },
      })
      .returning({
        count: rateLimitBuckets.count,
        resetAt: rateLimitBuckets.resetAt,
      })
  );

  const count = bucket?.count ?? options.limit + 1;
  const bucketResetAt = bucket?.resetAt ?? resetAt;
  return {
    success: count <= options.limit,
    remaining: Math.max(options.limit - count, 0),
    resetAt: bucketResetAt,
  };
}

/**
 * Gives back one unit reserved by `rateLimit`, used when a guarded action
 * turned out not to count (for example a successful sign-in). Matching on
 * `resetAt` keeps a late refund from leaking into the next window.
 */
export async function refundRateLimit(key: string, resetAt: Date): Promise<void> {
  const normalizedKey = normalizeRateLimitKey(key);
  await withSystem(db, (tx) =>
    tx
      .update(rateLimitBuckets)
      .set({
        count: sql<number>`greatest(${rateLimitBuckets.count} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(rateLimitBuckets.key, normalizedKey),
          eq(rateLimitBuckets.resetAt, resetAt)
        )
      )
  );
}

export interface BackoffPolicy {
  /** Attempts allowed before the first lock. */
  freeAttempts: number;
  /** Lock after the last free attempt; doubles with each further attempt. */
  baseLockMs: number;
  maxLockMs: number;
  /** The streak is forgotten this long after its last counted attempt. */
  streakMs: number;
}

export interface BackoffBucketState {
  count: number;
  resetAt: Date;
  updatedAt: Date;
}

export type BackoffDecision =
  | { success: true; next: BackoffBucketState }
  | { success: false; retryAt: Date };

export function backoffLockMs(policy: BackoffPolicy, attempts: number): number {
  if (attempts < policy.freeAttempts) return 0;
  const doublings = Math.min(attempts - policy.freeAttempts, 30);
  return Math.min(policy.maxLockMs, policy.baseLockMs * 2 ** doublings);
}

/**
 * Pure decision for one attempt against an exponential-backoff bucket. A
 * locked bucket is left untouched, so retrying while locked neither extends
 * nor shortens the lock.
 */
export function backoffDecision(
  policy: BackoffPolicy,
  state: BackoffBucketState | null | undefined,
  now: Date
): BackoffDecision {
  const active = state && state.resetAt.getTime() > now.getTime() ? state : null;
  const attempts = active?.count ?? 0;
  if (active) {
    const lockMs = backoffLockMs(policy, attempts);
    const retryAt = new Date(active.updatedAt.getTime() + lockMs);
    if (lockMs > 0 && retryAt.getTime() > now.getTime()) {
      return { success: false, retryAt };
    }
  }
  return {
    success: true,
    next: {
      count: attempts + 1,
      resetAt: new Date(now.getTime() + policy.streakMs),
      updatedAt: now,
    },
  };
}

/**
 * Counts one attempt against an exponential-backoff bucket, or reports when
 * the bucket unlocks. The row is locked for the decision so concurrent
 * attempts cannot all slip past the same check. Callers clear the bucket
 * (`clearRateLimit`) when the attempt succeeds.
 */
export async function consumeBackoffAttempt(options: {
  key: string;
  policy: BackoffPolicy;
  now?: Date;
}): Promise<{ success: true } | { success: false; retryAt: Date }> {
  const now = options.now ?? new Date();
  const key = normalizeRateLimitKey(options.key);

  return withSystem(db, async (tx) => {
    await tx
      .insert(rateLimitBuckets)
      .values({
        key,
        count: 0,
        resetAt: new Date(now.getTime() + options.policy.streakMs),
        updatedAt: now,
      })
      .onConflictDoNothing({ target: rateLimitBuckets.key });
    const [state] = await tx
      .select({
        count: rateLimitBuckets.count,
        resetAt: rateLimitBuckets.resetAt,
        updatedAt: rateLimitBuckets.updatedAt,
      })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, key))
      .for("update");

    const decision = backoffDecision(options.policy, state, now);
    if (!decision.success) return decision;

    await tx
      .update(rateLimitBuckets)
      .set(decision.next)
      .where(eq(rateLimitBuckets.key, key));
    return { success: true as const };
  });
}

export async function clearRateLimit(key: string): Promise<void> {
  const normalizedKey = normalizeRateLimitKey(key);
  await withSystem(db, (tx) =>
    tx.delete(rateLimitBuckets).where(eq(rateLimitBuckets.key, normalizedKey))
  );
}

export async function cleanupExpiredRateLimitBuckets(options: {
  now?: Date;
} = {}): Promise<{ deleted: number; cutoff: Date }> {
  const cutoff = options.now ?? new Date();
  const deleted = await withSystem(db, (tx) =>
    tx
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.resetAt, cutoff))
      .returning({ key: rateLimitBuckets.key })
  );

  return {
    deleted: deleted.length,
    cutoff,
  };
}
