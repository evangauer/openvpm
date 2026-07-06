import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const providerSend = vi.fn();
  return {
    getMessagingProvider: vi.fn(() => ({
      name: "telnyx",
      isConfigured: () => true,
      send: providerSend,
    })),
    providerSend,
    resolveSender: vi.fn(),
    isSuppressed: vi.fn(),
    recordUsage: vi.fn(),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    withSystem: vi.fn(),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

vi.mock("@/lib/billing/usage", () => ({
  recordUsage: mocks.recordUsage,
}));

vi.mock("@/lib/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging")>();
  return {
    ...actual,
    getMessagingProvider: mocks.getMessagingProvider,
    resolveSender: mocks.resolveSender,
    isSuppressed: mocks.isSuppressed,
  };
});

const { sendAppointmentReminderSms, sendSms, sendVaccinationReminderSms } =
  await import("../sms");
const smsSource = readFileSync(new URL("../sms.ts", import.meta.url), "utf8");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.getMessagingProvider.mockReturnValue({
    name: "telnyx",
    isConfigured: () => true,
    send: mocks.providerSend,
  });
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.withSystem.mockImplementation(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                tier: "cloud",
                billingStatus: "active",
                trialEndsAt: null,
              },
            ],
          }),
        }),
      }),
    })
  );
});

describe("sendSms", () => {
  it("requires an active practice for hosted billing entitlement checks", () => {
    expect(smsSource).toMatch(
      /where\(\s*and\(\s*eq\(practices\.id, options\.practiceId!\),\s*isNull\(practices\.deletedAt\)\s*\)\s*\)/s
    );
    expect(smsSource).toContain("if (!practice)");
    expect(smsSource).toContain("Practice not found");
    expect(smsSource).toContain("practice.tier");
    expect(smsSource).not.toContain("practice?.tier");
  });

  it("meters successful real provider sends for hosted usage billing", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-1" });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({ success: true, sid: "sms-1", error: undefined });

    expect(mocks.recordUsage).toHaveBeenCalledWith({
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      kind: "sms",
    });
  });

  it("normalizes recipients before suppression checks and provider sends", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-1" });

    await expect(
      sendSms({
        to: " (555) 555-0199 ",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({ success: true, sid: "sms-1", error: undefined });

    expect(mocks.isSuppressed).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-0000000000aa",
      "+15555550199"
    );
    expect(mocks.providerSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: "Reminder",
      sender: { from: "+15555550100" },
    });
  });

  it("fails closed before provider work when the recipient phone is invalid", async () => {
    await expect(
      sendSms({
        to: "12345",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: false,
      error: "SMS recipient phone number must be a valid E.164 or US/CA number.",
    });

    expect(mocks.isSuppressed).not.toHaveBeenCalled();
    expect(mocks.resolveSender).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("waits for hosted usage recording before returning a successful real send", async () => {
    const usage = deferred();
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-1" });
    mocks.recordUsage.mockReturnValueOnce(usage.promise);

    let settled = false;
    const sendPromise = sendSms({
      to: "+15555550199",
      body: "Reminder",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    usage.resolve();
    await expect(sendPromise).resolves.toEqual({
      success: true,
      sid: "sms-1",
      error: undefined,
    });
  });

  it("keeps provider message ids on appointment reminder helper results", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-reminder-1" });

    await expect(
      sendAppointmentReminderSms({
        to: "+15555550199",
        patientName: "Miso",
        appointmentDate: "July 2",
        appointmentTime: "9:00 AM",
        practiceName: "Neighborhood Veterinary",
      })
    ).resolves.toEqual({
      success: true,
      sid: "sms-reminder-1",
      error: undefined,
    });
  });

  it("keeps provider message ids on vaccination reminder helper results", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-vax-1" });

    await expect(
      sendVaccinationReminderSms({
        to: "+15555550199",
        patientName: "Miso",
        vaccineName: "Rabies",
        practiceName: "Neighborhood Veterinary",
      })
    ).resolves.toEqual({
      success: true,
      sid: "sms-vax-1",
      error: undefined,
    });
  });

  it("does not meter failed provider sends", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({ from: "+15555550100" });
    mocks.providerSend.mockResolvedValue({
      success: false,
      error: "Provider rejected",
    });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: false,
      sid: undefined,
      error: "Provider rejected",
    });

    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("does not meter console fallback sends", async () => {
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({});
    mocks.providerSend.mockResolvedValue({ success: true, id: "console-1" });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: true,
      sid: "console-1",
      error: undefined,
    });

    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed when hosted sending would use the console fallback", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: false,
      error: "SMS provider is not configured for hosted sending.",
    });

    expect(mocks.resolveSender).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("allows the safe console provider for hosted demo mode with padded env values", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", " true ");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({});
    mocks.providerSend.mockResolvedValue({ success: true, id: "console-1" });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: true,
      sid: "console-1",
      error: undefined,
    });

    expect(mocks.providerSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: "Reminder",
      sender: {},
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed when hosted SMS practice entitlement lookup is stale", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.withSystem.mockImplementationOnce(
      async (_db: unknown, fn: (tx: unknown) => unknown) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [],
              }),
            }),
          }),
        })
    );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
      })
    ).resolves.toEqual({
      success: false,
      error: "Practice not found",
    });

    expect(mocks.hasHostedFullAccess).not.toHaveBeenCalled();
    expect(mocks.isSuppressed).not.toHaveBeenCalled();
    expect(mocks.resolveSender).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed for explicit locations without an active sender", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveSender.mockResolvedValue({});

    await expect(
      sendSms({
        to: "+15555550100",
        body: "Reminder",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      })
    ).resolves.toEqual({
      success: false,
      error: "No active texting sender is configured for this location.",
    });

    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});
