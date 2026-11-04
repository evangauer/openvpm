import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPortalRequestMetadata } from "../tokens";

const STRONG_SECRET = "q3vV9rJcK0m8yTfLw2ZpXa7Ns4Hd6Bu1Ee5Gi0Ko9Rs=";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portal metadata secret", () => {
  it("refuses to fall back to a published NEXTAUTH_SECRET in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "docker-dev-secret-change-in-production");

    expect(() => hashPortalRequestMetadata("203.0.113.10")).toThrow(
      "A strong PORTAL_SESSION_SECRET or NEXTAUTH_SECRET is required in production",
    );
  });

  it("refuses a short PORTAL_SESSION_SECRET in production even with a strong NEXTAUTH_SECRET", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", "short");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);

    expect(() => hashPortalRequestMetadata("203.0.113.10")).toThrow();
  });

  it("uses a strong fallback secret in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);

    expect(hashPortalRequestMetadata("203.0.113.10")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps working in development with a placeholder secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PORTAL_SESSION_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "docker-dev-secret-change-in-production");

    expect(hashPortalRequestMetadata("203.0.113.10")).toMatch(/^[0-9a-f]{64}$/);
  });
});
