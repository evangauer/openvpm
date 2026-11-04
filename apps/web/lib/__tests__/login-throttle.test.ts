import { describe, expect, it } from "vitest";
import {
  INVALID_LOGIN_MESSAGE,
  loginErrorMessage,
  loginRateLimitedErrorCode,
  loginRateLimitedMessage,
} from "../login-error-message";
import { backoffDecision, backoffLockMs } from "../rate-limit";
import {
  LOGIN_ACCOUNT_BACKOFF,
  ipPrefixBucket,
  loginIpBucket,
  loginThrottleKeys,
} from "../login-throttle";

describe("login error messages", () => {
  it("states plainly that sign-in is rate limited and for how long", () => {
    expect(loginRateLimitedMessage(1)).toBe(
      "Too many sign-in attempts. Try again in 1 minute."
    );
    expect(loginRateLimitedMessage(60)).toBe(
      "Too many sign-in attempts. Try again in 1 minute."
    );
    expect(loginRateLimitedMessage(61)).toBe(
      "Too many sign-in attempts. Try again in 2 minutes."
    );
    expect(loginRateLimitedMessage(15 * 60)).toBe(
      "Too many sign-in attempts. Try again in 15 minutes."
    );
    expect(loginRateLimitedMessage(60 * 60)).toBe(
      "Too many sign-in attempts. Try again in 60 minutes."
    );
    expect(loginRateLimitedMessage(23 * 60 * 60 - 30)).toBe(
      "Too many sign-in attempts. Try again in 23 hours."
    );
  });

  it("round-trips the code thrown by the credentials provider", () => {
    expect(loginRateLimitedErrorCode(299.2)).toBe("LoginRateLimited:300");
    expect(loginErrorMessage("LoginRateLimited:300")).toBe(
      "Too many sign-in attempts. Try again in 5 minutes."
    );
  });

  it("falls back to the generic message for other errors", () => {
    expect(loginErrorMessage("CredentialsSignin")).toBe(INVALID_LOGIN_MESSAGE);
    expect(loginErrorMessage("LoginRateLimited:abc")).toBe(INVALID_LOGIN_MESSAGE);
    expect(loginErrorMessage(undefined)).toBe(INVALID_LOGIN_MESSAGE);
  });
});

describe("account backoff", () => {
  const minute = 60 * 1000;

  it("allows five failures, then doubles the lock up to an hour", () => {
    expect([4, 5, 6, 7, 10, 11, 40].map((n) => backoffLockMs(LOGIN_ACCOUNT_BACKOFF, n) / minute)).toEqual([
      0, 1, 2, 4, 32, 60, 60,
    ]);
  });

  it("forgets a streak once it expires", () => {
    const now = new Date("2026-06-28T12:00:00Z");
    const decision = backoffDecision(
      LOGIN_ACCOUNT_BACKOFF,
      { count: 9, resetAt: new Date(now.getTime() - 1), updatedAt: now },
      now
    );
    expect(decision).toMatchObject({ success: true, next: { count: 1 } });
  });

  it("leaves a locked bucket untouched", () => {
    const now = new Date("2026-06-28T12:00:00Z");
    const state = {
      count: 6,
      resetAt: new Date(now.getTime() + LOGIN_ACCOUNT_BACKOFF.streakMs),
      updatedAt: new Date(now.getTime() - minute),
    };
    expect(backoffDecision(LOGIN_ACCOUNT_BACKOFF, state, now)).toEqual({
      success: false,
      retryAt: new Date(now.getTime() + minute),
    });
  });
});

describe("login throttle keys", () => {
  it("normalizes the account and uses both windows for a verified IP", () => {
    expect(
      loginThrottleKeys(" Admin@Example.COM ", { bucket: "203.0.113.10", verified: true })
    ).toMatchObject({
      accountKey: "login:account:admin@example.com",
      ipKeys: [
        { key: "login:ip:203.0.113.10" },
        { key: "login:ip-day:203.0.113.10" },
      ],
    });
  });

  it("uses only the short window for an unverified IP, and none without one", () => {
    expect(
      loginThrottleKeys("a@example.com", { bucket: "203.0.113.10", verified: false }).ipKeys
    ).toEqual([
      { key: "login:ip-unverified:203.0.113.10", limit: 50, windowMs: 15 * 60 * 1000 },
    ]);
    expect(loginThrottleKeys("a@example.com", null).ipKeys).toEqual([]);
  });

  it("buckets IPv6 clients by /64", () => {
    expect(ipPrefixBucket("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipPrefixBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipPrefixBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipPrefixBucket("203.0.113.10")).toBe("203.0.113.10");
  });

  it("falls back to the claimed address, never to a shared bucket", () => {
    expect(loginIpBucket({ ip: "203.0.113.10", source: "vercel" })).toEqual({
      bucket: "203.0.113.10",
      verified: true,
    });
    const unverified = { ip: null, source: "unverified" } as const;
    expect(
      loginIpBucket(unverified, { headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" } })
    ).toEqual({ bucket: "198.51.100.7", verified: false });
    expect(loginIpBucket(unverified, { headers: { "x-real-ip": "2001:db8::5" } })).toEqual({
      bucket: "2001:db8:0:0::/64",
      verified: false,
    });
    expect(loginIpBucket(unverified, { headers: { "x-forwarded-for": "127.0.0.1" } })).toBeNull();
    expect(loginIpBucket(unverified, { headers: { "x-forwarded-for": "not-an-ip" } })).toBeNull();
    expect(loginIpBucket(unverified, { headers: {} })).toBeNull();
    expect(loginIpBucket({ ip: null, source: "trusted-proxy" }, { headers: {} })).toBeNull();
  });
});
