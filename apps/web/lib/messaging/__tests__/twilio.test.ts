import { afterEach, describe, expect, it, vi } from "vitest";
import { twilioProvider } from "../twilio";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("twilioProvider", () => {
  it("treats blank credentials as unconfigured", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "   ");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "\t");

    expect(twilioProvider.isConfigured()).toBe(false);
    await expect(
      twilioProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { messagingServiceId: "MG123" },
      })
    ).resolves.toEqual({
      success: false,
      error: "Twilio is not configured.",
    });
  });
});
