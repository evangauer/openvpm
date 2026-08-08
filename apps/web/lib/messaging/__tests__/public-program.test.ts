import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messagingProgramUrls } from "../public-program";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

describe("public clinic messaging program", () => {
  it("builds stable hosted policy and consent URLs", () => {
    expect(
      messagingProgramUrls(PRACTICE_ID, "https://app.openvpm.com/settings"),
    ).toEqual({
      programUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}`,
      privacyPolicyUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/privacy`,
      termsUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/terms`,
      optInUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/opt-in`,
    });
  });

  it("rejects malformed practice identifiers", () => {
    expect(() =>
      messagingProgramUrls("../other", "https://app.openvpm.com"),
    ).toThrow();
  });

  it("renders the server-owned consent disclosure on the public opt-in page", () => {
    const source = readFileSync(
      new URL("../../../app/sms/[practiceId]/opt-in/page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("SMS_CONSENT_DISCLOSURE.snapshot");
    expect(source).toContain("not selected by default");
    expect(source).toContain("No text is sent until consent is recorded");
  });
});
