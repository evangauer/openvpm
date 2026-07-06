import { createHash } from "node:crypto";
import { eq, lt, sql } from "drizzle-orm";
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
