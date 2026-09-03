import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: mocks.getToken,
}));

const { config, middleware } = await import("./middleware");
const require = createRequire(import.meta.url);
const nextConfig = require("./next.config.js") as {
  poweredByHeader?: boolean;
  headers: () => Promise<
    {
      source: string;
      headers: { key: string; value: string }[];
    }[]
  >;
};
const { contentSecurityPolicy, securityHeaders } =
  require("./lib/security-headers.js") as {
    contentSecurityPolicy: string;
    securityHeaders: { key: string; value: string }[];
  };

function request(path: string) {
  return new Request(`https://openvpm.test${path}`) as never;
}

function expectSecurityHeaders(response: Response) {
  for (const { key, value } of securityHeaders) {
    expect(response.headers.get(key)).toBe(value);
  }
}

function expectCapabilitySecurityHeaders(response: Response) {
  for (const { key, value } of securityHeaders) {
    if (key.toLowerCase() !== "referrer-policy") {
      expect(response.headers.get(key)).toBe(value);
    }
  }
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Robots-Tag")).toBe(
    "noindex, nofollow, noarchive",
  );
  expect(response.headers.get("Cache-Control")).toBe(
    "private, no-store, max-age=0",
  );
}

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("middleware security headers", () => {
  it("adds security headers to public auth pages without session lookup", async () => {
    const response = await middleware(request("/login"));

    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
    expectSecurityHeaders(response);
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("keeps email preference links public without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const preferenceResponse = await middleware(
      request("/email-preferences?token=signed"),
    );
    const lookalikeResponse = await middleware(
      request("/email-preferences-old"),
    );

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(preferenceResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Femail-preferences-old",
    );
    expectSecurityHeaders(preferenceResponse);
    expectSecurityHeaders(lookalikeResponse);
  });

  it("keeps clinic-fit guidance public without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const fitResponse = await middleware(request("/clinic-fit"));
    const lookalikeResponse = await middleware(request("/clinic-fitness"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(fitResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fclinic-fitness",
    );
    expectSecurityHeaders(fitResponse);
    expectSecurityHeaders(lookalikeResponse);
  });

  it("adds security headers to API routes without middleware auth redirects", async () => {
    const response = await middleware(request("/api/health"));

    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
    expectSecurityHeaders(response);
  });

  it("allows public booking pages without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const bookingResponse = await middleware(request("/book/test-clinic"));
    const lookalikeResponse = await middleware(request("/bookish"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(bookingResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fbookish",
    );
    expectSecurityHeaders(bookingResponse);
    expectSecurityHeaders(lookalikeResponse);
  });

  it("allows public SMS program pages without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const programResponse = await middleware(
      request("/sms/00000000-0000-4000-8000-000000000000/privacy"),
    );
    const lookalikeResponse = await middleware(request("/sms-settings"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(programResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fsms-settings",
    );
    expectSecurityHeaders(programResponse);
    expectSecurityHeaders(lookalikeResponse);
  });

  it("allows treatment-plan capabilities without exposing protected lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const capabilityResponse = await middleware(
      request(`/treatment-plan/${"a".repeat(64)}`),
    );
    const protectedResponse = await middleware(request("/treatment-plans"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(capabilityResponse.headers.get("location")).toBeNull();
    expect(protectedResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Ftreatment-plans",
    );
    expectCapabilitySecurityHeaders(capabilityResponse);
    expectSecurityHeaders(protectedResponse);
  });

  it("enforces capability privacy headers on public page and API prefixes", async () => {
    const token = "a".repeat(64);

    for (const path of [
      `/capture/${token}`,
      `/sign/${token}`,
      `/treatment-plan/${token}`,
      `/api/capture/${token}`,
      `/api/sign/${token}`,
      `/api/treatment-plan/${token}`,
    ]) {
      const response = await middleware(request(path));

      expect(response.headers.get("location")).toBeNull();
      expectCapabilitySecurityHeaders(response);
    }

    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("allows Vercel observability proxy paths without session lookup", async () => {
    const insights = await middleware(request("/_vercel/insights/view"));
    const proxied = await middleware(request("/5691167a7e0cfa40/view"));

    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(insights.headers.get("location")).toBeNull();
    expect(proxied.headers.get("location")).toBeNull();
    expectSecurityHeaders(insights);
    expectSecurityHeaders(proxied);
  });

  it("keeps protected routes behind login and preserves headers on redirects", async () => {
    mocks.getToken.mockResolvedValue(null);

    const req = request("/patients?status=active");
    const response = await middleware(req);

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(mocks.getToken).toHaveBeenCalledWith({
      req,
      secret: "test-secret",
    });
    expect(response.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fpatients%3Fstatus%3Dactive",
    );
    expectSecurityHeaders(response);
  });

  it("trims NEXTAUTH_SECRET before decoding protected-route sessions", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", " test-secret ");
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const req = request("/patients");
    const response = await middleware(req);

    expect(mocks.getToken).toHaveBeenCalledWith({
      req,
      secret: "test-secret",
    });
    expect(response.headers.get("location")).toBeNull();
    expectSecurityHeaders(response);
  });

  it("fails closed without token decoding when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    const response = await middleware(request("/settings"));

    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fsettings",
    );
    expectSecurityHeaders(response);
  });

  it("keeps the dashboard root protected", async () => {
    mocks.getToken.mockResolvedValue(null);

    const response = await middleware(request("/"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBe("https://openvpm.test/login");
    expectSecurityHeaders(response);
  });

  it("allows authenticated protected routes with the same headers", async () => {
    mocks.getToken.mockResolvedValue({ sub: "user-1" });

    const response = await middleware(request("/settings"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBeNull();
    expectSecurityHeaders(response);
  });

  it("runs on dynamic public and API routes so headers are global", () => {
    expect(config.matcher).toEqual(["/((?!_next).*)"]);
  });

  it("also configures app-wide headers for static and framework assets", async () => {
    const [globalHeaders] = await nextConfig.headers();

    expect(globalHeaders.source).toBe("/:path*");
    expect(globalHeaders.headers).toEqual(securityHeaders);
  });

  it("disables the framework powered-by response header", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("keeps the CSP compatible with accepted patient photo URLs", () => {
    expect(contentSecurityPolicy).toContain(
      "img-src 'self' data: blob: https:",
    );
    expect(contentSecurityPolicy).toContain(
      "connect-src 'self' https://app.openvpm.com",
    );
    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("object-src 'none'");
  });

  it("keeps README security header claims aligned with the global policy", () => {
    const readme = readFileSync("../../README.md", "utf8");

    expect(readme).toContain("CSP");
    expect(readme).toContain("HSTS");
    expect(readme).toContain("Permissions-Policy");
    expect(readme).toContain("X-Content-Type-Options");
    expect(readme).toContain("X-Frame-Options");
    expect(readme).toContain("Referrer-Policy");
    expect(readme).not.toContain(
      "**Headers:** X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy",
    );
  });

  it("keeps middleware and deployment headers on the shared policy module", () => {
    const middlewareSource = readFileSync("middleware.ts", "utf8");
    const nextConfigSource = readFileSync("next.config.js", "utf8");

    expect(middlewareSource).toContain('from "./lib/security-headers"');
    expect(middlewareSource).toContain("isVercelObservabilityPath");
    expect(middlewareSource).toContain(
      'loginUrl.searchParams.set("next", nextPath)',
    );
    expect(middlewareSource).toContain('if (nextPath !== "/")');
    expect(nextConfigSource).toContain('require("./lib/security-headers.js")');
    expect(middlewareSource).not.toContain("const CONTENT_SECURITY_POLICY");
    expect(nextConfigSource).not.toContain("const contentSecurityPolicy");
  });
});
