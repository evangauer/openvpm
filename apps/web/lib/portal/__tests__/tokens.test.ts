import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  hashPortalRequestMetadata,
  portalSessionSecretProblem,
} from "../tokens";

const STRONG_SECRET = "q3vV9rJcK0m8yTfLw2ZpXa7Ns4Hd6Bu1Ee5Gi0Ko9Rs=";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

  it("falls back to a strong NEXTAUTH_SECRET instead of a short PORTAL_SESSION_SECRET in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", "short");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(hashPortalRequestMetadata("203.0.113.10")).toBe(
      createHmac("sha256", STRONG_SECRET).update("203.0.113.10").digest("hex"),
    );
    expect(portalSessionSecretProblem()).toBe("too_short");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("PORTAL_SESSION_SECRET is shorter than 32"),
    );
    warn.mockRestore();
  });

  it("still throws when both portal and NextAuth secrets are unusable in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", "short");
    vi.stubEnv("NEXTAUTH_SECRET", "docker-dev-secret-change-in-production");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => hashPortalRequestMetadata("203.0.113.10")).toThrow(
      "A strong PORTAL_SESSION_SECRET or NEXTAUTH_SECRET is required in production",
    );
  });

  it("uses a strong PORTAL_SESSION_SECRET when configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_SESSION_SECRET", STRONG_SECRET.split("").reverse().join(""));
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);

    expect(portalSessionSecretProblem()).toBeNull();
    expect(hashPortalRequestMetadata("203.0.113.10")).not.toBe(
      createHmac("sha256", STRONG_SECRET).update("203.0.113.10").digest("hex"),
    );
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
