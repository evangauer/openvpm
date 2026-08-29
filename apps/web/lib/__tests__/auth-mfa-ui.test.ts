import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("login MFA experience", () => {
  it("continues password authentication with an authenticator or recovery code", () => {
    const source = readFileSync("app/(auth)/login/page.tsx", "utf8");
    expect(source).toContain('result?.error?.includes("MFA_REQUIRED")');
    expect(source).toContain('fetch("/api/auth/mfa-required"');
    expect(source).toContain("challengeResponse.ok && challenge.mfaRequired === true");
    expect(source).toContain('autoComplete="one-time-code"');
    expect(source).toContain("6-digit code or recovery code");
    expect(source).toContain("Verify and sign in");
  });
});
