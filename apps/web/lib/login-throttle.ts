import { createHash } from "node:crypto";
import {
  backoffLockMs,
  cleanupExpiredRateLimitBuckets,
  clearRateLimit,
  clearRateLimitPrefix,
  consumeBackoffAttempt,
  rateLimit,
  readBackoffBuckets,
  recordBackoffAttempt,
  refundRateLimit,
  type BackoffPolicy,
} from "@/lib/rate-limit";
import {
  isNonPublicIp,
  normalizeIp,
  TRUSTED_PROXY_HOPS_ENV,
  type ResolvedClientIp,
} from "@/lib/request-ip";

/**
 * Credentials sign-in throttling.
 *
 * - Per account (primary): 5 free failures, then a lock that starts at one
 *   minute and doubles per further failure up to one hour. The streak resets
 *   on success or after 24 hours without a counted failure. Applies the same
 *   way whether or not the account exists. Budget is reserved before the
 *   password is checked, so parallel guesses can't race past it, and a
 *   successful sign-in gives its reservation back.
 * - Known devices: a successful sign-in sets a signed device cookie (see
 *   `@/lib/known-device`). A browser with a valid cookie for the account is
 *   not held by the account-wide lock; it runs the same backoff on its own
 *   per-(account, device) streak, and its failures also count toward the
 *   account-wide streak. Someone failing from elsewhere can't keep the owner
 *   out of their usual browser, while someone holding the correct password on
 *   a new device is still held by the account lock. Per-IP limits never apply
 *   to a known device.
 * - Per client IP, only when the address is verified (Vercel, or
 *   OPENVPM_TRUSTED_PROXY_HOPS) and public: 50 failed attempts per 15 minutes
 *   against guessing across many accounts, plus a 600-request cap per 15
 *   minutes that successes don't refund, bounding how fast one address can
 *   hammer locked accounts. An unverified address can be forged at will, so
 *   limiting it would only let someone lock out the address they claim;
 *   per-account backoff is the defense there. Non-public addresses (loopback,
 *   private, CGNAT, link-local) are almost always a proxy or container
 *   gateway that every client shares, so they aren't limited either.
 */
export const LOGIN_ACCOUNT_BACKOFF: BackoffPolicy = {
  freeAttempts: 5,
  baseLockMs: 60 * 1000,
  maxLockMs: 60 * 60 * 1000,
  streakMs: 24 * 60 * 60 * 1000,
};

/** Failed attempts per verified IP; successes are refunded. */
export const LOGIN_IP_FAILURE_LIMIT = {
  limit: 50,
  windowMs: 15 * 60 * 1000,
} as const;

/** All attempts per verified IP from unknown devices; never refunded. */
export const LOGIN_IP_REQUEST_LIMIT = {
  limit: 600,
  windowMs: 15 * 60 * 1000,
} as const;

export interface LoginThrottleKeys {
  accountKey: string;
  /** Per-IP buckets; null for unverified or non-public addresses. */
  ip: { failureKey: string; requestKey: string } | null;
  /** Backoff streak for this account on a known device, when there is one. */
  deviceAccountKey: string | null;
}

/** Per-IP bucket for a sign-in, or null when per-IP limits don't apply. */
export function loginIpBucket(client: ResolvedClientIp): string | null {
  return loginNetworkBucket(client.ip);
}

/** Network bucket for an already-verified address, or null if non-public. */
export function loginNetworkBucket(ip: string | null | undefined): string | null {
  const normalized = normalizeIp(ip);
  if (!normalized || isNonPublicIp(normalized)) return null;
  return ipPrefixBucket(normalized);
}

/**
 * IPv6 clients usually control a whole /64, so bucket them by that prefix;
 * otherwise rotating addresses would sidestep the per-IP limit.
 */
export function ipPrefixBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const prefix = ipv6Prefix64(ip);
  return prefix ? `${prefix}::/64` : ip;
}

function ipv6Prefix64(ip: string): string | null {
  const [head = "", tail] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  // A dotted IPv4 tail occupies the last 32 bits, never the /64 prefix.
  const tailGroupCount = tailGroups.reduce(
    (n, group) => n + (group.includes(".") ? 2 : 1),
    0
  );
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroupCount;
  if (missing < 0) return null;
  const groups = [
    ...headGroups,
    ...Array<string>(missing).fill("0"),
    ...tailGroups,
  ];
  const prefix = groups.slice(0, 4);
  if (prefix.length < 4 || prefix.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return prefix.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function loginAccountKey(email: string): string {
  return `login:account:${normalizeEmail(email)}`;
}

/** Fixed-length account id for keys that also carry a device id. */
function accountHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 32);
}

function deviceAccountKeyPrefix(email: string): string {
  return `login:account-dev:${accountHash(email)}:`;
}

export function loginThrottleKeys(
  email: string,
  ipBucket: string | null,
  deviceId: string | null = null
): LoginThrottleKeys {
  return {
    accountKey: loginAccountKey(email),
    ip: ipBucket
      ? {
          failureKey: `login:ip:${ipBucket}`,
          requestKey: `login:ip-req:${ipBucket}`,
        }
      : null,
    deviceAccountKey: deviceId ? `${deviceAccountKeyPrefix(email)}${deviceId}` : null,
  };
}

export type LoginAttemptGate =
  | {
      allowed: true;
      /** Per-IP failure reservation, given back on success. */
      ipReservation: { key: string; resetAt: Date } | null;
      /** Gated by the known-device streak instead of the account lock. */
      knownDevice: boolean;
    }
  | { allowed: false; retryAt: Date };

async function refund(reservation: { key: string; resetAt: Date } | null) {
  if (!reservation) return;
  await refundRateLimit(reservation.key, reservation.resetAt).catch((err) => {
    console.error("[auth] login rate limit refund failed:", err);
  });
}

/**
 * Reserves one failure against the buckets that gate this attempt. Throws if
 * the store is unavailable; callers fail closed.
 */
export async function reserveLoginAttempt(
  keys: LoginThrottleKeys,
  now: Date = new Date()
): Promise<LoginAttemptGate> {
  if (keys.deviceAccountKey) {
    const device = await consumeBackoffAttempt({
      key: keys.deviceAccountKey,
      policy: LOGIN_ACCOUNT_BACKOFF,
      now,
    });
    return device.success
      ? { allowed: true, ipReservation: null, knownDevice: true }
      : { allowed: false, retryAt: device.retryAt };
  }

  let ipReservation: { key: string; resetAt: Date } | null = null;
  if (keys.ip) {
    const requests = await rateLimit({
      key: keys.ip.requestKey,
      ...LOGIN_IP_REQUEST_LIMIT,
      now,
    });
    if (!requests.success) return { allowed: false, retryAt: requests.resetAt };
    const failures = await rateLimit({
      key: keys.ip.failureKey,
      ...LOGIN_IP_FAILURE_LIMIT,
      now,
    });
    if (!failures.success) return { allowed: false, retryAt: failures.resetAt };
    ipReservation = { key: keys.ip.failureKey, resetAt: failures.resetAt };
  }

  let account: Awaited<ReturnType<typeof consumeBackoffAttempt>>;
  try {
    account = await consumeBackoffAttempt({
      key: keys.accountKey,
      policy: LOGIN_ACCOUNT_BACKOFF,
      now,
    });
  } catch (err) {
    await refund(ipReservation);
    throw err;
  }
  if (!account.success) {
    // Attempts against a locked account never reach the password check, so
    // they don't spend the failure budget of everyone else on that network.
    await refund(ipReservation);
    return { allowed: false, retryAt: account.retryAt };
  }
  return { allowed: true, ipReservation, knownDevice: false };
}

/**
 * A failed sign-in from a known device also counts toward the account-wide
 * streak, which didn't gate it. Other failures were already counted when the
 * attempt was reserved.
 */
export async function recordLoginFailure(
  keys: LoginThrottleKeys,
  gate: Extract<LoginAttemptGate, { allowed: true }>,
  now: Date = new Date()
): Promise<void> {
  if (!gate.knownDevice) return;
  await recordBackoffAttempt({
    key: keys.accountKey,
    policy: LOGIN_ACCOUNT_BACKOFF,
    now,
  }).catch((err) => {
    console.error("[auth] login account failure record failed:", err);
  });
}

/**
 * A successful sign-in returns its failure reservation and resets the streak
 * that gated it. Success on a known device leaves the account-wide streak
 * alone, so the owner signing in doesn't reset the backoff of someone
 * guessing from elsewhere.
 */
export async function releaseLoginAttempt(
  keys: LoginThrottleKeys,
  gate: Extract<LoginAttemptGate, { allowed: true }>
): Promise<void> {
  const streakKey =
    gate.knownDevice && keys.deviceAccountKey ? keys.deviceAccountKey : keys.accountKey;
  await Promise.all([
    clearRateLimit(streakKey).catch((err) => {
      console.error("[auth] login account limit reset failed:", err);
    }),
    refund(gate.ipReservation),
  ]);
}

/**
 * Clears every sign-in lock on the account: account-wide and each known
 * device's streak. Used once the owner proves control of the mailbox, e.g.
 * by resetting the password or accepting an invite, and when an admin
 * unlocks a staff member.
 */
export async function clearLoginAccountLock(email: string): Promise<void> {
  await Promise.all([
    clearRateLimit(loginAccountKey(email)),
    clearRateLimitPrefix(deviceAccountKeyPrefix(email)),
  ]);
}

/** Accounts whose account-wide sign-in lock is in force, with unlock times. */
export async function loginAccountLocks(
  emails: string[],
  now: Date = new Date()
): Promise<Map<string, Date>> {
  const keys = new Map(emails.map((email) => [loginAccountKey(email), email]));
  const states = await readBackoffBuckets([...keys.keys()], now);
  const locks = new Map<string, Date>();
  for (const [key, state] of states) {
    const lockMs = backoffLockMs(LOGIN_ACCOUNT_BACKOFF, state.count);
    const retryAt = new Date(state.updatedAt.getTime() + lockMs);
    if (lockMs > 0 && retryAt > now) locks.set(keys.get(key)!, retryAt);
  }
  return locks;
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanupAt = 0;

/**
 * Deletes expired rate-limit rows at most once an hour per server process,
 * so the table stays bounded on deployments that don't run the
 * `/api/cron/rate-limit-cleanup` job (self-hosts have no scheduler). Skipped
 * on Vercel, where that cron runs. Runs in the background; never delays or
 * fails the sign-in.
 */
export function cleanupRateLimitsOccasionally(now: Date = new Date()): void {
  if (process.env.VERCEL === "1") return;
  if (now.getTime() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now.getTime();
  void cleanupExpiredRateLimitBuckets({ now }).catch((err) => {
    console.error("[auth] rate limit cleanup failed:", err);
  });
}

let warnedUnverifiedIp = false;

export function warnUnverifiedLoginIpOnce(client: ResolvedClientIp): void {
  if (client.ip || warnedUnverifiedIp) return;
  warnedUnverifiedIp = true;
  console.warn(
    client.source === "unverified"
      ? `[auth] Sign-in client IPs can't be verified, so per-IP sign-in limits are off; per-account limits still apply. If OpenVPM runs behind a reverse proxy, set ${TRUSTED_PROXY_HOPS_ENV} to the number of proxies in front of it.`
      : `[auth] Sign-in request had no usable client IP from the ${client.source} source; per-IP sign-in limits were skipped.`
  );
}
