import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  return {
    db: {
      update: vi.fn(() => ({ set: updateSet })),
    },
    updateSet,
    updateWhere,
    constructConnectWebhookEvent: vi.fn(),
    claimStripeEvent: vi.fn(async () => true),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.db),
}));

vi.mock("@/lib/stripe", () => ({
  constructConnectWebhookEvent: mocks.constructConnectWebhookEvent,
}));

vi.mock("@/lib/billing/stripe-events", () => ({
  claimStripeEvent: mocks.claimStripeEvent,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/billing/client-receipts", () => ({
  loadClientReceipt: vi.fn(async () => null),
  deliverClientReceipt: vi.fn(async () => undefined),
}));

const { POST } = await import("./route");

function stripeRequest() {
  return new Request("https://openvpm.test/api/webhooks/stripe-connect", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  }) as never;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.claimStripeEvent.mockResolvedValue(true);
});

describe("Stripe Connect webhook", () => {
  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/stripe-connect", {
        method: "POST",
        body: "{}",
      }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing stripe-signature header",
    });
    expect(mocks.constructConnectWebhookEvent).not.toHaveBeenCalled();
  });

  it("syncs connected account status from account.updated events", async () => {
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_connect_account",
      type: "account.updated",
      data: {
        object: {
          id: "acct_123",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [], disabled_reason: null },
        },
      },
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    expect(mocks.claimStripeEvent).toHaveBeenCalledWith(mocks.db, {
      eventId: "evt_connect_account",
      endpoint: "client-invoice-connect",
      eventType: "account.updated",
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        onboardingStatus: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsDisabledReason: null,
      })
    );
  });

  it("skips side effects for duplicate Connect events", async () => {
    mocks.claimStripeEvent.mockResolvedValueOnce(false);
    mocks.constructConnectWebhookEvent.mockResolvedValueOnce({
      id: "evt_duplicate",
      type: "account.updated",
      data: { object: { id: "acct_123" } },
    });

    const response = await POST(stripeRequest());

    expect(response.status).toBe(200);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });
});
