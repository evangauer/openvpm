import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verify email banner UI", () => {
  const source = readFileSync("components/layout/verify-email-banner.tsx", "utf8");

  it("surfaces loading and failures before hiding the verification banner", () => {
    expect(source).toContain("const { data, isLoading, error, refetch }");
    expect(source).toContain("Checking email verification status...");
    expect(source).toContain("Unable to check email verification status.");
    expect(source).toContain("onClick={() => void refetch()}");
    expect(source).toContain("if (error || !data)");
    expect(source).toContain("if (!data.verificationEnabled || data.emailVerified) return null");
    expect(source.indexOf("if (isLoading)")).toBeLessThan(
      source.indexOf("if (error || !data)")
    );
    expect(source.indexOf("if (error || !data)")).toBeLessThan(
      source.indexOf("if (!data.verificationEnabled || data.emailVerified) return null")
    );
    expect(source).not.toContain("if (!data?.verificationEnabled || data.emailVerified)");
  });
});
