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
    resolveMessagingTransport: vi.fn(),
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
    resolveMessagingTransport: mocks.resolveMessagingTransport,
    isSuppressed: mocks.isSuppressed,
  };
});

const { sendAppointmentReminderSms, sendSms, sendVaccinationReminderSms } =
  await import("../sms");
const { revokeSmsConsentByPhoneInTransaction } =
  await import("@/lib/messaging/suppression");
const smsSource = readFileSync(new URL("../sms.ts", import.meta.url), "utf8");
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";
const CLIENT_ID = "00000000-0000-0000-0000-000000000003";

function allowHostedPilot() {
  vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
  vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", PRACTICE_ID);
  vi.stubEnv("MESSAGING_SENDING_LOCATION_IDS", LOCATION_ID);
}

function hostedDispatchDb(rows: Array<unknown[] | Error>) {
  const select = vi.fn(() => {
    const result = rows.shift() ?? [];
    const settle = () =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      for: settle,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown
      ) => settle().then(resolve, reject),
    };
    return builder;
  });
  return { execute: vi.fn(async () => undefined), select };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transport(
  sender: { messagingServiceId?: string; from?: string },
  name: "telnyx" | "twilio" | "console" = "telnyx",
  send = mocks.providerSend
) {
  return {
    provider: { name, isConfigured: () => true, send },
    sender,
  };
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
  mocks.withSystem.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => unknown) =>
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
  it("keeps hosted SMS default-off before any DB, transport, or provider work", async () => {
    mocks.billingEnforced.mockReturnValue(true);

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error:
        "Texting is not enabled for this clinic pilot. Contact OpenVPM support.",
    });

    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("requires explicit hosted practice, location, and client scope", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
      })
    ).resolves.toMatchObject({ success: false });
    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      })
    ).resolves.toEqual({
      success: false,
      error: "Hosted SMS requires an explicit consented client.",
    });

    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("rejects non-Telnyx hosted transports before provider dispatch", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    const twilioSend = vi.fn();
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" }, "twilio", twilioSend)
    );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error:
        "Hosted texting is available only through the approved Telnyx pilot.",
    });
    expect(twilioSend).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("rechecks current consent and phone after sender resolution before hosted dispatch", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
    mocks.withSystem
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [{ tier: "cloud", billingStatus: "active", trialEndsAt: null }],
            ])
          )
      )
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [
                {
                  phone: "+15555550199",
                  smsConsent: false,
                  smsConsentAt: null,
                  smsConsentSource: null,
                  smsConsentDisclosure: null,
                },
              ],
            ])
          )
      );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Stale automation snapshot",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error:
        "Client SMS consent or phone changed before sending; delivery was blocked.",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("dispatches an allowlisted Telnyx hosted send only after current consent and suppression checks", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
    mocks.providerSend.mockResolvedValue({ success: true, id: "sms-hosted-1" });
    mocks.withSystem
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [{ tier: "cloud", billingStatus: "active", trialEndsAt: null }],
            ])
          )
      )
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [
                {
                  phone: "(555) 555-0199",
                  smsConsent: true,
                  smsConsentAt: new Date("2026-08-01T00:00:00Z"),
                  smsConsentSource: "staff_attested_form:v1",
                  smsConsentDisclosure: "Disclosure",
                },
              ],
              [],
            ])
          )
      );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: true,
      sid: "sms-hosted-1",
      error: undefined,
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
  });

  it("blocks a hosted send when the JIT suppression check finds the recipient", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
    mocks.withSystem
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [{ tier: "cloud", billingStatus: "active", trialEndsAt: null }],
            ])
          )
      )
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [
                {
                  phone: "+15555550199",
                  smsConsent: true,
                  smsConsentAt: new Date("2026-08-01T00:00:00Z"),
                  smsConsentSource: "staff_attested_form:v1",
                  smsConsentDisclosure: "Disclosure",
                },
              ],
              [{ id: "suppression-1" }],
            ])
          )
      );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error: "Recipient has opted out of SMS (STOP).",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed with zero provider calls when the JIT suppression query errors", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
    mocks.withSystem
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [{ tier: "cloud", billingStatus: "active", trialEndsAt: null }],
            ])
          )
      )
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [
                {
                  phone: "+15555550199",
                  smsConsent: true,
                  smsConsentAt: new Date("2026-08-01T00:00:00Z"),
                  smsConsentSource: "staff_attested_form:v1",
                  smsConsentDisclosure: "Disclosure",
                },
              ],
              new Error("suppression database unavailable"),
            ])
          )
      );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error: "Could not verify SMS consent; send blocked.",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("serializes revocation ahead of hosted dispatch without a lock-order rollback", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );

    const revokeReachedWrite = deferred();
    const allowRevokeCommit = deferred();
    const sendWaitingForRecipient = deferred();
    let recipientLocked = false;
    const recipientWaiters: Array<() => void> = [];
    const acquireRecipient = async () => {
      if (!recipientLocked) {
        recipientLocked = true;
        return;
      }
      sendWaitingForRecipient.resolve();
      await new Promise<void>((resolve) => recipientWaiters.push(resolve));
      recipientLocked = true;
    };
    const releaseRecipient = () => {
      recipientLocked = false;
      recipientWaiters.shift()?.();
    };
    const state = { consent: true, suppressed: false };

    const revokeTx = {
      execute: vi.fn(acquireRecipient),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: async () => undefined }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              revokeReachedWrite.resolve();
              await allowRevokeCommit.promise;
              return [{ id: CLIENT_ID }];
            },
          }),
        }),
      }),
    };
    const revokePromise = (async () => {
      const result = await revokeSmsConsentByPhoneInTransaction(
        revokeTx as never,
        {
          practiceId: PRACTICE_ID,
          phone: "+15555550199",
          reason: "manual",
        }
      );
      state.consent = false;
      state.suppressed = true;
      releaseRecipient();
      return result;
    })();
    await revokeReachedWrite.promise;

    let sendSelectCount = 0;
    const sendTx = {
      execute: vi.fn(acquireRecipient),
      select: () => {
        sendSelectCount += 1;
        const result =
          sendSelectCount === 1
            ? [
                {
                  phone: "+15555550199",
                  smsConsent: state.consent,
                  smsConsentAt: state.consent
                    ? new Date("2026-08-01T00:00:00Z")
                    : null,
                  smsConsentSource: state.consent
                    ? "staff_attested_form:v1"
                    : null,
                  smsConsentDisclosure: state.consent ? "Disclosure" : null,
                },
              ]
            : state.suppressed
              ? [{ id: "suppression-1" }]
              : [];
        const builder = {
          from: () => builder,
          where: () => builder,
          limit: () => builder,
          for: async () => result,
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject),
        };
        return builder;
      },
    };
    mocks.withSystem
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) =>
          fn(
            hostedDispatchDb([
              [{ tier: "cloud", billingStatus: "active", trialEndsAt: null }],
            ])
          )
      )
      .mockImplementationOnce(
        async (_db: unknown, fn: (tx: unknown) => unknown) => {
          const result = await fn(sendTx);
          releaseRecipient();
          return result;
        }
      );

    const sendPromise = sendSms({
      to: "+15555550199",
      body: "Must wait for revocation",
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      clientId: CLIENT_ID,
    });
    await sendWaitingForRecipient.promise;
    expect(mocks.providerSend).not.toHaveBeenCalled();

    allowRevokeCommit.resolve();
    await expect(revokePromise).resolves.toEqual({
      phone: "+15555550199",
      clientsRevoked: 1,
    });
    await expect(sendPromise).resolves.toMatchObject({ success: false });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

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
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
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
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
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
      error:
        "SMS recipient phone number must be a valid E.164 or US/CA number.",
    });

    expect(mocks.isSuppressed).not.toHaveBeenCalled();
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("waits for hosted usage recording before returning a successful real send", async () => {
    const usage = deferred();
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
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
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
    mocks.providerSend.mockResolvedValue({
      success: true,
      id: "sms-reminder-1",
    });

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
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
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
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" })
    );
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
    mocks.resolveMessagingTransport.mockResolvedValue(transport({}, "console"));
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
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });
    mocks.resolveMessagingTransport.mockResolvedValue(transport({}, "console"));

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error:
        "Hosted texting is available only through the approved Telnyx pilot.",
    });

    expect(mocks.resolveMessagingTransport).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      hosted: true,
    });
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
    mocks.resolveMessagingTransport.mockResolvedValue(transport({}, "console"));
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
    allowHostedPilot();
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
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toEqual({
      success: false,
      error: "Practice not found",
    });

    expect(mocks.hasHostedFullAccess).not.toHaveBeenCalled();
    expect(mocks.isSuppressed).not.toHaveBeenCalled();
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed for explicit locations without an active sender", async () => {
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveMessagingTransport.mockResolvedValue(undefined);

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

    expect(mocks.getMessagingProvider).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("dispatches an explicit location through its persisted provider, not the global provider", async () => {
    const twilioSend = vi
      .fn()
      .mockResolvedValue({ success: true, id: "SM-location" });
    mocks.isSuppressed.mockResolvedValue(false);
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport(
        {
          messagingServiceId: "MG-location",
          from: "+15555550122",
        },
        "twilio",
        twilioSend
      )
    );

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Location-bound message",
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      })
    ).resolves.toEqual({ success: true, sid: "SM-location", error: undefined });

    expect(mocks.getMessagingProvider).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(twilioSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: "Location-bound message",
      sender: {
        messagingServiceId: "MG-location",
        from: "+15555550122",
      },
    });
  });
});
