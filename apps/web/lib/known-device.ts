import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { nextAuthSecret } from "@/lib/auth-secret";

/**
 * Known-device cookie for sign-in throttling (the OWASP "device cookie"
 * pattern).
 *
 * A successful sign-in sets an HttpOnly cookie holding a random device id and
 * the accounts that signed in on this browser, each with its own expiry,
 * signed with a key derived from NEXTAUTH_SECRET. When an account is locked
 * by failed attempts, a browser that carries a valid entry for that account
 * isn't held by the account-wide lock; it gets its own backoff streak instead.
 * The cookie is only issued after a correct password, so it reveals nothing
 * about which accounts exist, and it never skips the password check.
 *
 * Accounts are bound by a keyed hash of the normalized email, so an entry is
 * ignored for any other account (or after the account's email changes).
 * Several accounts can share one browser, as on a front-desk computer.
 */

export const KNOWN_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS_PER_DEVICE = 10;
const COOKIE_VERSION = 1;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT_TAG_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_COOKIE_LENGTH = 1024;

type Env = Record<string, string | undefined>;

interface DevicePayload {
  v: typeof COOKIE_VERSION;
  /** Random device id. */
  d: string;
  /** [account tag, expiry in epoch seconds] */
  a: [string, number][];
}

export interface KnownDeviceCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
}

/** HTTPS deployments get a `__Host-` cookie, which browsers only accept over HTTPS. */
export function knownDeviceCookieSecure(env: Env = process.env): boolean {
  return (
    env.VERCEL === "1" ||
    (env.NEXTAUTH_URL?.trim().toLowerCase().startsWith("https://") ?? false)
  );
}

export function knownDeviceCookieName(env: Env = process.env): string {
  return knownDeviceCookieSecure(env)
    ? "__Host-openvpm-device"
    : "openvpm-device";
}

function signingKey(): Buffer | null {
  const secret = nextAuthSecret();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update("openvpm known-device cookie v1")
    .digest();
}

function accountTag(key: Buffer, email: string): string {
  return createHmac("sha256", key)
    .update(`account:${email.trim().toLowerCase()}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key).update(`cookie:${body}`).digest();
}

const COOKIE_NAMES = new Set(["__Host-openvpm-device", "openvpm-device"]);

/**
 * The first validly signed known-device cookie value in a `Cookie` header, or
 * null. A browser can send several values (both cookie names, or a stale
 * copy set on another path or by a sibling subdomain), so every value is
 * checked in order: a junk or oversized copy ahead of the real one can't
 * shadow it.
 */
export function knownDeviceCookieFromHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  const key = signingKey();
  if (!key) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (!COOKIE_NAMES.has(part.slice(0, separator).trim())) continue;
    const value = part.slice(separator + 1).trim();
    if (verify(key, value)) return value;
  }
  return null;
}

function verify(
  key: Buffer,
  value: string | null | undefined,
): DevicePayload | null {
  if (!value || value.length > MAX_COOKIE_LENGTH) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as DevicePayload;
    if (
      payload?.v !== COOKIE_VERSION ||
      typeof payload.d !== "string" ||
      !DEVICE_ID_PATTERN.test(payload.d) ||
      !Array.isArray(payload.a) ||
      payload.a.length > MAX_ACCOUNTS_PER_DEVICE ||
      !payload.a.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          ACCOUNT_TAG_PATTERN.test(entry[0]) &&
          Number.isInteger(entry[1]),
      )
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * The device id when `value` is a validly signed cookie with an unexpired
 * entry for `email`; otherwise null.
 */
export function knownDeviceForAccount(
  value: string | null | undefined,
  email: string,
  now: Date = new Date(),
): { deviceId: string } | null {
  const key = signingKey();
  if (!key) return null;
  const payload = verify(key, value);
  if (!payload) return null;
  const tag = accountTag(key, email);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const entry = payload.a.find(([t]) => t === tag);
  return entry && entry[1] > nowSeconds ? { deviceId: payload.d } : null;
}

/**
 * Cookie to set after `email` signs in successfully. Keeps the existing
 * device id and other accounts' unexpired entries when `existing` is valid;
 * otherwise starts a new device. Returns null if no signing secret is set.
 */
export function issueKnownDeviceCookie(
  existing: string | null | undefined,
  email: string,
  now: Date = new Date(),
  env: Env = process.env,
): KnownDeviceCookie | null {
  const key = signingKey();
  if (!key) return null;
  const previous = verify(key, existing);
  const tag = accountTag(key, email);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expires = nowSeconds + Math.floor(KNOWN_DEVICE_TTL_MS / 1000);
  const others = (previous?.a ?? [])
    .filter(([t, exp]) => t !== tag && exp > nowSeconds)
    .sort((x, y) => y[1] - x[1])
    .slice(0, MAX_ACCOUNTS_PER_DEVICE - 1);
  const payload: DevicePayload = {
    v: COOKIE_VERSION,
    d: previous?.d ?? randomBytes(16).toString("base64url"),
    a: [[tag, expires], ...others],
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    name: knownDeviceCookieName(env),
    value: `${body}.${mac(key, body).toString("base64url")}`,
    options: {
      httpOnly: true,
      secure: knownDeviceCookieSecure(env),
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(KNOWN_DEVICE_TTL_MS / 1000),
    },
  };
}

/**
 * Sets the known-device cookie on the current route handler's response
 * (NextAuth's credentials callback, or a password reset or invite acceptance
 * through `/api/trpc`). Next.js merges cookies set through `cookies()` into
 * the response the handler returns.
 */
export async function rememberKnownDevice(
  existing: string | null | undefined,
  email: string,
): Promise<void> {
  const cookie = issueKnownDeviceCookie(existing, email);
  if (!cookie) return;
  try {
    const { cookies } = await import("next/headers");
    (await cookies()).set(cookie.name, cookie.value, cookie.options);
  } catch (err) {
    console.error("[auth] known-device cookie could not be set:", err);
  }
}
