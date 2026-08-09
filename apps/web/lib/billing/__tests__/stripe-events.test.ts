import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { attachStripeEventPractice, claimStripeEvent } from "../stripe-events";

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

  it("stores only explicit allowlisted conversion evidence", async () => {
    const values = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(async () => [{ eventId: "evt_paid" }]),
      })),
    }));
    const db = { insert: vi.fn(() => ({ values })) };
    const occurredAt = new Date("2026-08-02T03:04:05.000Z");

    await claimStripeEvent(db as never, {
      eventId: "evt_paid",
      endpoint: "subscription",
      eventType: "invoice.payment_succeeded",
      evidence: {
        eventCreatedAt: occurredAt,
        objectId: "in_paid",
        evidenceKind: "positive_subscription_invoice_paid",
        amountCents: 7900,
        currency: "usd",
      },
    });

    expect(values).toHaveBeenCalledWith({
      eventId: "evt_paid",
      endpoint: "subscription",
      eventType: "invoice.payment_succeeded",
      eventCreatedAt: occurredAt,
      objectId: "in_paid",
      evidenceKind: "positive_subscription_invoice_paid",
      amountCents: 7900,
      currency: "usd",
    });
  });

  it("attaches evidence once and rejects a missing or differently-owned row", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ eventId: "evt_1" }])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };

    await expect(
      attachStripeEventPractice(db as never, {
        eventId: "evt_1",
        endpoint: "subscription",
        practiceId: "00000000-0000-0000-0000-000000000001",
      }),
    ).resolves.toBeUndefined();
    await expect(
      attachStripeEventPractice(db as never, {
        eventId: "evt_1",
        endpoint: "subscription",
        practiceId: "00000000-0000-0000-0000-000000000002",
      }),
    ).rejects.toThrow("missing or already belongs to a different practice");
    expect(returning).toHaveBeenCalledTimes(2);
  });

  it("requires an all-null legacy shape when evidence kind is absent", () => {
    const schema = readFileSync("../../packages/db/schema/usage.ts", "utf8");

    expect(schema).toContain("${table.evidenceKind} is null and");
    expect(schema).toContain("${table.eventCreatedAt} is null and");
    expect(schema).toContain("${table.objectId} is null and");
    expect(schema).toContain("${table.amountCents} is null and");
    expect(schema).toContain("${table.currency} is null");
    expect(schema).toContain("${table.amountCents} is not null");
    expect(schema).toContain("${table.currency} is not null");
    expect(schema).toContain("length(btrim(${table.objectId})) > 0");
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
