import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("twilio", () => ({
  default: () => ({ messages: { create: mocks.create } }),
}));

import { twilioProvider } from "../twilio";

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.create.mockReset();
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
      }),
    ).resolves.toEqual({
      status: "definite_failure",
      error: "Twilio is not configured.",
    });
  });

  it("classifies known non-transient 4xx rejections as definite failures", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
    mocks.create.mockRejectedValue(
      Object.assign(new Error("invalid destination"), { status: 400 }),
    );

    await expect(
      twilioProvider.send({
        to: "+15555550199",
        body: "Reminder",
        sender: { messagingServiceId: "MG123" },
      }),
    ).resolves.toEqual({
      status: "definite_failure",
      error: "invalid destination",
    });
  });

  it.each([408, 429, 500])(
    "keeps Twilio HTTP %s failures outcome-unknown",
    async (status) => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
      mocks.create.mockRejectedValue(
        Object.assign(new Error("uncertain request"), { status }),
      );

      await expect(
        twilioProvider.send({
          to: "+15555550199",
          body: "Reminder",
          sender: { messagingServiceId: "MG123" },
        }),
      ).resolves.toEqual({
        status: "outcome_unknown",
        error: "uncertain request",
      });
    },
  );
});
