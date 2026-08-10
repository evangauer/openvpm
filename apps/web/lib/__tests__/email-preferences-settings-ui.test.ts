import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(
    new URL("../../app/(dashboard)/settings/page.tsx", import.meta.url),
  ),
  "utf8",
);

describe("OpenVPM email settings UI", () => {
  it("separates optional platform email from required and clinic-sent mail", () => {
    expect(source).toContain("Emails from OpenVPM");
    expect(source).toContain("Product guidance and feedback");
    expect(source).toContain("Account, security, and billing email");
    expect(source).toContain(
      "not messages\n              your clinic sends to pet owners",
    );
  });

  it("uses a labeled native control with loading, retry, and inline status", () => {
    expect(source).toContain("getMarketingEmailPreference.useQuery");
    expect(source).toContain("setMarketingEmailPreference.useMutation");
    expect(source).toContain(
      'aria-describedby="marketing-email-preference-description"',
    );
    expect(source).toContain('role="alert"');
    expect(source).toContain("marketingEmailMutation.isError");
    expect(source).toContain("marketingEmailMutation.isSuccess");
    expect(source).toContain("marketingEmailPreferenceRefreshing");
    expect(source).toContain(
      "utils.settings.getMarketingEmailPreference.invalidate()",
    );
    expect(source).toContain('role="status"');
    expect(source).toContain("refetchMarketingEmailPreference");
  });
});
