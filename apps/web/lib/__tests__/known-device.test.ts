import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueKnownDeviceCookie,
  knownDeviceCookieFromHeader,
  knownDeviceForAccount,
} from "../known-device";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-01T12:00:00Z");

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-at-least-32-characters-long");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("known-device cookie", () => {
  it("uses a __Host- cookie only over HTTPS", () => {
    expect(issueKnownDeviceCookie(null, "a@example.com", now)).toMatchObject({
      name: "openvpm-device",
      options: { httpOnly: true, secure: false, sameSite: "lax", path: "/" },
    });
    vi.stubEnv("NEXTAUTH_URL", "https://clinic.example.com");
    expect(issueKnownDeviceCookie(null, "a@example.com", now)).toMatchObject({
      name: "__Host-openvpm-device",
      options: { secure: true },
    });
  });

  it("binds each entry to one account and expires it after 90 days", () => {
    const cookie = issueKnownDeviceCookie(null, "A@Example.com", now)!;
    const device = knownDeviceForAccount(cookie.value, "a@example.com", now);
    expect(device?.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(knownDeviceForAccount(cookie.value, "b@example.com", now)).toBeNull();
    expect(
      knownDeviceForAccount(cookie.value, "a@example.com", new Date(now.getTime() + 91 * DAY))
    ).toBeNull();
    // Nothing about the account is readable from the cookie.
    expect(Buffer.from(cookie.value.split(".")[0]!, "base64url").toString()).not.toContain(
      "example.com"
    );
  });

  it("keeps the device id and other accounts when another account signs in", () => {
    const first = issueKnownDeviceCookie(null, "a@example.com", now)!;
    const second = issueKnownDeviceCookie(first.value, "b@example.com", now)!;
    const a = knownDeviceForAccount(second.value, "a@example.com", now);
    const b = knownDeviceForAccount(second.value, "b@example.com", now);
    expect(a?.deviceId).toBe(knownDeviceForAccount(first.value, "a@example.com", now)?.deviceId);
    expect(b?.deviceId).toBe(a?.deviceId);
  });

  it("starts a new device when the existing cookie isn't valid", () => {
    const forged = "eyJ2IjoxfQ.AAAA";
    const cookie = issueKnownDeviceCookie(forged, "a@example.com", now)!;
    expect(knownDeviceForAccount(cookie.value, "a@example.com", now)).not.toBeNull();
    expect(knownDeviceForAccount(forged, "a@example.com", now)).toBeNull();
  });

  it("is off without a signing secret", () => {
    const cookie = issueKnownDeviceCookie(null, "a@example.com", now)!;
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(issueKnownDeviceCookie(null, "a@example.com", now)).toBeNull();
    expect(knownDeviceForAccount(cookie.value, "a@example.com", now)).toBeNull();
  });

  it("reads only its own cookie from a Cookie header", () => {
    expect(knownDeviceCookieFromHeader("a=1; openvpm-device=abc.def; b=2")).toBe("abc.def");
    expect(knownDeviceCookieFromHeader("__Host-openvpm-device=abc.def")).toBeNull();
    expect(knownDeviceCookieFromHeader(null)).toBeNull();
    expect(knownDeviceCookieFromHeader(`openvpm-device=${"x".repeat(2000)}`)).toBeNull();
  });
});
