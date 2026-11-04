/**
 * Client IP resolution.
 *
 * `X-Forwarded-For` is only as trustworthy as whatever wrote it. A client can
 * send any value, and Next.js fills the header from the socket only when the
 * client did not send one, so on its own the header proves nothing. We
 * therefore trust it only when the deployment says who writes it:
 *
 * - On Vercel, the platform overwrites `x-vercel-forwarded-for` / `x-real-ip`
 *   with the address it accepted the connection from.
 * - Self-hosted, `OPENVPM_TRUSTED_PROXY_HOPS=<n>` declares that exactly `n`
 *   reverse proxies, each appending to `X-Forwarded-For`, sit in front of the
 *   app. The client is the entry `n` places from the right; anything further
 *   left was supplied by the client and is ignored.
 * - Otherwise a socket address is used when the request object exposes one.
 *
 * Anything else is reported as unverified (`ip: null`).
 */

export const TRUSTED_PROXY_HOPS_ENV = "OPENVPM_TRUSTED_PROXY_HOPS";
const MAX_TRUSTED_PROXY_HOPS = 10;
const MAX_IP_LENGTH = 45;

export type ClientIpSource = "vercel" | "trusted-proxy" | "socket" | "unverified";

export interface ResolvedClientIp {
  /** Verified client address, or null when it cannot be established. */
  ip: string | null;
  source: ClientIpSource;
}

type Env = Record<string, string | undefined>;

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(value)) return value.length ? value.join(",") : null;
  return value ?? null;
}

/** Normalizes one address token; returns null for anything that isn't an IP. */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  // [2001:db8::1]:443 → 2001:db8::1
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  // 203.0.113.10:51234 → 203.0.113.10
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (v4WithPort) ip = v4WithPort[1]!;
  ip = ip.toLowerCase();
  if (ip.startsWith("::ffff:") && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip.slice(7))) {
    ip = ip.slice(7);
  }
  if (!ip || ip.length > MAX_IP_LENGTH) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((part) => Number(part) <= 255) ? ip : null;
  }
  if (ip.includes(":") && /^[0-9a-f:.]+$/.test(ip)) return ip;
  return null;
}

function forwardedForEntries(headers: unknown): string[] {
  const raw = headerValue(headers, "x-forwarded-for");
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let warnedInvalidHops = false;

export function trustedProxyHops(env: Env = process.env): number {
  const raw = env[TRUSTED_PROXY_HOPS_ENV]?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0 && hops <= MAX_TRUSTED_PROXY_HOPS) {
    return hops;
  }
  if (!warnedInvalidHops) {
    warnedInvalidHops = true;
    console.warn(
      `[request-ip] Ignoring ${TRUSTED_PROXY_HOPS_ENV}=${JSON.stringify(raw)}; expected an integer from 0 to ${MAX_TRUSTED_PROXY_HOPS}.`
    );
  }
  return 0;
}

function onVercel(env: Env): boolean {
  return env.VERCEL === "1";
}

export function resolveClientIp(
  req: unknown,
  env: Env = process.env
): ResolvedClientIp {
  const request = req as {
    headers?: unknown;
    socket?: { remoteAddress?: string };
  } | null;
  const headers = request?.headers;

  if (onVercel(env)) {
    const vercelIp =
      normalizeIp(headerValue(headers, "x-vercel-forwarded-for")?.split(",")[0]) ??
      normalizeIp(headerValue(headers, "x-real-ip"));
    return { ip: vercelIp, source: "vercel" };
  }

  const hops = trustedProxyHops(env);
  if (hops > 0) {
    const entries = forwardedForEntries(headers);
    if (entries.length === 0) return { ip: null, source: "trusted-proxy" };
    // Each trusted proxy appends the address it received the connection from,
    // so the client is `hops` entries from the right. A shorter chain means
    // every entry was written by a trusted proxy; take the oldest.
    const index = Math.max(entries.length - hops, 0);
    return { ip: normalizeIp(entries[index]), source: "trusted-proxy" };
  }

  const socketIp = normalizeIp(request?.socket?.remoteAddress);
  if (socketIp) return { ip: socketIp, source: "socket" };

  return { ip: null, source: "unverified" };
}

/**
 * The client address a request claims when the deployment can't verify one:
 * the leftmost `X-Forwarded-For` entry, else `X-Real-IP`. Anyone can forge
 * this, so only use it where a forged value lets a caller dodge a limit but
 * never lets them impose one on everyone else.
 */
export function unverifiedForwardedIp(req: unknown): string | null {
  const headers = (req as { headers?: unknown } | null)?.headers;
  return (
    normalizeIp(forwardedForEntries(headers)[0]) ??
    normalizeIp(headerValue(headers, "x-real-ip"))
  );
}

export function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || /^127\./.test(ip);
}

/**
 * True when a self-hosted request was evidently relayed by a reverse proxy
 * but `OPENVPM_TRUSTED_PROXY_HOPS` is unset, so client addresses can't be
 * verified. Next.js fills `X-Forwarded-For/-Proto/-Host` itself when they are
 * missing, so only signals it never produces count: proxy-only headers, a
 * multi-hop chain, HTTPS (the app server speaks plain HTTP), or a loopback
 * client address.
 */
export function proxyWithoutTrustedHops(
  req: unknown,
  env: Env = process.env
): boolean {
  if (onVercel(env) || env[TRUSTED_PROXY_HOPS_ENV]?.trim()) return false;
  const headers = (req as { headers?: unknown } | null)?.headers;
  if (!headers) return false;
  for (const name of ["x-real-ip", "forwarded", "via", "x-forwarded-server"]) {
    if (headerValue(headers, name)) return true;
  }
  const entries = forwardedForEntries(headers);
  if (entries.length > 1) return true;
  const proto = headerValue(headers, "x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto?.toLowerCase() === "https") return true;
  const first = normalizeIp(entries[0]);
  return first !== null && isLoopbackIp(first);
}

/**
 * Client IP for low-stakes abuse throttles (portal, signing, uploads, error
 * reports). Uses the verified address when the deployment provides one; on an
 * unconfigured self-host it falls back to the unverified forwarded value so
 * those throttles stay per-client rather than collapsing into one shared
 * bucket. Do not use this for authentication decisions; use
 * `resolveClientIp` and handle `ip: null` explicitly.
 */
export function clientIpFromRequest(req: unknown): string {
  const resolved = resolveClientIp(req);
  if (resolved.ip) return resolved.ip;
  if (resolved.source !== "unverified") return "unknown";

  const headers = (req as { headers?: unknown } | null)?.headers;
  const forwarded = forwardedForEntries(headers)[0];
  if (forwarded) return forwarded.slice(0, MAX_IP_LENGTH);
  return headerValue(headers, "x-real-ip")?.slice(0, MAX_IP_LENGTH) ?? "unknown";
}
