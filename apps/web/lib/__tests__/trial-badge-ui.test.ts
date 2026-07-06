import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trial badge UI", () => {
  const source = readFileSync("components/layout/trial-badge.tsx", "utf8");

  it("surfaces subscription loading and failures before hiding the badge", () => {
    expect(source).toContain("const { data, isLoading, error }");
    expect(source).toContain("if (!isAdmin) return null");
    expect(source).toContain('aria-label="Checking billing status"');
    expect(source).toContain("Billing status unavailable");
    expect(source).toContain("if (error || !data)");
    expect(source.indexOf("if (isLoading)")).toBeLessThan(
      source.indexOf("if (error || !data)")
    );
    expect(source.indexOf("if (error || !data)")).toBeLessThan(
      source.indexOf('if (!data.billingEnforced || data.billingStatus === "active")')
    );
    expect(source).not.toContain(
      'if (!data || !data.billingEnforced || data.billingStatus === "active")'
    );
  });

  it("counts trial days from the practice timezone", () => {
    expect(source).toContain(
      'import { trialCalendarDaysLeft } from "@/lib/billing/trial-days"'
    );
    expect(source).toContain(
      "trialCalendarDaysLeft(data.trialEndsAt, data.timezone)"
    );
    expect(source).not.toContain("getTime() - Date.now()");
    expect(source).not.toContain("24 * 60 * 60 * 1000");
  });
});
