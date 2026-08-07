import { readFileSync } from "node:fs";
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

  it("returns false for a duplicate event id on the same endpoint", async () => {
    const db = dbReturning([]);

    await expect(
      claimStripeEvent(db as never, {
        eventId: "evt_1",
        endpoint: "subscription",
        eventType: "invoice.payment_failed",
      })
    ).resolves.toBe(false);
  });

  it("stores the endpoint so shared event types are scoped correctly", async () => {
    const values = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(async () => [{ eventId: "evt_shared" }]),
      })),
    }));
    const db = { insert: vi.fn(() => ({ values })) };

    await claimStripeEvent(db as never, {
      eventId: "evt_shared",
      endpoint: "client-invoice",
      eventType: "checkout.session.completed",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_shared",
        endpoint: "client-invoice",
      })
    );
  });

  it("keys durable claims by event id and endpoint", () => {
    const schema = readFileSync("../../packages/db/schema/usage.ts", "utf8");
    const migration = readFileSync(
      "../../packages/db/drizzle/0034_stripe_event_endpoint_scope.sql",
      "utf8"
    );

    expect(schema).toContain(
      "primaryKey({ columns: [table.eventId, table.endpoint] })"
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "stripe_events_pkey"'
    );
    expect(migration).toContain(
      'PRIMARY KEY("event_id","endpoint")'
    );
  });
});
