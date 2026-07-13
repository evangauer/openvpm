import { beforeEach, describe, expect, it, vi } from "vitest";

const accountsCreate = vi.fn(async () => ({ id: "acct_test" }));

vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    accounts: { create: accountsCreate },
  })),
}));

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit");

const { createConnectAccount } = await import("../stripe");

beforeEach(() => {
  accountsCreate.mockClear();
});

describe("createConnectAccount", () => {
  it("creates a controller-based account where Stripe manages losses", async () => {
    await createConnectAccount({
      practiceId: "practice-1",
      email: "clinic@example.com",
      country: "us",
      businessName: "Neighborhood Vet",
    });

    expect(accountsCreate).toHaveBeenCalledTimes(1);
    const params = accountsCreate.mock.calls[0]![0] as Record<string, unknown>;

    // The platform profile is the Stripe-manages-losses configuration;
    // legacy `type: "express"` (platform-liable) is rejected under it.
    expect(params.type).toBeUndefined();
    expect(params.controller).toEqual({
      losses: { payments: "stripe" },
      fees: { payer: "account" },
      stripe_dashboard: { type: "express" },
      requirement_collection: "stripe",
    });
    expect(params.country).toBe("US");
    expect(params.capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
    expect(params.metadata).toMatchObject({ practiceId: "practice-1" });
  });
});
