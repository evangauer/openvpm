import { beforeEach, describe, expect, it, vi } from "vitest";

const accountsCreate = vi.fn(async (_params: Record<string, unknown>) => ({
  id: "acct_test",
}));
const accountsRetrieveCurrent = vi.fn(async () => ({ id: "acct_openvpm" }));

vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    v2: {
      core: {
        accounts: { create: accountsCreate },
      },
    },
    accounts: {
      retrieveCurrent: accountsRetrieveCurrent,
    },
  })),
}));

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit");
vi.stubEnv("STRIPE_EXPECTED_ACCOUNT_ID", "acct_openvpm");
vi.stubEnv("STRIPE_CONNECT_V2_ENABLED", "true");

const { createConnectAccount } = await import("../stripe");

beforeEach(() => {
  vi.stubEnv("STRIPE_CONNECT_V2_ENABLED", "true");
  accountsCreate.mockClear();
  accountsRetrieveCurrent.mockClear();
});

describe("createConnectAccount", () => {
  it("does not create an account before the explicit Accounts v2 cutover", async () => {
    vi.stubEnv("STRIPE_CONNECT_V2_ENABLED", "false");

    await expect(
      createConnectAccount({ practiceId: "practice-1" }),
    ).resolves.toBeNull();
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  it("creates an Accounts v2 merchant where Stripe manages fees and losses", async () => {
    await createConnectAccount({
      practiceId: "practice-1",
      email: "clinic@example.com",
      country: "us",
      businessName: "Neighborhood Vet",
    });

    expect(accountsCreate).toHaveBeenCalledTimes(1);
    const params = accountsCreate.mock.calls[0]![0];

    expect(params.dashboard).toBe("full");
    expect(params.identity).toEqual({ country: "us" });
    expect(params.configuration).toEqual({
      merchant: {
        capabilities: { card_payments: { requested: true } },
      },
    });
    expect(params.defaults).toMatchObject({
      currency: "usd",
      responsibilities: {
        fees_collector: "stripe",
        losses_collector: "stripe",
      },
    });
    expect(params.include).toEqual([
      "configuration.merchant",
      "identity",
      "requirements",
    ]);
    expect(params.metadata).toMatchObject({ practiceId: "practice-1" });
  });
});
