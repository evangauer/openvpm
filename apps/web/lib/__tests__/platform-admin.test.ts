import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlatformAdmin, platformAdminEmails } from "../platform-admin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform admin allowlist", () => {
  it("normalizes configured operator emails", () => {
    vi.stubEnv(
      "PLATFORM_ADMIN_EMAILS",
      " ops@example.com, Lead@Example.com , ,"
    );

    expect(platformAdminEmails()).toEqual([
      "ops@example.com",
      "lead@example.com",
    ]);
  });

  it("trims and lowercases the caller email before checking access", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    expect(isPlatformAdmin(" OPS@example.com ")).toBe(true);
  });

  it("does not match blank caller emails", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    expect(isPlatformAdmin("   ")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });
});
