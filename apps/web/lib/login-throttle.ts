import { createHash } from "node:crypto";
import {
  backoffLockMs,
  clearRateLimit,
  clearRateLimitPrefix,
  consumeBackoffAttempt,
  rateLimit,
  rateLimitKeyActive,
  readBackoffBuckets,
  recordBackoffAttempt,
  refundRateLimit,
  rememberRateLimitKey,
  type BackoffPolicy,
} from "@/lib/rate-limit";
import {
  isNonPublicIp,
  normalizeIp,
  TRUSTED_PROXY_HOPS_ENV,
  unverifiedForwardedIp,
  type ResolvedClientIp,
} from "@/lib/request-ip";

/**
 * Credentials sign-in throttling.
 *
 * Only failed attempts spend budget. Every attempt reserves budget before the
 * password is checked, so parallel guesses cannot race past a limit, and a
 * successful sign-in gives its reservation back.
 *
 * - Per account (primary): 5 free failures, then a lock that starts at one
 *   minute and doubles per further failure up to one hour. The streak resets
 *   on success or after 24 hours without a counted failure. Applies the same
 *   way whether or not the account exists.
 * - Per client IP (secondary, against guessing across many accounts): failed
 *   attempts only, sized so a whole clinic behind one NAT stays well clear.
 *   When the deployment can't verify client addresses (a self-host without
 *   OPENVPM_TRUSTED_PROXY_HOPS), the address the request claims is used
 *   instead, with only the short window. A forged address can dodge that
 *   limit, which per-account backoff covers, but there is deliberately no
 *   bucket shared by every client, so failures can't lock out the clinic.
 *   Non-public addresses (loopback, private, CGNAT, link-local) are never
 *   limited per IP: they are almost always a proxy or container gateway that
 *   isn't forwarding the client's address, so limiting them would let one
 *   client lock everyone out.
 * - Known networks: each successful sign-in remembers the account's IP bucket
 *   for 90 days. From a known bucket, the account-wide lock doesn't apply;
 *   instead the same backoff runs on a streak scoped to that account and
 *   bucket. So someone failing from elsewhere can't keep the owner out of
 *   their usual network, while guessing from a known bucket is throttled just
 *   as hard (its failures also count toward the account-wide streak). Someone
 *   holding the correct password but on a new network is still held by the
 *   account lock. Where addresses are unverified, a guesser who claims one of
 *   the owner's known addresses gains one more backoff streak per known
 *   bucket, not unthrottled guesses.
 */
export const LOGIN_ACCOUNT_BACKOFF: BackoffPolicy = {
  freeAttempts: 5,
  baseLockMs: 60 * 1000,
  maxLockMs: 60 * 60 * 1000,
  streakMs: 24 * 60 * 60 * 1000,
};

const IP_WINDOW = { scope: "ip", limit: 50, windowMs: 15 * 60 * 1000 } as const;

export const LOGIN_IP_LIMITS = [
  IP_WINDOW,
  { scope: "ip-day", limit: 1000, windowMs: 24 * 60 * 60 * 1000 },
] as const;

export const LOGIN_UNVERIFIED_IP_LIMITS = [
  { ...IP_WINDOW, scope: "ip-unverified" },
] as const;

/** How long a successful sign-in keeps its network known for the account. */
export const LOGIN_KNOWN_NETWORK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface LoginThrottleKeys {
  accountKey: string;
  ipKeys: { key: string; limit: number; windowMs: number }[];
  /** Present when the request has a usable IP bucket. */
  network: {
    /** Marker row: the account has signed in from this bucket. */
    knownKey: string;
    /** Backoff streak for this account from this bucket. */
    accountKey: string;
  } | null;
}

/** Per-IP bucket for a sign-in, or null when per-IP limits don't apply. */
export interface LoginIpBucket {
  bucket: string;
  verified: boolean;
}

/**
 * Picks the address sign-in limits are keyed on. A verified address is used
 * as is. Without one, the request's claimed address is used; a loopback
 * claim means a local proxy that isn't forwarding client addresses, which
 * would put every client in one bucket, so per-IP limits are skipped then.
 */
export function loginIpBucket(
  client: ResolvedClientIp,
  req?: unknown
): LoginIpBucket | null {
  if (client.ip) {
    if (isNonPublicIp(client.ip)) return null;
    return { bucket: ipPrefixBucket(client.ip), verified: true };
  }
  if (client.source !== "unverified") return null;
  const claimed = unverifiedForwardedIp(req);
  if (!claimed || isNonPublicIp(claimed)) return null;
  return { bucket: ipPrefixBucket(claimed), verified: false };
}

/** Sign-in network bucket for an already-resolved address (e.g. `ctx.ip`). */
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

/** Fixed-length account id for keys that also carry a network bucket. */
function accountHash(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 32);
}

function networkAccountKeyPrefix(email: string): string {
  return `login:account-net:${accountHash(email)}:`;
}

export function loginKnownNetworkKey(email: string, bucket: string): string {
  return `login:known:${accountHash(email)}:${bucket}`;
}

export function loginThrottleKeys(
  email: string,
  ip: LoginIpBucket | null
): LoginThrottleKeys {
  const limits = !ip ? [] : ip.verified ? LOGIN_IP_LIMITS : LOGIN_UNVERIFIED_IP_LIMITS;
  return {
    accountKey: loginAccountKey(email),
    ipKeys: limits.map(({ scope, limit, windowMs }) => ({
      key: `login:${scope}:${ip!.bucket}`,
      limit,
      windowMs,
    })),
    network: ip
      ? {
          knownKey: loginKnownNetworkKey(email, ip.bucket),
          accountKey: `${networkAccountKeyPrefix(email)}${ip.bucket}`,
        }
      : null,
  };
}

export type LoginAttemptGate =
  | {
      allowed: true;
      ipReservations: { key: string; resetAt: Date }[];
      /** Gated by the known-network streak instead of the account lock. */
      knownNetwork: boolean;
    }
  | { allowed: false; retryAt: Date };

async function refundAll(reservations: { key: string; resetAt: Date }[]) {
  await Promise.all(
    reservations.map(({ key, resetAt }) =>
      refundRateLimit(key, resetAt).catch((err) => {
        console.error("[auth] login rate limit refund failed:", err);
      })
    )
  );
}

/**
 * Reserves one failure against every login bucket. Throws if the store is
 * unavailable; callers fail closed.
 */
export async function reserveLoginAttempt(
  keys: LoginThrottleKeys,
  now: Date = new Date()
): Promise<LoginAttemptGate> {
  const ipResults = await Promise.all(
    keys.ipKeys.map(async (bucket) => ({
      key: bucket.key,
      result: await rateLimit({ ...bucket, now }),
    }))
  );
  const reserved = ipResults
    .filter(({ result }) => result.success)
    .map(({ key, result }) => ({ key, resetAt: result.resetAt }));
  const blocked = ipResults.filter(({ result }) => !result.success);
  if (blocked.length > 0) {
    await refundAll(reserved);
    const retryAt = Math.max(...blocked.map(({ result }) => result.resetAt.getTime()));
    return { allowed: false, retryAt: new Date(retryAt) };
  }

  let account: Awaited<ReturnType<typeof consumeBackoffAttempt>>;
  let knownNetwork = false;
  try {
    knownNetwork = keys.network
      ? await rateLimitKeyActive(keys.network.knownKey, now)
      : false;
    account = await consumeBackoffAttempt({
      key: knownNetwork ? keys.network!.accountKey : keys.accountKey,
      policy: LOGIN_ACCOUNT_BACKOFF,
      now,
    });
  } catch (err) {
    await refundAll(reserved);
    throw err;
  }
  if (!account.success) {
    // Attempts against a locked account never reach the password check, so
    // they don't spend the shared IP budget of everyone else on that network.
    await refundAll(reserved);
    return { allowed: false, retryAt: account.retryAt };
  }
  return { allowed: true, ipReservations: reserved, knownNetwork };
}

/**
 * A failed sign-in from a known network also counts toward the account-wide
 * streak, which didn't gate it. Other failures were already counted when the
 * attempt was reserved.
 */
export async function recordLoginFailure(
  keys: LoginThrottleKeys,
  gate: Extract<LoginAttemptGate, { allowed: true }>,
  now: Date = new Date()
): Promise<void> {
  if (!gate.knownNetwork) return;
  await recordBackoffAttempt({
    key: keys.accountKey,
    policy: LOGIN_ACCOUNT_BACKOFF,
    now,
  }).catch((err) => {
    console.error("[auth] login account failure record failed:", err);
  });
}

/**
 * A successful sign-in returns its reservations, resets the streak that gated
 * it, and remembers the network. Success from a known network leaves the
 * account-wide streak alone, so the owner signing in doesn't reset the
 * backoff of someone guessing from elsewhere.
 */
export async function releaseLoginAttempt(
  keys: LoginThrottleKeys,
  gate: Extract<LoginAttemptGate, { allowed: true }>,
  now: Date = new Date()
): Promise<void> {
  const streakKey =
    gate.knownNetwork && keys.network ? keys.network.accountKey : keys.accountKey;
  await Promise.all([
    clearRateLimit(streakKey).catch((err) => {
      console.error("[auth] login account limit reset failed:", err);
    }),
    keys.network
      ? rememberRateLimitKey(
          keys.network.knownKey,
          LOGIN_KNOWN_NETWORK_TTL_MS,
          now
        ).catch((err) => {
          console.error("[auth] known sign-in network update failed:", err);
        })
      : undefined,
    refundAll(gate.ipReservations),
  ]);
}

/**
 * Clears every sign-in lock on the account (account-wide and per network).
 * Used once the owner proves control of the mailbox, e.g. by resetting the
 * password or accepting an invite, and when an admin unlocks a staff member.
 * Known networks are kept.
 */
export async function clearLoginAccountLock(email: string): Promise<void> {
  await Promise.all([
    clearRateLimit(loginAccountKey(email)),
    clearRateLimitPrefix(networkAccountKeyPrefix(email)),
  ]);
}

/** True while `email` has signed in successfully from `ip`'s bucket recently. */
export async function isKnownLoginNetwork(
  email: string,
  ip: string | null | undefined,
  now: Date = new Date()
): Promise<boolean> {
  const bucket = loginNetworkBucket(ip);
  if (!bucket) return false;
  return rateLimitKeyActive(loginKnownNetworkKey(email, bucket), now);
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

let warnedUnverifiedIp = false;

export function warnUnverifiedLoginIpOnce(client: ResolvedClientIp): void {
  if (client.ip || warnedUnverifiedIp) return;
  warnedUnverifiedIp = true;
  console.warn(
    client.source === "unverified"
      ? `[auth] Sign-in client IPs can't be verified, so per-IP sign-in limits use the address each request claims and can be sidestepped; per-account limits still apply. If OpenVPM runs behind a reverse proxy, set ${TRUSTED_PROXY_HOPS_ENV} to the number of proxies in front of it.`
      : `[auth] Sign-in request had no usable client IP from the ${client.source} source; per-IP sign-in limits were skipped.`
  );
}
