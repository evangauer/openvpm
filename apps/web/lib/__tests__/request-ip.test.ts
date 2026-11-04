import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientIpFromRequest,
  normalizeIp,
  resolveClientIp,
  trustedProxyHops,
} from "../request-ip";

afterEach(() => {
  vi.restoreAllMocks();
});

const SELF_HOST = {};
const VERCEL = { VERCEL: "1" };
const ONE_PROXY = { OPENVPM_TRUSTED_PROXY_HOPS: "1" };
const TWO_PROXIES = { OPENVPM_TRUSTED_PROXY_HOPS: "2" };

describe("resolveClientIp", () => {
  it("uses the Vercel-set client address and ignores X-Forwarded-For", () => {
    expect(
      resolveClientIp(
        {
          headers: {
            "x-vercel-forwarded-for": "203.0.113.10",
            "x-forwarded-for": "10.0.0.1",
          },
        },
        VERCEL
      )
    ).toEqual({ ip: "203.0.113.10", source: "vercel" });
    expect(
      resolveClientIp({ headers: { "x-real-ip": "203.0.113.11" } }, VERCEL)
    ).toEqual({ ip: "203.0.113.11", source: "vercel" });
    expect(
      resolveClientIp(
        { headers: new Headers({ "x-forwarded-for": "10.0.0.1" }) },
        VERCEL
      )
    ).toEqual({ ip: null, source: "vercel" });
  });

  it("reads the entry appended by the configured number of trusted proxies", () => {
    const spoofed = { headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.10" } };
    expect(resolveClientIp(spoofed, ONE_PROXY)).toEqual({
      ip: "203.0.113.10",
      source: "trusted-proxy",
    });
    expect(
      resolveClientIp(
        { headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.10, 172.16.0.2" } },
        TWO_PROXIES
      )
    ).toEqual({ ip: "203.0.113.10", source: "trusted-proxy" });
    // Shorter chain than configured: every entry came from a trusted proxy.
    expect(
      resolveClientIp({ headers: { "x-forwarded-for": "203.0.113.10" } }, TWO_PROXIES)
    ).toEqual({ ip: "203.0.113.10", source: "trusted-proxy" });
    expect(resolveClientIp({ headers: {} }, ONE_PROXY)).toEqual({
      ip: null,
      source: "trusted-proxy",
    });
  });

  it("reads repeated X-Forwarded-For headers as one chain", () => {
    expect(
      resolveClientIp(
        { headers: { "x-forwarded-for": ["10.0.0.1", "203.0.113.10"] } },
        ONE_PROXY
      ).ip
    ).toBe("203.0.113.10");
  });

  it("never trusts forwarded headers on an unconfigured self-host", () => {
    expect(
      resolveClientIp(
        { headers: { "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.10" } },
        SELF_HOST
      )
    ).toEqual({ ip: null, source: "unverified" });
  });

  it("uses the socket address when the request exposes one", () => {
    expect(
      resolveClientIp(
        {
          headers: { "x-forwarded-for": "10.0.0.1" },
          socket: { remoteAddress: "::ffff:203.0.113.10" },
        },
        SELF_HOST
      )
    ).toEqual({ ip: "203.0.113.10", source: "socket" });
  });

  it("rejects values that are not IP addresses", () => {
    expect(
      resolveClientIp({ headers: { "x-forwarded-for": "evil, not-an-ip" } }, ONE_PROXY).ip
    ).toBeNull();
  });
});

describe("normalizeIp", () => {
  it("strips ports, brackets, and IPv4-mapped prefixes", () => {
    expect(normalizeIp(" 203.0.113.10:51234 ")).toBe("203.0.113.10");
    expect(normalizeIp("[2001:DB8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("::ffff:198.51.100.5")).toBe("198.51.100.5");
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
});

describe("trustedProxyHops", () => {
  it("accepts small non-negative integers and ignores anything else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ OPENVPM_TRUSTED_PROXY_HOPS: " 2 " })).toBe(2);
    expect(trustedProxyHops({ OPENVPM_TRUSTED_PROXY_HOPS: "true" })).toBe(0);
    expect(trustedProxyHops({ OPENVPM_TRUSTED_PROXY_HOPS: "-1" })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("clientIpFromRequest", () => {
  it("keeps per-client throttles on an unconfigured self-host", () => {
    expect(
      clientIpFromRequest({
        headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.5" },
      })
    ).toBe("203.0.113.10");
    expect(clientIpFromRequest({ headers: { "x-real-ip": "198.51.100.5" } })).toBe(
      "198.51.100.5"
    );
    expect(clientIpFromRequest({ headers: {} })).toBe("unknown");
  });

  it("uses the verified address once a trusted proxy is configured", () => {
    vi.stubEnv("OPENVPM_TRUSTED_PROXY_HOPS", "1");
    try {
      expect(
        clientIpFromRequest({
          headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.10" },
        })
      ).toBe("203.0.113.10");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
