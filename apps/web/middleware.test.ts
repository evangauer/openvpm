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
    const observed = response.headers.get(key);
    if (key === "Content-Security-Policy") {
      expect(observed).toContain("script-src 'self' 'nonce-");
      expect(observed).toContain("style-src 'self' 'nonce-");
      expect(observed).toContain("style-src-attr 'unsafe-inline'");
      expect(observed).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(observed).not.toContain("style-src 'self' 'unsafe-inline'");
    } else {
      expect(observed).toBe(value);
    }
  }
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
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(
      response.headers.get("x-middleware-request-content-security-policy"),
    ).toContain("script-src 'self' 'nonce-");
    expectSecurityHeaders(response);
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

  it("keeps staff guides public without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const guideResponse = await middleware(request("/help/take-a-payment"));
    const lookalikeResponse = await middleware(request("/helpdesk"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(guideResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fhelpdesk",
    );
    expectSecurityHeaders(guideResponse);
    expectSecurityHeaders(lookalikeResponse);
  });

  it("keeps the staff copilot demo public without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const demoResponse = await middleware(request("/staff-copilot-demo"));
    const lookalikeResponse = await middleware(
      request("/staff-copilot-demo-old"),
    );

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(demoResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fstaff-copilot-demo-old",
    );
    expectSecurityHeaders(demoResponse);
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

  it("keeps invoice payment links public without exposing lookalike routes", async () => {
    mocks.getToken.mockResolvedValue(null);

    const paymentResponse = await middleware(request("/pay/v1.signed.token"));
    const lookalikeResponse = await middleware(request("/payments"));

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(paymentResponse.headers.get("location")).toBeNull();
    expect(lookalikeResponse.headers.get("location")).toBe(
      "https://openvpm.test/login?next=%2Fpayments",
    );
    expectSecurityHeaders(paymentResponse);
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

  it("keeps the root layout dynamic so Next can nonce its bootstrap scripts", () => {
    const layout = readFileSync("./app/layout.tsx", "utf8");

    expect(layout).toContain('import { headers } from "next/headers"');
    expect(layout).toContain("export default async function RootLayout");
    expect(layout).toContain("const requestHeaders = await headers()");
    expect(layout).toContain('requestHeaders.get("x-nonce")');
    expect(layout).toContain("<Providers nonce={nonce}>");

    const providers = readFileSync("./lib/providers.tsx", "utf8");
    expect(providers).toContain("nonce?: string");
    expect(providers).toContain("nonce={nonce}");
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
    expect(contentSecurityPolicy).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(contentSecurityPolicy).toContain("style-src 'self'");
    expect(contentSecurityPolicy).toContain("style-src-attr 'unsafe-inline'");
    expect(contentSecurityPolicy).not.toContain(
      "style-src 'self' 'unsafe-inline'",
    );
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
