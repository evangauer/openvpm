import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INBOUND_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../../lib/messaging/inbound.ts", import.meta.url),
  ),
  "utf8",
);
const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const updateResults: unknown[][] = [];
  const insertResults: unknown[][] = [];
  const selectLimit = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const terminal = {
      for: vi.fn(() => terminal),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return terminal;
  });
  const selectWhere = vi.fn((_condition: unknown) => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
  }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    where: selectWhere,
  }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateReturning = vi.fn(async () =>
    updateResults.length > 0
      ? updateResults.shift()
      : [{ id: "00000000-0000-0000-0000-000000000009" }],
  );
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertReturning = vi.fn(async () =>
    insertResults.length > 0
      ? insertResults.shift()
      : [{ id: "00000000-0000-0000-0000-0000000000ee" }],
  );
  const insertConflict = vi.fn((_config?: unknown) => ({
    returning: insertReturning,
  }));
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoNothing: insertConflict,
    onConflictDoUpdate: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const deleteWhere = vi.fn(async (_condition: unknown) => undefined);
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));

  const db = {
    execute: vi.fn(async () => undefined),
    select,
    update,
    insert,
    delete: deleteFrom,
  };

  return {
    db,
    selectResults,
    updateResults,
    insertResults,
    selectLimit,
    selectWhere,
    selectInnerJoin,
    insertConflict,
    insertReturning,
    insertValues,
    deleteWhere,
    updateReturning,
    updateSet,
    updateWhere,
    alertOps: vi.fn(async () => undefined),
    recordSmsDeliveryCallback: vi.fn(async () => ({
      eventId: "00000000-0000-0000-0000-0000000000dd",
      duplicate: false,
      result: "projected",
    })),
    verifyTelnyxSignature: vi.fn(() => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
    withTenant: vi.fn(
      async (_db: unknown, _practiceId: string, fn: (tx: unknown) => unknown) =>
        fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/messaging/telnyx-signature", () => ({
  verifyTelnyxSignature: mocks.verifyTelnyxSignature,
}));

vi.mock("@/lib/messaging/sms-delivery-ledger", () => ({
  recordSmsDeliveryCallback: mocks.recordSmsDeliveryCallback,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { POST } = await import("./route");
const { communications } = await import("@openpims/db");
const { inboundSmsOptInEvidence, SMS_INBOUND_OPT_IN } =
  await import("@/lib/messaging/consent");
const { MESSAGING_WEBHOOK_BODY_MAX_BYTES } =
  await import("@/lib/messaging-webhook-limits");

function sqlIncludesColumnParamPair(
  value: unknown,
  columnName: string,
  paramValue: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chunk = value as { name?: unknown; queryChunks?: unknown[] };
  if (!Array.isArray(chunk.queryChunks)) {
    return false;
  }

  const hasColumn = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === columnName,
  );
  const hasParam = chunk.queryChunks.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const candidate = item as { value?: unknown };
    return Object.prototype.hasOwnProperty.call(candidate, "value")
      ? Object.is(candidate.value, paramValue)
      : false;
  });

  return (
    (hasColumn && hasParam) ||
    chunk.queryChunks.some((item) =>
      sqlIncludesColumnParamPair(item, columnName, paramValue),
    )
  );
}

function sqlIncludesColumnName(
  value: unknown,
  columnName: string,
  seen = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  const candidate = value as { name?: unknown; queryChunks?: unknown[] };
  if (candidate.name === columnName) return true;
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesColumnName(item, columnName, seen),
    );
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesColumnName(item, columnName, seen),
  );
}

function sqlIncludesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (Object.is(value, needle)) return true;
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  if (
    Object.prototype.hasOwnProperty.call(candidate, "value") &&
    Object.is(candidate.value, needle)
  ) {
    return true;
  }
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesValue(item, needle, seen),
    );
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesValue(item, needle, seen),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.updateResults.length = 0;
  mocks.insertResults.length = 0;
  delete process.env.TELNYX_PUBLIC_KEY;
  delete process.env.HOSTED_BILLING_ENABLED;
  delete process.env.MESSAGING_INBOUND_ENABLED;
});

describe("Telnyx webhook", () => {
  it("acknowledges but does not project hosted callbacks while inbound is deferred", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    process.env.HOSTED_BILLING_ENABLED = "true";
    process.env.MESSAGING_INBOUND_ENABLED = "false";
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "telnyx-signature-ed25519": "signature",
          "telnyx-timestamp": "timestamp",
        },
        body: JSON.stringify({
          data: {
            event_type: "message.received",
            id: "evt-deferred",
            payload: {
              from: { phone_number: "+15555550199" },
              to: [{ phone_number: "+15555550100" }],
              text: "STOP",
            },
          },
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.verifyTelnyxSignature).toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.recordSmsDeliveryCallback).not.toHaveBeenCalled();
  });

  it("persists signed 10DLC failures and disables clinic senders", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const registration = {
      id: "00000000-0000-0000-0000-000000000008",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      status: "pending",
    };
    mocks.selectResults.push([registration], [registration], []);
    const body = JSON.stringify({
      data: {
        event_type: "10dlc.campaign.update",
        id: "evt-a2p-1",
        payload: {
          brandId: "brand-1",
          campaignId: "campaign-1",
          type: "TELNYX_REVIEW",
          status: "REJECTED",
          description: "Privacy policy could not be verified",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.withSystem).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "action_required",
        providerCampaignStatus: "REJECTED",
        lastError: "Privacy policy could not be verified",
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationStatus: "action_required",
        enabled: false,
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "provider_state_observed",
        operation: "registration_reconciliation",
        reasonCode: "carrier_webhook_observed",
        actorType: "system",
      }),
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "successful DELETION",
      eventId: "evt-phone-deletion",
      providerStatus: "success",
      payload: {
        campaignId: "campaign-1",
        phoneNumber: "+15555550100",
        status: "success",
        type: "DELETION",
        reasons: [],
      },
    },
    {
      label: "STATUS_UPDATE to DELETED",
      eventId: "evt-phone-status-deleted",
      providerStatus: "DELETED",
      payload: {
        campaignId: "campaign-1",
        phoneNumber: "+15555550100",
        status: "DELETED",
        type: "STATUS_UPDATE",
      },
    },
  ])(
    "fails an active sender closed for an official Telnyx $label event",
    async ({ eventId, providerStatus, payload }) => {
      process.env.TELNYX_PUBLIC_KEY = "pub";
      const practiceId = "00000000-0000-0000-0000-0000000000aa";
      const registration = {
        id: "00000000-0000-0000-0000-000000000008",
        practiceId,
        status: "active",
      };
      mocks.selectResults.push(
        [registration],
        [
          {
            practiceId,
            locationId: "00000000-0000-0000-0000-000000000002",
          },
        ],
        [registration],
        [],
      );
      mocks.updateResults.push([{ ...registration, status: "suspended" }]);
      const body = JSON.stringify({
        data: {
          event_type: "10dlc.phone_number.update",
          id: eventId,
          occurred_at: "2024-08-07T17:22:37.328+00:00",
          payload,
          record_type: "event",
        },
        meta: {
          attempt: 1,
          delivered_to: "https://app.openvpm.test/api/webhooks/telnyx",
        },
      });

      const response = await POST(
        new Request("https://openvpm.test/api/webhooks/telnyx", {
          method: "POST",
          headers: {
            "telnyx-signature-ed25519": "sig",
            "telnyx-timestamp": "123",
          },
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.withSystem).toHaveBeenCalledTimes(1);
      expect(mocks.updateSet).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          status: "suspended",
          providerCampaignStatus: providerStatus,
        }),
      );
      expect(mocks.updateSet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          registrationStatus: "suspended",
          enabled: false,
          providerProfileReady: false,
          providerProfileSyncedAt: null,
        }),
      );
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "provider_state_observed",
          statusBefore: "active",
          statusAfter: "suspended",
          operationId: expect.any(String),
        }),
      );
      expect(mocks.alertOps).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      providerEventType: "CAMPAIGN_EXPIRED",
      expectedStatus: "suspended",
    },
    {
      providerEventType: "MNO_CAMPAIGN_OPERATION_SUSPENDED",
      expectedStatus: "suspended",
    },
    {
      providerEventType: "MNO_CAMPAIGN_OPERATION_REJECTED",
      expectedStatus: "action_required",
    },
  ])(
    "fails an active sender closed for official TCR eventType $providerEventType",
    async ({ providerEventType, expectedStatus }) => {
      process.env.TELNYX_PUBLIC_KEY = "pub";
      const practiceId = "00000000-0000-0000-0000-0000000000aa";
      const registration = {
        id: "00000000-0000-0000-0000-000000000008",
        practiceId,
        status: "active",
      };
      mocks.selectResults.push([registration], []);
      mocks.updateResults.push([{ ...registration, status: expectedStatus }]);
      const body = JSON.stringify({
        data: {
          event_type: "10dlc.campaign.update",
          id: `evt-${providerEventType.toLowerCase()}`,
          payload: {
            campaignId: "campaign-1",
            type: "TCR_EVENT",
            eventType: providerEventType,
          },
        },
      });

      const response = await POST(
        new Request("https://openvpm.test/api/webhooks/telnyx", {
          method: "POST",
          headers: {
            "telnyx-signature-ed25519": "sig",
            "telnyx-timestamp": "123",
          },
          body,
        }),
      );

      expect(response.status).toBe(200);
      expect(mocks.updateSet).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          status: expectedStatus,
          providerCampaignStatus: providerEventType,
        }),
      );
      expect(mocks.updateSet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          registrationStatus: expectedStatus,
          enabled: false,
          providerProfileReady: false,
          providerProfileSyncedAt: null,
        }),
      );
    },
  );

  it("retains bounded provider reason descriptions without fields or legal identifiers", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const registration = {
      id: "00000000-0000-0000-0000-000000000008",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      status: "pending",
    };
    mocks.selectResults.push([registration], []);
    const body = JSON.stringify({
      data: {
        event_type: "10dlc.brand.update",
        id: "evt-brand-object-reasons",
        occurred_at: "2024-08-07T17:22:37.328+00:00",
        payload: {
          brandId: "brand-1",
          status: "failed",
          type: "REGISTRATION",
          description:
            "Registration rejected for alex@example.com and +1 (555) 555-0199",
          reasons: [
            {
              fields: ["taxIdLast4", "legalName"],
              description: "Submitted identifier 12-3456789.\nContact support.",
            },
            { fields: ["secretFieldA"], description: "A".repeat(700) },
            { fields: ["secretFieldB"], description: "B".repeat(700) },
          ],
        },
        record_type: "event",
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    const registrationUpdate = (
      mocks.updateSet.mock.calls as unknown[][]
    )[0]?.[0] as { lastError?: string | null } | undefined;
    expect(registrationUpdate).toMatchObject({ status: "action_required" });
    expect(registrationUpdate?.lastError).toContain(
      "Registration rejected for [redacted email] and [redacted number]",
    );
    expect(registrationUpdate?.lastError).toContain(
      "Submitted identifier [redacted number]. Contact support.",
    );
    expect(registrationUpdate?.lastError?.length).toBeLessThanOrEqual(1_000);
    expect(registrationUpdate?.lastError).not.toContain("12-3456789");
    expect(registrationUpdate?.lastError).not.toContain("alex@example.com");
    expect(registrationUpdate?.lastError).not.toContain("555-0199");
    expect(registrationUpdate?.lastError).not.toContain("\n");
    expect(JSON.stringify(registrationUpdate)).not.toMatch(
      /taxIdLast4|legalName|secretFieldA|secretFieldB/,
    );
  });

  it("acknowledges a retried 10DLC event without rewriting its projection", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const registration = {
      id: "00000000-0000-0000-0000-000000000008",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      status: "pending",
    };
    mocks.selectResults.push(
      [registration],
      [registration],
      [],
      [registration],
      [registration],
      [{ id: "00000000-0000-0000-0000-0000000000ee" }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "10dlc.campaign.update",
        id: "evt-a2p-retry",
        payload: {
          brandId: "brand-1",
          campaignId: "campaign-1",
          status: "PENDING",
        },
      },
    });
    const request = () =>
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      });

    await expect(POST(request())).resolves.toMatchObject({ status: 200 });
    await expect(POST(request())).resolves.toMatchObject({ status: 200 });

    expect(mocks.db.execute).toHaveBeenCalledTimes(2);
    expect(mocks.updateSet).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("quarantines every matched sender when signed A2P identities cross tenants", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const practiceA = "00000000-0000-0000-0000-0000000000aa";
    const practiceB = "00000000-0000-0000-0000-0000000000bb";
    const registrationA = {
      id: "00000000-0000-0000-0000-000000000008",
      practiceId: practiceA,
      status: "active",
    };
    const registrationB = {
      id: "00000000-0000-0000-0000-000000000009",
      practiceId: practiceB,
      status: "active",
    };
    mocks.selectResults.push(
      [registrationB],
      [registrationB],
      [
        {
          practiceId: practiceA,
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [registrationA],
    );
    const body = JSON.stringify({
      data: {
        event_type: "10dlc.phone_number.update",
        id: "evt-cross-tenant",
        payload: {
          brandId: "brand-b",
          campaignId: "campaign-b",
          phoneNumber: "+15555550100",
          status: "FAILED",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        registrationStatus: "action_required",
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
    const quarantineWhere = mocks.updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesValue(quarantineWhere, practiceA)).toBe(true);
    expect(sqlIncludesValue(quarantineWhere, practiceB)).toBe(true);
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Telnyx A2P identity conflict",
      expect.stringContaining("Matching senders were disabled"),
    );
  });

  it("rejects oversized payloads before signature verification or tenant work", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Messaging webhook payload too large",
    });
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized payloads without a content-length header", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body: "x".repeat(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Messaging webhook payload too large",
    });
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("uses the capped streaming body reader", () => {
    expect(ROUTE_SOURCE).toContain("readRequestTextWithLimit(");
    expect(ROUTE_SOURCE).toContain("MESSAGING_WEBHOOK_BODY_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toMatch(/\b(?:req|request)\.text\(\)/);
  });

  it("treats a blank public key as missing before signature verification", async () => {
    process.env.TELNYX_PUBLIC_KEY = "   ";
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-inbound",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "Running five minutes late",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid signature",
    });
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("persists authenticated delivery receipts before exact-ledger projection", async () => {
    process.env.TELNYX_PUBLIC_KEY = " test-public-key ";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);
    const body = JSON.stringify({
      data: {
        id: "evt-123",
        occurred_at: "2026-08-09T12:00:00.000Z",
        event_type: "message.finalized",
        payload: {
          id: "msg-123",
          from: { phone_number: "+15555550100" },
          to: [{ phone_number: "+15555550199", status: "delivered" }],
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.verifyTelnyxSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKeyB64: "test-public-key",
      }),
    );
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith({
      provider: "telnyx",
      providerEventId: "evt-123",
      providerMessageId: "msg-123",
      providerEventType: "message.finalized",
      providerStatus: "delivered",
      providerErrorCode: null,
      classification: "delivered",
      occurredAt: new Date("2026-08-09T12:00:00.000Z"),
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("never uses sender-profile hints to attribute delivery receipts", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);
    const body = JSON.stringify({
      data: {
        event_type: "message.finalized",
        payload: {
          id: "msg-profile",
          messaging_profile_id: " profile-1 ",
          to: [{ phone_number: "+15555550199", status: "delivered" }],
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "telnyx",
        providerMessageId: "msg-profile",
        classification: "delivered",
      }),
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.selectWhere).not.toHaveBeenCalled();
  });

  it("classifies sent delivery receipts for the monotone ledger reducer", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);
    const body = JSON.stringify({
      data: {
        event_type: "message.sent",
        payload: {
          id: "msg-sent",
          from: { phone_number: "+15555550100" },
          to: [{ phone_number: "+15555550199", status: "sent" }],
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "msg-sent",
        classification: "sent",
      }),
    );
  });

  it("ledgers unrecognized delivery statuses for operator review", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const body = JSON.stringify({
      data: {
        id: "evt-new-status",
        event_type: "message.finalized",
        payload: { id: "msg-new-status", status: "new_provider_state" },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerStatus: "new_provider_state",
        classification: "unknown",
      }),
    );
  });

  it("logs inbound replies for active sender locations", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: "00000000-0000-0000-0000-000000000003" }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-inbound",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "Running five minutes late",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.selectInnerJoin).toHaveBeenCalled();
    expect(mocks.withTenant).toHaveBeenCalledWith(
      mocks.db,
      "00000000-0000-0000-0000-0000000000aa",
      expect.any(Function),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId: "00000000-0000-0000-0000-000000000003",
        channel: "sms",
        direction: "inbound",
        content: "Running five minutes late",
        providerMessageId: "msg-inbound",
        dedupeKey: "telnyx:inbound:msg-inbound",
      }),
    );
    const inserted = mocks.insertValues.mock.calls.find(
      ([value]) =>
        (value as { providerMessageId?: string }).providerMessageId ===
        "msg-inbound",
    )?.[0] as { assignedTo?: unknown };
    expect(inserted.assignedTo).toBeTruthy();
    expect(sqlIncludesColumnName(inserted.assignedTo, "assigned_to")).toBe(
      true,
    );
    expect(sqlIncludesColumnName(inserted.assignedTo, "client_id")).toBe(true);
    expect(
      sqlIncludesValue(
        inserted.assignedTo,
        "00000000-0000-0000-0000-0000000000aa",
      ),
    ).toBe(true);
    expect(
      sqlIncludesValue(
        inserted.assignedTo,
        "00000000-0000-0000-0000-000000000003",
      ),
    ).toBe(true);
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: communications.dedupeKey,
    });
  });

  it("fails closed when sender and messaging-profile identities disagree", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [],
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: "00000000-0000-0000-0000-000000000003" }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-profile-inbound",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          messaging_profile_id: "profile-1",
          text: "Following up",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
    const profileCondition = mocks.selectWhere.mock.calls[1]?.[0];
    expect(
      sqlIncludesColumnName(profileCondition, "messaging_profile_id"),
    ).toBe(true);
    expect(sqlIncludesValue(profileCondition, "profile-1")).toBe(true);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("ignores blank inbound messages before tenant writes", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-blank",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "   ",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("leaves inbound replies unlinked when multiple active clients share the sender phone", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [
        { id: "00000000-0000-0000-0000-000000000003" },
        { id: "00000000-0000-0000-0000-000000000004" },
      ],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-ambiguous",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "Can you check both pets?",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        direction: "inbound",
        content: "Can you check both pets?",
        providerMessageId: "msg-ambiguous",
        dedupeKey: "telnyx:inbound:msg-ambiguous",
      }),
    );
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: expect.any(String),
      }),
    );
  });

  it("logs STOP opt-outs to the inbox after suppressing and flipping consent", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const clientId = "00000000-0000-0000-0000-000000000003";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: clientId }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-stop",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "STOP",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "suppressed",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId: null,
        locationId: "00000000-0000-0000-0000-000000000002",
        destinationE164: "+15555550199",
        action: "revoked",
        source: "inbound_opt_out:v1",
        actorType: "client",
        provider: "telnyx",
        providerMessageId: "msg-stop",
      }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
        phone: "+15555550199",
        reason: "stop",
        detail: 'Inbound opt-out: "STOP"',
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId,
        channel: "sms",
        direction: "inbound",
        subject: "SMS opt-out from +15555550199",
        content: "STOP",
        status: "delivered",
        providerMessageId: "msg-stop",
        dedupeKey: "telnyx:inbound:msg-stop",
      }),
    );
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: communications.dedupeKey,
    });
  });

  it("rejects inbound consent messages without a durable provider id", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body: JSON.stringify({
          data: {
            event_type: "message.received",
            payload: {
              from: { phone_number: "+15555550199" },
              to: [{ phone_number: "+15555550100" }],
              text: "STOP",
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing inbound message id",
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("restores client SMS consent on START only when the sender phone uniquely matches a client", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const clientId = "00000000-0000-0000-0000-000000000003";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: clientId }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-start",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "START",
          autoresponse_type: "START",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "unsuppressed",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId,
        locationId: "00000000-0000-0000-0000-000000000002",
        destinationE164: "+15555550199",
        action: "granted",
        source: SMS_INBOUND_OPT_IN.source,
        disclosureVersion: SMS_INBOUND_OPT_IN.version,
        actorType: "client",
        provider: "telnyx",
        providerMessageId: "msg-start",
      }),
    );
    expect(mocks.deleteWhere).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith({
      smsConsent: true,
      smsConsentAt: expect.any(Date),
      smsConsentSource: SMS_INBOUND_OPT_IN.source,
      smsConsentDisclosure: inboundSmsOptInEvidence("START"),
    });
    const condition = mocks.updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnParamPair(condition, "id", clientId)).toBe(true);
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId,
        channel: "sms",
        direction: "inbound",
        subject: "SMS opt-in from +15555550199",
        content: "START",
        status: "delivered",
        providerMessageId: "msg-start",
        dedupeKey: "telnyx:inbound:msg-start",
      }),
    );
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: communications.dedupeKey,
    });
  });

  it("does not restore consent when signed carrier START classification is absent", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const clientId = "00000000-0000-0000-0000-000000000003";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: clientId }],
    );

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body: JSON.stringify({
          data: {
            event_type: "message.received",
            payload: {
              id: "msg-yes-without-provider-classification",
              from: { phone_number: "+15555550199" },
              to: [{ phone_number: "+15555550100" }],
              text: "YES",
            },
          },
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ smsConsent: true }),
    );
  });

  it("lets an unambiguous revocation override contradictory carrier START classification", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [],
    );

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body: JSON.stringify({
          data: {
            event_type: "message.received",
            payload: {
              id: "msg-provider-disagreement",
              from: { phone_number: "+15555550199" },
              to: [{ phone_number: "+15555550100" }],
              text: "please unsubscribe",
              autoresponse_type: "START",
            },
          },
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "suppressed",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationE164: "+15555550199",
        action: "revoked",
        providerMessageId: "msg-provider-disagreement",
      }),
    );
  });

  it("fails the START transaction when the locked client projection is not updated", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: "00000000-0000-0000-0000-000000000003" }],
      [],
    );
    mocks.updateResults.push([]);
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-start-stale-client",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "START",
          autoresponse_type: "START",
        },
      },
    });

    await expect(
      POST(
        new Request("https://openvpm.test/api/webhooks/telnyx", {
          method: "POST",
          headers: {
            "telnyx-signature-ed25519": "sig",
            "telnyx-timestamp": "123",
          },
          body,
        }),
      ),
    ).rejects.toThrow(
      "Inbound SMS opt-in client changed before consent could be projected",
    );
  });

  it("does not reapply consent projection or suppression changes on provider replay", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const clientId = "00000000-0000-0000-0000-000000000003";
    const location = [
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ];
    mocks.selectResults.push(location, [{ id: clientId }], []);
    mocks.insertResults.push([{ id: "00000000-0000-0000-0000-0000000000ee" }]);

    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-start-replay",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "START",
          autoresponse_type: "START",
        },
      },
    });
    const request = () =>
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      });

    await expect((await POST(request())).json()).resolves.toEqual({
      ok: true,
      action: "unsuppressed",
    });

    mocks.selectResults.push(location, [{ id: clientId }], []);
    mocks.insertResults.push([]);
    await expect((await POST(request())).json()).resolves.toEqual({
      ok: true,
      action: "unsuppressed",
    });

    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);

    // A historical START replay must not claim success over a later STOP.
    mocks.selectResults.push(
      location,
      [{ id: clientId }],
      [{ reason: "stop" }],
    );
    mocks.insertResults.push([]);
    await expect((await POST(request())).json()).resolves.toEqual({
      ok: true,
      action: "suppressed",
    });

    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("keeps consent off when START encounters a manual suppression", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    const clientId = "00000000-0000-0000-0000-000000000003";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: clientId }],
      [{ id: "00000000-0000-0000-0000-000000000099" }],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-start-manual-block",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "START",
          autoresponse_type: "START",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "suppressed",
    });
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId,
        subject: "SMS opt-in blocked for +15555550199",
        providerMessageId: "msg-start-manual-block",
      }),
    );
  });

  it("does not broadly restore client SMS consent on START when the sender phone is ambiguous", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [
        { id: "00000000-0000-0000-0000-000000000003" },
        { id: "00000000-0000-0000-0000-000000000004" },
      ],
    );
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-start-ambiguous",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "START",
          autoresponse_type: "START",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "unsuppressed",
    });
    expect(mocks.deleteWhere).toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        direction: "inbound",
        subject: "SMS opt-in from +15555550199",
        content: "START",
        providerMessageId: "msg-start-ambiguous",
        dedupeKey: "telnyx:inbound:msg-start-ambiguous",
      }),
    );
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: expect.any(String),
      }),
    );
  });

  it("uses a bounded dedupe key for long inbound provider ids", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [],
    );
    const longProviderId = `msg-${"x".repeat(220)}`;
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: longProviderId,
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          text: "Please call me",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: longProviderId,
        dedupeKey: expect.stringMatching(/^telnyx:inbound:[a-f0-9]{64}$/),
      }),
    );
    const inserted = mocks.insertValues.mock.calls[0]?.[0] as {
      dedupeKey?: string;
    };
    expect(inserted.dedupeKey?.length).toBeLessThanOrEqual(160);
  });

  it("ledgers generic failed delivery receipts without suppressing recipients", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);
    const body = JSON.stringify({
      data: {
        event_type: "message.delivery_failed",
        payload: {
          id: "msg-failed",
          from: { phone_number: "+15555550100" },
          to: [{ phone_number: "+15555550199", status: "failed" }],
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "msg-failed",
        classification: "failed",
      }),
    );
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.insertConflict).not.toHaveBeenCalled();
  });

  it("retains unmatched failed delivery receipts for reconciliation", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);
    mocks.updateResults.push([]);
    const body = JSON.stringify({
      data: {
        event_type: "message.delivery_failed",
        payload: {
          id: "msg-unmatched-failed",
          from: { phone_number: "+15555550100" },
          to: [{ phone_number: "+15555550199", status: "failed" }],
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "msg-unmatched-failed",
        classification: "failed",
      }),
    );
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("ignores inbound replies to stale or deleted sender locations", async () => {
    process.env.TELNYX_PUBLIC_KEY = "test-public-key";
    mocks.selectResults.push([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify({
      data: {
        event_type: "message.received",
        payload: {
          id: "msg-inbound",
          from: { phone_number: "+15555550199" },
          to: [{ phone_number: "+15555550100" }],
          messaging_profile_id: "profile-private-clinic-identifier",
          text: "Hello",
        },
      },
    });

    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "sig",
          "telnyx-timestamp": "123",
        },
        body,
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[telnyx-webhook] inbound to unrecognised sender",
    );
    const warningOutput = JSON.stringify(warn.mock.calls);
    expect(warningOutput).not.toMatch(
      /\+15555550100|\+15555550199|profile-private-clinic-identifier|msg-inbound/,
    );
    warn.mockRestore();
  });

  it("requires active practices when resolving inbound sender locations", () => {
    const senderLookup = INBOUND_SOURCE.match(
      /async function findMessagingLocationMatching[\s\S]+?return matches\.length === 1 \? \(?matches\[0\] \?\? null\)? : null;/,
    )?.[0];

    expect(senderLookup).toContain("innerJoin(");
    expect(senderLookup).toContain("practices");
    expect(senderLookup).toContain("isNull(practices.deletedAt)");
  });

  it("keeps inbound START identity stable under the recipient and client locks", () => {
    const optIn = INBOUND_SOURCE.match(
      /async function applyInboundSmsOptIn[\s\S]+?async function logInboundSmsCommunication/,
    )?.[0];

    expect(optIn).toMatch(/\.limit\(2\)\s*\.for\("update"\)/);
    expect(optIn).toContain(".returning({ id: clients.id })");
    expect(optIn).toContain("updated.length !== 1");
  });
});
