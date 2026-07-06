import { afterEach, describe, expect, it, vi } from "vitest";

async function importAppUrl() {
  vi.resetModules();
  return import("../app-url");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("app base URL helpers", () => {
  it("normalizes configured app URLs to a clean origin", async () => {
    const { normalizeAppBaseUrl } = await importAppUrl();

    expect(normalizeAppBaseUrl(" https://app.example.com/path?q=1#top ")).toBe(
      "https://app.example.com"
    );
    expect(normalizeAppBaseUrl("http://localhost:3000/settings")).toBe(
      "http://localhost:3000"
    );
  });

  it("rejects malformed or credentialed app URLs", async () => {
    const { normalizeAppBaseUrl } = await importAppUrl();

    expect(normalizeAppBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeAppBaseUrl("https://user:pass@app.example.com")).toBeNull();
    expect(normalizeAppBaseUrl("https://app.example.com\n")).toBeNull();
    expect(normalizeAppBaseUrl("not a url")).toBeNull();
    expect(normalizeAppBaseUrl(null)).toBeNull();
  });

  it("prefers NEXT_PUBLIC_APP_URL and falls back to NEXTAUTH_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://public.example.com/app ");
    vi.stubEnv("NEXTAUTH_URL", "https://auth.example.com");
    const { appBaseUrl } = await importAppUrl();

    expect(appBaseUrl()).toBe("https://public.example.com");

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appBaseUrl()).toBe("https://auth.example.com");
  });

  it("uses localhost only when no app URL is configured outside production", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "test");
    const { appBaseUrl } = await importAppUrl();

    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it("fails closed for invalid configured app URLs in production", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://user:pass@app.example.com");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const { appBaseUrl } = await importAppUrl();

    expect(() => appBaseUrl()).toThrow(
      "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to a valid HTTPS app origin."
    );
  });

  it("requires a configured HTTPS app origin in production", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    let module = await importAppUrl();

    expect(() => module.appBaseUrl()).toThrow(
      "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to a valid HTTPS app origin."
    );

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://app.example.com");
    module = await importAppUrl();
    expect(() => module.appBaseUrl()).toThrow(
      "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to a valid HTTPS app origin."
    );

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/settings");
    module = await importAppUrl();
    expect(module.appBaseUrl()).toBe("https://app.example.com");
  });

  it("exposes auth links outside production by default", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OPENVPM_EXPOSE_AUTH_LINKS", "");
    const { exposeAuthLinksForPreview } = await importAppUrl();

    expect(exposeAuthLinksForPreview()).toBe(true);
  });

  it("trims the explicit auth-link exposure flag for production-like previews", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENVPM_EXPOSE_AUTH_LINKS", " true ");
    const { exposeAuthLinksForPreview } = await importAppUrl();

    expect(exposeAuthLinksForPreview()).toBe(true);
  });

  it("keeps auth-link exposure disabled in production for non-true flag values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENVPM_EXPOSE_AUTH_LINKS", "TRUE");
    const { exposeAuthLinksForPreview } = await importAppUrl();

    expect(exposeAuthLinksForPreview()).toBe(false);
  });
});
