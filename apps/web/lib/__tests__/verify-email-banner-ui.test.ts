import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("verify email banner UI", () => {
  const source = readFileSync(
    "components/layout/verify-email-banner.tsx",
    "utf8",
  );

  it("surfaces loading and failures before hiding the verification banner", () => {
    expect(source).toContain("const { data, isLoading, error, refetch }");
    expect(source).toContain("Checking email verification status...");
    expect(source).toContain("Unable to check email verification status.");
    expect(source).toContain("onClick={() => void refetch()}");
    expect(source).toContain("if (error || !data)");
    expect(source).toContain(
      "if (!data.verificationEnabled || data.emailVerified) return null",
    );
    expect(source.indexOf("if (isLoading)")).toBeLessThan(
      source.indexOf("if (error || !data)"),
    );
    expect(source.indexOf("if (error || !data)")).toBeLessThan(
      source.indexOf(
        "if (!data.verificationEnabled || data.emailVerified) return null",
      ),
    );
    expect(source).not.toContain(
      "if (!data?.verificationEnabled || data.emailVerified)",
    );
  });

  it("uses the authenticated inputless resend and renders real failures", () => {
    expect(source).toContain("trpc.auth.resendVerification.useMutation()");
    expect(source).toContain("onClick={() => resend.mutate()}");
    expect(source).not.toContain("resend.mutate({ email:");
    expect(source).toContain("resend.error.message");
    expect(source).toContain("resend.data.verificationEmailSent");
    expect(source).toContain("resend.data.verificationEmailPreviewed");
    expect(source).toContain("!resend.data.alreadyVerified");
    expect(source).toContain("!resend.data.possiblySent");
    expect(source).toContain("!resend.data.verificationEmailPreviewed");
    expect(source).toContain("{showResendAction && (");
    expect(source).toContain("resend.data.message");
  });
});
