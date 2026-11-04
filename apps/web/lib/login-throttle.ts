import {
  clearRateLimit,
  consumeBackoffAttempt,
  rateLimit,
  refundRateLimit,
  type BackoffPolicy,
} from "@/lib/rate-limit";
import {
  isLoopbackIp,
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

export interface LoginThrottleKeys {
  accountKey: string;
  ipKeys: { key: string; limit: number; windowMs: number }[];
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
  if (client.ip) return { bucket: ipPrefixBucket(client.ip), verified: true };
  if (client.source !== "unverified") return null;
  const claimed = unverifiedForwardedIp(req);
  if (!claimed || isLoopbackIp(claimed)) return null;
  return { bucket: ipPrefixBucket(claimed), verified: false };
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

export function loginAccountKey(email: string): string {
  return `login:account:${email.trim().toLowerCase()}`;
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
  };
}

export type LoginAttemptGate =
  | { allowed: true; ipReservations: { key: string; resetAt: Date }[] }
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
  try {
    account = await consumeBackoffAttempt({
      key: keys.accountKey,
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
  return { allowed: true, ipReservations: reserved };
}

/** A successful sign-in returns its reservations and resets the account streak. */
export async function releaseLoginAttempt(
  keys: LoginThrottleKeys,
  gate: Extract<LoginAttemptGate, { allowed: true }>
): Promise<void> {
  await Promise.all([
    clearRateLimit(keys.accountKey).catch((err) => {
      console.error("[auth] login account limit reset failed:", err);
    }),
    refundAll(gate.ipReservations),
  ]);
}

/**
 * Clears the account lock once the owner proves control of the mailbox, e.g.
 * by resetting the password or accepting an invite.
 */
export async function clearLoginAccountLock(email: string): Promise<void> {
  await clearRateLimit(loginAccountKey(email));
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
