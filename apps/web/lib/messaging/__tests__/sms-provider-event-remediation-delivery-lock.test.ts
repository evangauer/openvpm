import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as string[],
  lockDelivery: vi.fn(async () => {
    fake.calls.push("delivery-identity");
  }),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("../sms-delivery-ledger", () => ({
  lockSmsDeliveryIdentity: fake.lockDelivery,
  recordSmsDeliveryCallbackInTransaction: vi.fn(),
}));

const { lockSmsProviderEventForRemediationInTransaction } =
  await import("../sms-provider-events");

const EVENT_ID = "00000000-0000-4000-8000-000000000201";
const PRACTICE_ID = "00000000-0000-4000-8000-000000000202";
const event = {
  id: EVENT_ID,
  receivedAt: new Date("2026-08-11T12:00:00.000Z"),
  provider: "telnyx",
  kind: "delivery",
  providerEventId: "delivery-event-201",
  providerMessageId: "provider-message-201",
  providerEventType: "message.finalized",
  eventKey: "id:delivery-event-201",
  rawBodyFingerprintSha256: "a".repeat(64),
  occurredAt: new Date("2026-08-11T11:59:59.000Z"),
  fromE164: null,
  toE164: null,
  messagingProfileId: null,
  messageBody: null,
  inboundClassification: null,
  deliveryClassification: "delivered",
  providerStatus: "delivered",
  providerErrorCode: null,
  a2pBrandId: null,
  a2pCampaignId: null,
  a2pPhoneE164: null,
  a2pStatus: null,
  a2pType: null,
  a2pEventType: null,
  a2pObservedStatus: null,
  providerDetail: null,
  practiceId: null,
  locationId: null,
  state: "quarantined",
  attemptCount: 1,
  nextAttemptAt: null,
  lastAttemptAt: new Date("2026-08-11T12:00:01.000Z"),
  processedAt: new Date("2026-08-11T12:00:01.000Z"),
  lastErrorCode: "delivery_attribution_pending",
  lastErrorDetail: "Awaiting exact accepted-send attribution.",
};

function tableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  for (const symbol of Object.getOwnPropertySymbols(table)) {
    if (symbol.description?.includes("Name")) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === "string") return value;
    }
  }
  return "unknown";
}

function database(options: { acceptedOnRevalidation?: boolean } = {}) {
  let attemptReads = 0;
  return {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => {
      let from = "unknown";
      const rows = () => {
        fake.calls.push(`select:${from}`);
        if (from === "sms_provider_events") return [event];
        if (from === "practices") {
          return [{ id: PRACTICE_ID, recoveryHold: false }];
        }
        if (from === "sms_send_attempts") {
          attemptReads += 1;
          return options.acceptedOnRevalidation && attemptReads === 2
            ? [
                {
                  id: "00000000-0000-4000-8000-000000000203",
                  practiceId: PRACTICE_ID,
                  locationId: "00000000-0000-4000-8000-000000000204",
                },
              ]
            : [];
        }
        return [];
      };
      const builder: Record<string, unknown> & PromiseLike<unknown[]> = {
        then: (resolve, reject) =>
          Promise.resolve(rows()).then(resolve, reject),
      };
      builder.from = vi.fn((table: unknown) => {
        from = tableName(table);
        return builder;
      });
      for (const method of [
        "innerJoin",
        "where",
        "groupBy",
        "orderBy",
        "limit",
      ]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.for = vi.fn(async () => rows());
      return builder;
    }),
  };
}

beforeEach(() => {
  fake.calls.length = 0;
  vi.clearAllMocks();
});

describe("globally unattributed delivery remediation locking", () => {
  it("locks all provider practices, then delivery identity, then the event before accepting zero attribution", async () => {
    const db = database();
    await expect(
      lockSmsProviderEventForRemediationInTransaction(db as never, EVENT_ID, {
        allowGloballyUnattributedDelivery: true,
        allowRecoveryHeld: true,
      }),
    ).resolves.toMatchObject({ attribution: null });

    expect(fake.calls).toEqual([
      "select:sms_provider_events",
      "select:sms_send_attempts",
      "select:practices",
      "delivery-identity",
      "select:sms_provider_events",
      "select:sms_send_attempts",
    ]);
    expect(fake.lockDelivery).toHaveBeenCalledWith(
      db,
      "telnyx",
      "provider-message-201",
    );
  });

  it("fails closed when an accepted send becomes visible during final revalidation", async () => {
    const db = database({ acceptedOnRevalidation: true });
    await expect(
      lockSmsProviderEventForRemediationInTransaction(db as never, EVENT_ID, {
        allowGloballyUnattributedDelivery: true,
        allowRecoveryHeld: true,
      }),
    ).rejects.toThrow("attribution changed during remediation");
    expect(fake.calls.indexOf("select:practices")).toBeLessThan(
      fake.calls.indexOf("delivery-identity"),
    );
    expect(fake.calls.indexOf("delivery-identity")).toBeLessThan(
      fake.calls.lastIndexOf("select:sms_provider_events"),
    );
  });
});
