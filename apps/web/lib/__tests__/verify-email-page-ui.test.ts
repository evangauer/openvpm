import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verify email recovery UI", () => {
  const source = readFileSync("app/(auth)/verify-email/page.tsx", "utf8");

  it("keeps verification optional and routes recovery through the signed-in app", () => {
    expect(source).toContain("Your trial is already active.");
    expect(source).toContain("Any unexpired verification link will");
    expect(source).toContain("Open OpenVPM to resend");
    expect(source).not.toContain("resendVerification.useMutation");
    expect(source).not.toContain('href="/register"');
    expect(source).not.toContain("disabled={!email");
  });

  it("does not claim confirmation activates a trial", () => {
    expect(source).toContain("Email confirmed. Your trial was already active");
    expect(source).not.toMatch(/activate your account|start your free trial/i);
  });
});
