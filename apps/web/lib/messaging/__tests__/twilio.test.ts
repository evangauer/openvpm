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

  it.each([
    [
      "messaging service",
      { messagingServiceId: "MG123" },
      { messagingServiceSid: "MG123" },
    ],
    ["bare number", { from: "+15555550100" }, { from: "+15555550100" }],
  ] as const)(
    "requests bounded status-callback retries for %s sends",
    async (_label, sender, expectedSender) => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.test");
      mocks.create.mockResolvedValue({ sid: "SM123" });

      await expect(
        twilioProvider.send({
          to: "+15555550199",
          body: "Reminder",
          sender,
        }),
      ).resolves.toEqual({ status: "accepted", id: "SM123" });
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...expectedSender,
          statusCallback:
            "https://app.openvpm.test/api/webhooks/twilio#rc=5&rp=all",
        }),
      );
    },
  );
});
