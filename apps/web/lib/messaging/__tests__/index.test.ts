import { describe, it, expect, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const senderRows: unknown[][] = [];
  const selectLimit = vi.fn(async () => senderRows.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
  }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const tx = { select };
  const db = {};
  return {
    db,
    senderRows,
    selectInnerJoin,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

import {
  getMessagingProvider,
  requiredMessagingEnvNames,
  resolveSender,
} from "../index";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.senderRows.length = 0;
});

/** Clear every messaging env so each test starts from a known-empty baseline. */
function clearMessagingEnv() {
  for (const name of [
    "NEXT_PUBLIC_DEMO_MODE",
    "MESSAGING_PROVIDER",
    "TELNYX_API_KEY",
    "TELNYX_MESSAGING_PROFILE_ID",
    "TELNYX_FROM_NUMBER",
    "TELNYX_PUBLIC_KEY",
    "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
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

  it("ignores whitespace-only provider credentials when auto-selecting", () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "   ");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "\t");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "\n");
    expect(getMessagingProvider().name).toBe("console");
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

  it("trims and normalizes an explicit MESSAGING_PROVIDER override", () => {
    clearMessagingEnv();
    vi.stubEnv("MESSAGING_PROVIDER", " TwIlIo ");
    vi.stubEnv("TELNYX_API_KEY", "KEY123"); // configured, but overridden
    expect(getMessagingProvider().name).toBe("twilio");
  });

  it("forces the console provider in demo mode even with real creds", () => {
    clearMessagingEnv();
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", " true ");
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
      "TELNYX_PUBLIC_KEY",
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
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

  it("trims env default sender fields and omits blank sender values", async () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", " mp-1 ");
    vi.stubEnv("TELNYX_FROM_NUMBER", "   ");

    await expect(resolveSender({ practiceId: "p1" })).resolves.toEqual({
      messagingServiceId: "mp-1",
      from: undefined,
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

  it("returns an active location sender scoped to the practice", async () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "env-profile");
    mocks.senderRows.push([
      { messagingProfileId: "loc-profile", senderE164: "+15555550122" },
    ]);

    await expect(
      resolveSender({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      })
    ).resolves.toEqual({
      messagingServiceId: "loc-profile",
      from: "+15555550122",
    });
    expect(mocks.selectInnerJoin).toHaveBeenCalled();
  });

  it("treats blank explicit location sender rows as missing", async () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "env-profile");
    vi.stubEnv("TELNYX_FROM_NUMBER", "+15555550100");
    mocks.senderRows.push([
      { messagingProfileId: "   ", senderE164: "\n" },
    ]);

    await expect(
      resolveSender({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      })
    ).resolves.toEqual({});
  });

  it("does not fall back to env sender for stale explicit locations", async () => {
    clearMessagingEnv();
    vi.stubEnv("TELNYX_API_KEY", "KEY123");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "env-profile");
    vi.stubEnv("TELNYX_FROM_NUMBER", "+15555550100");
    mocks.senderRows.push([]);

    await expect(
      resolveSender({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000099",
      })
    ).resolves.toEqual({});
  });
});
