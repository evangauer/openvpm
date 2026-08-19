import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    db: { update: vi.fn(() => ({ set: updateSet })) },
    updateSet,
    updateWhere,
    constructConnectV2EventNotification: vi.fn(),
    retrieveConnectAccount: vi.fn(),
    claimStripeEvent: vi.fn(async () => true),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.db),
}));
vi.mock("@/lib/stripe", () => ({
  constructConnectV2EventNotification:
    mocks.constructConnectV2EventNotification,
  retrieveConnectAccount: mocks.retrieveConnectAccount,
}));
vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
}));

const { POST } = await import("./route");
vi.spyOn(console, "error").mockImplementation(() => {});

function stripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-connect-v2", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.claimStripeEvent.mockResolvedValue(true);
});

describe("Stripe Connect Accounts v2 webhook", () => {
  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/stripe-connect-v2", {
        method: "POST",
        body: "{}",
      }) as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.constructConnectV2EventNotification).not.toHaveBeenCalled();
  });

  it("fetches the current Account and synchronizes its fail-closed state", async () => {
    mocks.constructConnectV2EventNotification.mockResolvedValue({
      id: "evt_v2_requirements",
      type: "v2.core.account[requirements].updated",
      related_object: { id: "acct_clinic", type: "v2.core.account" },
    });
    mocks.retrieveConnectAccount.mockResolvedValue({
      id: "acct_clinic",
      object: "v2.core.account",
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { status: "active" },
            stripe_balance: { payouts: { status: "active" } },
          },
        },
      },
      identity: { entity_type: "company" },
      requirements: { entries: [] },
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    expect(mocks.retrieveConnectAccount).toHaveBeenCalledWith("acct_clinic");
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_v2_requirements",
      endpoint: "connect-account-v2",
      eventType: "v2.core.account[requirements].updated",
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingStatus: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsDisabledReason: null,
      }),
    );
  });

  it("ignores unrelated thin events without fetching or claiming", async () => {
    mocks.constructConnectV2EventNotification.mockResolvedValue({
      id: "evt_ping",
      type: "v2.core.event_destination.ping",
    });

    const response = await POST(stripeRequest());

    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.retrieveConnectAccount).not.toHaveBeenCalled();
    expect(mocks.claimStripeEvent).not.toHaveBeenCalled();
  });
});
