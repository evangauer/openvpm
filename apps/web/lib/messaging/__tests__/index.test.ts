import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getMessagingProvider,
  requiredMessagingEnvNames,
  resolveSender,
} from "../index";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Clear every messaging env so each test starts from a known-empty baseline. */
function clearMessagingEnv() {
  for (const name of [
    "NEXT_PUBLIC_DEMO_MODE",
    "MESSAGING_PROVIDER",
    "TELNYX_API_KEY",
    "TELNYX_MESSAGING_PROFILE_ID",
    "TELNYX_FROM_NUMBER",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_MESSAGING_SERVICE_SID",
  ]) {
    vi.stubEnv(name, "");
  }
}

describe("getMessagingProvider", () => {
  it("falls back to the console provider when nothing is configured", () => {
    clearMessagingEnv();
    expect(getMessagingProvider().name).toBe("console");
  });

  it("selects Telnyx when only Telnyx is configured", () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    expect(getMessagingProvider().name).toBe("telnyx");
  });

  it("selects Twilio when only Twilio is configured", () => {
    clearMessagingEnv();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    expect(getMessagingProvider().name).toBe("twilio");
  });

  it("prefers Telnyx when both are configured", () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    expect(getMessagingProvider().name).toBe("telnyx");
  });

  it("honours an explicit MESSAGING_PROVIDER override even when unconfigured", () => {
    clearMessagingEnv();
    vi.stubEnv("MESSAGING_PROVIDER", "twilio");
    vi.stubEnv("TELNYX_API_KEY", "KEY123"); // configured, but overridden
    expect(getMessagingProvider().name).toBe("twilio");
  });

  it("forces the console provider in demo mode even with real creds", () => {
    clearMessagingEnv();
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("MESSAGING_PROVIDER", "telnyx");
    expect(getMessagingProvider().name).toBe("console");
  });
});

describe("requiredMessagingEnvNames", () => {
  it("requires Telnyx envs when Telnyx is active", () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    expect(requiredMessagingEnvNames()).toEqual([
      "TELNYX_API_KEY",
      "TELNYX_MESSAGING_PROFILE_ID",
    ]);
  });

  it("requires Twilio envs when Twilio is active", () => {
    clearMessagingEnv();
    vi.stubEnv("MESSAGING_PROVIDER", "twilio");
    expect(requiredMessagingEnvNames()).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
    ]);
  });
});

describe("resolveSender", () => {
  it("returns the Telnyx messaging profile + from-number when Telnyx is active", async () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "mp-1");
    vi.stubEnv("TELNYX_FROM_NUMBER", "+15555550100");
    await expect(resolveSender({ practiceId: "p1" })).resolves.toEqual({
      messagingServiceId: "mp-1",
      from: "+15555550100",
    });
  });

  it("returns the Twilio Messaging Service + from-number when Twilio is active", async () => {
    clearMessagingEnv();
    vi.stubEnv("MESSAGING_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG123");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+15555550111");
    // No locationId → resolves the platform env default without a DB lookup.
    await expect(resolveSender({ practiceId: "p1" })).resolves.toEqual({
      messagingServiceId: "MG123",
      from: "+15555550111",
    });
  });
});
