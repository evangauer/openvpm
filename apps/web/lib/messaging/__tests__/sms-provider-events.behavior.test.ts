import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const practiceA = "00000000-0000-0000-0000-00000000000a";
  const practiceB = "00000000-0000-0000-0000-00000000000b";
  const event = {
    id: "00000000-0000-0000-0000-0000000000e1",
    receivedAt: new Date("2026-08-11T12:00:00Z"),
    provider: "telnyx",
    kind: "a2p",
    providerEventId: "provider-event-1",
    providerMessageId: null,
    providerEventType: "10dlc.brand.update",
    eventKey: "id:provider-event-1",
    rawBodyFingerprintSha256: "a".repeat(64),
    occurredAt: new Date("2026-08-11T12:00:00Z"),
    fromE164: null,
    toE164: null,
    messagingProfileId: null,
    messageBody: null,
    inboundClassification: null,
    deliveryClassification: null,
    providerStatus: "FAILED",
    providerErrorCode: null,
    a2pBrandId: "brand-drifted",
    a2pCampaignId: null,
    a2pPhoneE164: null,
    a2pStatus: "FAILED",
    a2pType: null,
    a2pEventType: null,
    a2pObservedStatus: "action_required",
    providerDetail: "Carrier rejected registration.",
    practiceId: practiceA,
    locationId: null,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-01T12:00:00Z"),
    lastAttemptAt: null,
    processedAt: null,
    lastErrorCode: null,
    lastErrorDetail: null,
  };
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];

  function tableName(table: unknown): string {
    if (!table || typeof table !== "object") return "";
    for (const symbol of Object.getOwnPropertySymbols(table)) {
      if (symbol.description?.includes("Name")) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === "string") return value;
      }
    }
    return "";
  }

  const db = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => {
      let from = "";
      const rows = () => {
        if (from === "sms_provider_events") return [event];
        if (from === "messaging_registrations") {
          return [{ practiceId: practiceB }];
        }
        if (from === "practices") {
          return [
            { id: practiceA, recoveryHold: false },
            { id: practiceB, recoveryHold: false },
          ];
        }
        return [];
      };
      const terminal = () => {
        const value = {
          for: vi.fn(() => value),
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve(rows()).then(resolve, reject),
        };
        return value;
      };
      const builder = {
        from(table: unknown) {
          from = tableName(table);
          return builder;
        },
        where: () => builder,
        orderBy: () => builder,
        limit: () => terminal(),
        for: () => terminal(),
      };
      return builder;
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        updates.push({ table: tableName(table), values });
        const terminal = {
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve([]).then(resolve, reject),
        };
        return { where: () => terminal };
      },
    })),
  };
  return { db, event, practiceA, practiceB, updates };
});

vi.mock("@openpims/db/client", () => ({ db: fake.db }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn(fake.db),
  ),
}));

const { projectSmsProviderEvent } = await import("../sms-provider-events");

describe("SMS provider immutable attribution", () => {
  it("quarantines A-ingested A2P evidence that later resolves to B without mutating B", async () => {
    fake.updates.length = 0;
    await expect(projectSmsProviderEvent(fake.event.id)).resolves.toEqual({
      outcome: "quarantined",
    });
    expect(fake.updates).toEqual([
      expect.objectContaining({
        table: "sms_provider_events",
        values: expect.objectContaining({
          state: "quarantined",
          lastErrorCode: "immutable_attribution_drift",
        }),
      }),
    ]);
    expect(
      fake.updates.some(
        (update) =>
          update.table === "messaging_registrations" ||
          update.table === "location_messaging",
      ),
    ).toBe(false);
  });
});
