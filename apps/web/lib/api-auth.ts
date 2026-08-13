import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq, and, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { apiKeys, practices } from "@openpims/db";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import { clientIpFromRequest } from "@/lib/request-ip";
import { API_KEY_HASH_COST } from "@/lib/auth-hashing";

/** Public prefix for every issued key. Also used as the human-visible label. */
export const API_KEY_PREFIX = "ovpm_";
/** Length of the stored, indexed lookup prefix (e.g. "ovpm_AbC1234"). */
const LOOKUP_PREFIX_LEN = 12;
/** Hard cap for presented keys so public auth can't spend work on huge inputs. */
const API_KEY_MAX_LENGTH = 128;
const API_KEY_BODY_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Per-key request budget, enforced by the durable Postgres rate limiter. */
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;
const AUTH_ATTEMPT_RATE_LIMIT = 1_200;
const AUTH_ATTEMPT_RATE_WINDOW_MS = 60_000;

export interface ApiKeyContext {
  practiceId: string;
  apiKeyId: string;
  scopes: string[];
}

export type AuthResult =
  | { ok: true; ctx: ApiKeyContext }
  | { ok: false; response: NextResponse };

export function apiScopeCanMutate(requiredScope: string): boolean {
  return requiredScope.endsWith(":write") || requiredScope === "agent:run";
}

/**
 * Generate a new API key. Returns the raw key (shown to the user exactly once),
 * the indexed lookup prefix, and the bcrypt hash to persist. The raw key is
 * never stored.
 */
export async function generateApiKey(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const raw = API_KEY_PREFIX + randomBytes(24).toString("base64url");
  const prefix = raw.slice(0, LOOKUP_PREFIX_LEN);
  const hash = await bcrypt.hash(raw, API_KEY_HASH_COST);
  return { raw, prefix, hash };
}

/** Extract the raw key from `Authorization: Bearer` (preferred) or `X-API-Key`. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const headerKey = headers.get("x-api-key");
  if (headerKey) return headerKey.trim();
  return null;
}

/** `*` grants everything; otherwise the exact scope must be present. */
export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

function hasApiKeyShape(raw: string): boolean {
  if (!raw.startsWith(API_KEY_PREFIX)) return false;
  if (raw.length <= LOOKUP_PREFIX_LEN) return false;
  if (raw.length > API_KEY_MAX_LENGTH) return false;
  return API_KEY_BODY_PATTERN.test(raw.slice(API_KEY_PREFIX.length));
}

function err(message: string, status: number): { ok: false; response: NextResponse } {
  return {
    ok: false,
    response: NextResponse.json({ error: { message } }, { status }),
  };
}

function rateLimitErr(
  message: string,
  limit: number,
  remaining: number,
  resetAt: Date
): {
  ok: false;
  response: NextResponse;
} {
  return {
    ok: false,
    response: NextResponse.json(
      { error: { message } },
      {
        status: 429,
        headers: rateLimitResponseHeaders(limit, { remaining, resetAt }),
      }
    ),
  };
}

async function enforceApiKeyAuthAttemptLimit(
  req: Request
): Promise<AuthResult | null> {
  const ip = clientIpFromRequest(req);
  try {
    const attemptLimit = await rateLimit({
      key: `apikey-auth:${ip}`,
      limit: AUTH_ATTEMPT_RATE_LIMIT,
      windowMs: AUTH_ATTEMPT_RATE_WINDOW_MS,
    });

    if (!attemptLimit.success) {
      return rateLimitErr(
        "Too many API key authentication attempts.",
        AUTH_ATTEMPT_RATE_LIMIT,
        attemptLimit.remaining,
        attemptLimit.resetAt
      );
    }
  } catch (e) {
    console.error("[api-auth] auth attempt rate limit failed:", e);
    return err("Internal error", 500);
  }

  return null;
}

/**
 * Authenticate a request via API key and assert it carries `requiredScope`.
 *
 * Flow: parse header → narrow candidates by indexed prefix → constant-time
 * bcrypt compare → active-practice check → scope check → enforce per-key rate
 * limit → return tenant context. The caller MUST still scope every query by
 * `ctx.practiceId`.
 */
export async function authenticateApiKey(
  req: Request,
  requiredScope: string
): Promise<AuthResult> {
  const attemptLimit = await enforceApiKeyAuthAttemptLimit(req);
  if (attemptLimit) return attemptLimit;

  const raw = extractApiKey(req.headers);
  if (!raw) {
    return err("Missing API key. Send 'Authorization: Bearer <key>' or 'X-API-Key'.", 401);
  }

  if (!hasApiKeyShape(raw)) {
    return err("Invalid API key.", 401);
  }

  const prefix = raw.slice(0, LOOKUP_PREFIX_LEN);

  let candidates;
  try {
    // Key lookup spans tenants (we don't know the practice yet) → system context.
    candidates = await withSystem(db, (tx) =>
      tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.deletedAt)))
    );
  } catch (e) {
    console.error("[api-auth] key lookup failed:", e);
    return err("Internal error", 500);
  }

  let matched: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (await bcrypt.compare(raw, candidate.keyHash)) {
      matched = candidate;
      break;
    }
  }

  if (!matched) {
    return err("Invalid API key.", 401);
  }

  let practice:
    | {
        tier: string | null;
        billingStatus: string | null;
        trialEndsAt: Date | string | null;
        recoveryHold: boolean;
      }
    | undefined;
  try {
    [practice] = await withSystem(db, (tx) =>
      tx
        .select({
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
          recoveryHold: practices.recoveryHold,
        })
        .from(practices)
        .where(
          and(
            eq(practices.id, matched.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .limit(1)
    );
  } catch (e) {
    console.error("[api-auth] practice lookup failed:", e);
    return err("Internal error", 500);
  }

  if (!practice) {
    return err("Invalid API key.", 401);
  }

  const scopes = Array.isArray(matched.scopes) ? (matched.scopes as string[]) : [];
  if (!hasScope(scopes, requiredScope)) {
    return err(`API key missing required scope: ${requiredScope}`, 403);
  }

  const writeLikeScope = apiScopeCanMutate(requiredScope);
  if (writeLikeScope && practice.recoveryHold) {
    return err(
      "This clinic is in protected data review mode. API changes and agent runs remain paused.",
      423,
    );
  }

  // Hosted read-only mode still allows read scopes. Write scopes and agent runs
  // require an active trial/subscription. Self-host skips this entirely.
  if (billingEnforced()) {
    if (writeLikeScope && !hasHostedFullAccess(
      practice.tier,
      practice.billingStatus,
      practice.trialEndsAt
    )) {
      return err(
        "OpenVPM Cloud is read-only until your trial or subscription is active.",
        403
      );
    }
  }

  let keyLimit;
  try {
    keyLimit = await rateLimit({
      key: `apikey:${matched.id}`,
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
    });
  } catch (e) {
    console.error("[api-auth] per-key rate limit failed:", e);
    return err("Internal error", 500);
  }

  const { success } = keyLimit;
  if (!success) {
    return rateLimitErr(
      "Rate limit exceeded.",
      RATE_LIMIT,
      keyLimit.remaining,
      keyLimit.resetAt
    );
  }

  // Audit trail — non-blocking, never fail the request on this.
  void withSystem(db, (tx) =>
    tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, matched.id))
  ).catch((e) => console.error("[api-auth] lastUsedAt update failed:", e));

  return {
    ok: true,
    ctx: { practiceId: matched.practiceId, apiKeyId: matched.id, scopes },
  };
}

/** Scopes a practice admin can grant to an API key. */
export const API_SCOPES = [
  "clients:read",
  "patients:read",
  "appointments:read",
  "appointments:write",
  "records:write",
  "agent:run",
  "agent:write",
  "*",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function apiScopesHaveValidDependencies(
  scopes: readonly ApiScope[]
): boolean {
  return (
    !scopes.includes("agent:write") ||
    scopes.includes("agent:run") ||
    scopes.includes("*")
  );
}
