import { describe, expect, it } from "vitest";
import {
  providerHttpErrorDiagnostic,
  sanitizeProviderDiagnostic,
} from "../provider-diagnostics";

describe("provider diagnostics", () => {
  it("retains bounded remediation text while redacting contact and provider identifiers", () => {
    const result = sanitizeProviderDiagnostic(
      "Invalid EIN 12-3456789 for vet@example.com; phone +1 (555) 555-0199; request 3fa85f64-5717-4562-b3fc-2c963f66afa6\nretry",
    );

    expect(result).toContain("Invalid EIN [redacted number]");
    expect(result).toContain("[redacted email]");
    expect(result).toContain("[redacted id]");
    expect(result).not.toContain("3456789");
    expect(result).not.toContain("555-0199");
    expect(result).not.toContain("vet@example.com");
    expect(result).not.toContain("\n");
  });

  it("uses only allowlisted provider code/title fields, never raw detail", () => {
    const result = providerHttpErrorDiagnostic("Telnyx", 400, {
      errors: [
        {
          code: "40300",
          title: "Blocked due to STOP message",
          detail: "Messages cannot be sent from +15555550100 to +15555550199",
        },
      ],
    });

    expect(result).toBe(
      "Telnyx request failed (400): code 40300: Blocked due to STOP message",
    );
    expect(result).not.toContain("555555");
  });
});
