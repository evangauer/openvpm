import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientIpFromRequest,
  isNonPublicIp,
  normalizeIp,
  proxyWithoutTrustedHops,
  resolveClientIp,
  trustedProxyHops,
  trustedProxyNotForwarding,
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

describe("proxyWithoutTrustedHops", () => {
  const req = (headers: Record<string, string>) => ({ headers });

  it("flags a self-host whose requests evidently came through a proxy", () => {
    for (const headers of <Record<string, string>[]>[
      { "x-real-ip": "203.0.113.10" },
      { forwarded: "for=203.0.113.10" },
      { via: "1.1 caddy" },
      { "x-forwarded-server": "traefik" },
      { "x-forwarded-for": "203.0.113.10, 172.18.0.1" },
      { "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https" },
      { "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" },
      // nginx on a Docker network without the X-Forwarded-For line: Next.js
      // fills the header with the gateway address.
      { "x-forwarded-for": "172.18.0.1", "x-forwarded-proto": "http" },
      { "x-forwarded-for": "::ffff:192.168.65.1" },
    ]) {
      expect(proxyWithoutTrustedHops(req(headers), SELF_HOST)).toBe(true);
    }
  });

  it("stays quiet for what Next.js fills in itself on a direct connection", () => {
    expect(
      proxyWithoutTrustedHops(
        req({
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-proto": "http",
          "x-forwarded-host": "clinic.example",
          "x-forwarded-port": "3000",
        }),
        SELF_HOST
      )
    ).toBe(false);
  });

  it("stays quiet once hops are configured, and on Vercel", () => {
    const proxied = req({ "x-real-ip": "203.0.113.10" });
    expect(proxyWithoutTrustedHops(proxied, ONE_PROXY)).toBe(false);
    expect(proxyWithoutTrustedHops(proxied, { OPENVPM_TRUSTED_PROXY_HOPS: "0" })).toBe(false);
    expect(proxyWithoutTrustedHops(proxied, { VERCEL: "1" })).toBe(false);
  });

  it("reads Fetch API headers too", () => {
    expect(
      proxyWithoutTrustedHops(
        new Request("http://localhost/", { headers: { "x-real-ip": "203.0.113.10" } }),
        SELF_HOST
      )
    ).toBe(true);
  });
});

describe("isNonPublicIp", () => {
  it("covers loopback, private, CGNAT, link-local, and their mapped forms", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.18.0.1",
      "172.31.255.255",
      "192.168.1.20",
      "100.64.0.1",
      "100.127.255.254",
      "169.254.10.20",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "febf::1",
      "::ffff:10.0.0.1",
      "::ffff:172.18.0.1",
      "::ffff:ac12:1",
      "0:0:0:0:0:ffff:c0a8:0114",
      "[::1]:443",
      "172.18.0.1:51234",
      "not-an-ip",
    ]) {
      expect(isNonPublicIp(ip), ip).toBe(true);
    }
  });

  it("leaves public addresses alone", () => {
    for (const ip of [
      "203.0.113.10",
      "198.51.100.7",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "2001:db8::1",
      "2606:4700::1111",
      "fec0::1",
      "::ffff:203.0.113.10",
      "::ffff:cb00:710a",
    ]) {
      expect(isNonPublicIp(ip), ip).toBe(false);
    }
  });
});

describe("trustedProxyNotForwarding", () => {
  const req = (headers: Record<string, string>) => ({ headers });

  it("reports the proxy's own address when hops are set but nothing is forwarded", () => {
    expect(
      trustedProxyNotForwarding(req({ "x-forwarded-for": "172.18.0.1" }), ONE_PROXY)
    ).toEqual({ address: "172.18.0.1" });
    expect(trustedProxyNotForwarding(req({}), ONE_PROXY)).toEqual({ address: null });
  });

  it("stays quiet for a forwarded public client, without hops, and on Vercel", () => {
    expect(
      trustedProxyNotForwarding(
        req({ "x-forwarded-for": "203.0.113.10, 172.18.0.1" }),
        { OPENVPM_TRUSTED_PROXY_HOPS: "2" }
      )
    ).toBeNull();
    expect(
      trustedProxyNotForwarding(req({ "x-forwarded-for": "203.0.113.10" }), ONE_PROXY)
    ).toBeNull();
    expect(
      trustedProxyNotForwarding(req({ "x-forwarded-for": "172.18.0.1" }), SELF_HOST)
    ).toBeNull();
    expect(
      trustedProxyNotForwarding(req({ "x-forwarded-for": "172.18.0.1" }), {
        VERCEL: "1",
        OPENVPM_TRUSTED_PROXY_HOPS: "1",
      })
    ).toBeNull();
  });
});
