import { describe, expect, it, vi } from "vitest";
import { claimStripeEvent } from "../stripe-events";

function dbReturning(rows: unknown[]) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

describe("claimStripeEvent", () => {
  it("returns true when the event id is inserted", async () => {
    const db = dbReturning([{ eventId: "evt_1" }]);

    await expect(
      claimStripeEvent(db as never, {
        eventId: "evt_1",
        endpoint: "client-invoice",
        eventType: "checkout.session.completed",
      })
    ).resolves.toBe(true);
  });

  it("returns false for duplicate event ids", async () => {
    const db = dbReturning([]);

    await expect(
      claimStripeEvent(db as never, {
        eventId: "evt_1",
        endpoint: "subscription",
        eventType: "invoice.payment_failed",
      })
    ).resolves.toBe(false);
  });
});
