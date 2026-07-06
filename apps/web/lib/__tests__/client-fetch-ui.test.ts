import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("browser fetch timeouts", () => {
  it("uses the bounded client fetch helper for upload, checkout, and error-report flows", () => {
    const sources = [
      "components/common/report-client-error.ts",
      "components/onboarding/steps/branding.tsx",
      "app/(dashboard)/settings/page.tsx",
      "app/(dashboard)/patients/[id]/page.tsx",
      "app/portal/[token]/invoices/page.tsx",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).toContain("fetchWithClientTimeout");
    }

    expect(sources.join("\n")).not.toMatch(
      /\bfetch\(\s*["']\/api\/(?:upload|portal\/checkout|error-report)/
    );
  });
});
