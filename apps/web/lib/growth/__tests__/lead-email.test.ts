import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    insertResults: [] as Array<Array<{ id: string }>>,
    deleteResults: [] as Array<Array<{ id: string }>>,
  };
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => state.insertResults.shift() ?? []),
        })),
      })),
    })),
    delete: vi.fn(() => {
      const where = vi.fn(() => {
        const result = Promise.resolve(undefined) as Promise<undefined> & {
          returning?: () => Promise<Array<{ id: string }>>;
        };
        result.returning = async () => state.deleteResults.shift() ?? [];
        return result;
      });
      return { where };
    }),
    update: vi.fn(() => ({ set: updateSet })),
  };
  return {
    state,
    tx,
    updateSet,
    withSystem: vi.fn(async (_db: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    ),
    marketingEnabled: vi.fn(async () => true),
    lockAndCheck: vi.fn(async () => true),
    alertOps: vi.fn(async () => undefined),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/email-preferences", () => ({
  emailPreferenceRecipientHash: () => "a".repeat(64),
}));
vi.mock("@/lib/platform-email-preferences", () => ({
  marketingEmailEnabledForRecipient: mocks.marketingEnabled,
  lockAndCheckMarketingEmailEnabled: mocks.lockAndCheck,
}));

const { sendLeadEmail } = await import("../lead-email");

function opts(overrides: Record<string, unknown> = {}) {
  return {
    leadId: "lead-1",
    to: "vet@clinic.com",
    sequence: "demo-followup",
    step: 1,
    dedupeKey: "lead:demo-followup:v1:lead-1:1",
    send: vi.fn(async () => ({ success: true, id: "provider-1" })),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.state.insertResults.length = 0;
  mocks.state.deleteResults.length = 0;
  mocks.marketingEnabled.mockResolvedValue(true);
  mocks.lockAndCheck.mockResolvedValue(true);
});

describe("sendLeadEmail", () => {
  it("claims, sends, and records the provider id", async () => {
    mocks.state.insertResults.push([{ id: "claim-1" }]);
    const o = opts();
    await expect(sendLeadEmail(o)).resolves.toEqual({
      sent: true,
      deduped: false,
    });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "provider-1",
    });
  });

  it("honors an unsubscribe before claiming", async () => {
    mocks.marketingEnabled.mockResolvedValueOnce(false);
    const o = opts();
    await expect(sendLeadEmail(o)).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });
    expect(mocks.tx.insert).not.toHaveBeenCalled();
    expect(o.send).not.toHaveBeenCalled();
  });

  it("dedupes when another worker holds a fresh claim", async () => {
    mocks.state.insertResults.push([]);
    mocks.state.deleteResults.push([]);
    const o = opts();
    await expect(sendLeadEmail(o)).resolves.toEqual({
      sent: false,
      deduped: true,
    });
    expect(o.send).not.toHaveBeenCalled();
  });

  it("releases the claim when eligibility changed under the lock", async () => {
    mocks.state.insertResults.push([{ id: "claim-1" }]);
    const o = opts({ stillEligible: async () => false });
    await expect(sendLeadEmail(o)).resolves.toEqual({
      sent: false,
      deduped: false,
      suppressed: true,
    });
    expect(o.send).not.toHaveBeenCalled();
    expect(mocks.tx.delete).toHaveBeenCalledTimes(1);
  });

  it("alerts and releases the claim on a failed send so a later run retries", async () => {
    mocks.state.insertResults.push([{ id: "claim-1" }]);
    const o = opts({
      send: vi.fn(async () => ({ success: false, error: "provider down" })),
    });
    await expect(sendLeadEmail(o)).resolves.toEqual({
      sent: false,
      deduped: false,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Lead email failed",
      expect.stringContaining("provider down"),
    );
    expect(mocks.tx.delete).toHaveBeenCalledTimes(1);
  });
});
