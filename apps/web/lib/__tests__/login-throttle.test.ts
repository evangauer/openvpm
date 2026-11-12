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
  loginNetworkBucket,
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
  it("normalizes the account and keys both per-IP buckets for a verified IP", () => {
    expect(loginThrottleKeys(" Admin@Example.COM ", "203.0.113.10")).toEqual({
      accountKey: "login:account:admin@example.com",
      ip: {
        failureKey: "login:ip:203.0.113.10",
        requestKey: "login:ip-req:203.0.113.10",
      },
      deviceAccountKey: null,
    });
    expect(loginThrottleKeys("a@example.com", null).ip).toBeNull();
  });

  it("buckets IPv6 clients by /64", () => {
    expect(ipPrefixBucket("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(ipPrefixBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipPrefixBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipPrefixBucket("203.0.113.10")).toBe("203.0.113.10");
  });

  it("uses only verified addresses, never a claimed one", () => {
    expect(loginIpBucket({ ip: "203.0.113.10", source: "vercel" })).toBe("203.0.113.10");
    expect(loginIpBucket({ ip: "2001:db8::5", source: "trusted-proxy" })).toBe(
      "2001:db8:0:0::/64"
    );
    expect(loginIpBucket({ ip: null, source: "unverified" })).toBeNull();
    expect(loginIpBucket({ ip: null, source: "trusted-proxy" })).toBeNull();
  });

  it("never keys per-IP limits on a non-public address", () => {
    for (const ip of ["172.18.0.1", "10.1.2.3", "192.168.65.1", "100.64.1.1", "fd00::1", "::ffff:172.18.0.1"]) {
      expect(loginIpBucket({ ip, source: "trusted-proxy" }), ip).toBeNull();
      expect(loginIpBucket({ ip, source: "socket" }), ip).toBeNull();
      expect(loginNetworkBucket(ip), ip).toBeNull();
    }
    expect(loginNetworkBucket(" 203.0.113.10 ")).toBe("203.0.113.10");
    expect(loginNetworkBucket("not-an-ip")).toBeNull();
    expect(loginNetworkBucket(null)).toBeNull();
  });

  it("keys a known device's streak by a hash of the account and the device id", () => {
    const keys = loginThrottleKeys("Admin@Example.com", null, "dev123");
    expect(keys.deviceAccountKey).toMatch(/^login:account-dev:[0-9a-f]{32}:dev123$/);
    expect(loginThrottleKeys("admin@example.com", null, "dev123").deviceAccountKey).toBe(
      keys.deviceAccountKey
    );
    expect(loginThrottleKeys("other@example.com", null, "dev123").deviceAccountKey).not.toBe(
      keys.deviceAccountKey
    );
  });
});
