import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE_SOURCE = readFileSync(
  new URL("./route.ts", import.meta.url),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const updateResults: unknown[][] = [];

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

  const insertReturning = vi.fn(async () => [
    { id: "00000000-0000-0000-0000-0000000000ee" },
  ]);
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
    selectWhere,
    insertConflict,
    insertReturning,
    insertValues,
    deleteWhere,
    updateSet,
    updateWhere,
    recordSmsDeliveryCallback: vi.fn(async () => ({
      eventId: "00000000-0000-0000-0000-0000000000dd",
      duplicate: false,
      result: "projected",
    })),
    validateRequest: vi.fn(() => true),
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

vi.mock("twilio", () => ({
  default: {
    validateRequest: mocks.validateRequest,
  },
}));

vi.mock("@/lib/messaging/sms-delivery-ledger", () => ({
  recordSmsDeliveryCallback: mocks.recordSmsDeliveryCallback,
}));

const { POST } = await import("./route");
const { communications } = await import("@openpims/db");
const { inboundSmsOptInEvidence, SMS_INBOUND_OPT_IN } =
  await import("@/lib/messaging/consent");
const { MESSAGING_WEBHOOK_BODY_MAX_BYTES } =
  await import("@/lib/messaging-webhook-limits");

function twilioRequest(params: Record<string, string>, signature = "sig") {
  return new Request("https://openvpm.test/api/webhooks/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params),
  });
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
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.TWILIO_AUTH_TOKEN;
});

describe("Twilio webhook", () => {
  it("rejects oversized payloads before signature verification or tenant work", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/twilio", {
        method: "POST",
        headers: {
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "sig",
        },
        body: new URLSearchParams({ From: "+15555550199" }),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Messaging webhook payload too large",
    });
    expect(mocks.validateRequest).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized payloads without a content-length header", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/twilio", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "sig",
        },
        body: "x".repeat(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Messaging webhook payload too large",
    });
    expect(mocks.validateRequest).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("uses the capped streaming body reader", () => {
    expect(ROUTE_SOURCE).toContain("readRequestTextWithLimit(");
    expect(ROUTE_SOURCE).toContain("MESSAGING_WEBHOOK_BODY_MAX_BYTES");
    expect(ROUTE_SOURCE).not.toMatch(/\b(?:req|request)\.text\(\)/);
  });

  it("rejects unsigned requests before touching tenant data", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/twilio", {
        method: "POST",
        body: new URLSearchParams({ From: "+15555550199" }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      error: "invalid signature",
    });
    expect(response.status).toBe(401);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("treats a blank auth token as missing before signature verification", async () => {
    process.env.TWILIO_AUTH_TOKEN = "   ";

    const response = await POST(
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "Running five minutes late",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      error: "invalid signature",
    });
    expect(response.status).toBe(401);
    expect(mocks.validateRequest).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("logs inbound replies for active Twilio sender locations", async () => {
    process.env.TWILIO_AUTH_TOKEN = " test-token ";
    mocks.selectResults.push(
      [
        {
          practiceId: "00000000-0000-0000-0000-0000000000aa",
          locationId: "00000000-0000-0000-0000-000000000002",
        },
      ],
      [{ id: "00000000-0000-0000-0000-000000000003" }],
    );

    const response = await POST(
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "Running five minutes late",
        MessageSid: "SM123",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.validateRequest).toHaveBeenCalledWith(
      "test-token",
      "sig",
      "https://openvpm.test/api/webhooks/twilio",
      expect.objectContaining({
        From: "+15555550199",
        To: "+15555550100",
        Body: "Running five minutes late",
        MessageSid: "SM123",
      }),
    );
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
        providerMessageId: "SM123",
        dedupeKey: "twilio:inbound:SM123",
      }),
    );
    const inserted = mocks.insertValues.mock.calls.find(
      ([value]) =>
        (value as { providerMessageId?: string }).providerMessageId === "SM123",
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

  it("falls back to MessagingServiceSid when logging inbound replies", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
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

    const response = await POST(
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "Can you confirm pickup?",
        MessageSid: "SM-profile-inbound",
        MessagingServiceSid: " MG123 ",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "logged",
    });
    expect(mocks.withSystem).toHaveBeenCalledTimes(3);
    const profileCondition = mocks.selectWhere.mock.calls[1]?.[0];
    expect(
      sqlIncludesColumnName(profileCondition, "messaging_profile_id"),
    ).toBe(true);
    expect(sqlIncludesValue(profileCondition, "MG123")).toBe(true);
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId: "00000000-0000-0000-0000-000000000003",
        channel: "sms",
        direction: "inbound",
        content: "Can you confirm pickup?",
        providerMessageId: "SM-profile-inbound",
        dedupeKey: "twilio:inbound:SM-profile-inbound",
      }),
    );
  });

  it("suppresses recipients and flips consent on STOP", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
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
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "STOP",
        MessageSid: "SM-stop",
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
        destinationE164: "+15555550199",
        action: "revoked",
        source: "inbound_opt_out:v1",
        actorType: "client",
        provider: "twilio",
        providerMessageId: "SM-stop",
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
        providerMessageId: "SM-stop",
        dedupeKey: "twilio:inbound:SM-stop",
      }),
    );
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: communications.dedupeKey,
    });
  });

  it("removes STOP suppression and restores consent on unique START matches", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
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
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "START",
        MessageSid: "SM-start",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "unsuppressed",
    });
    expect(mocks.deleteWhere).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith({
      smsConsent: true,
      smsConsentAt: expect.any(Date),
      smsConsentSource: SMS_INBOUND_OPT_IN.source,
      smsConsentDisclosure: inboundSmsOptInEvidence("START"),
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId,
        channel: "sms",
        direction: "inbound",
        subject: "SMS opt-in from +15555550199",
        content: "START",
        status: "delivered",
        providerMessageId: "SM-start",
        dedupeKey: "twilio:inbound:SM-start",
      }),
    );
    expect(mocks.insertConflict).toHaveBeenCalledWith({
      target: communications.dedupeKey,
    });
  });

  it("rejects inbound consent messages without a durable provider id", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    const response = await POST(
      twilioRequest({
        From: "+15555550199",
        To: "+15555550100",
        Body: "START",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing inbound message id",
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("persists failed delivery callbacks without suppressing recipients", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);

    const response = await POST(
      twilioRequest({
        From: "+15555550100",
        To: "+15555550199",
        MessageSid: "SM-failed",
        MessageStatus: "undelivered",
        ErrorCode: "30008",
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith({
      provider: "twilio",
      providerEventId: null,
      providerMessageId: "SM-failed",
      providerEventType: "message.status",
      providerStatus: "undelivered",
      providerErrorCode: "30008",
      classification: "failed",
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("never uses MessagingServiceSid as a delivery-attribution hint", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    mocks.selectResults.push([
      {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        locationId: "00000000-0000-0000-0000-000000000002",
      },
    ]);

    const response = await POST(
      twilioRequest({
        To: "+15555550199",
        MessageSid: "SM-profile-failed",
        MessageStatus: "undelivered",
        MessagingServiceSid: "MG123",
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "twilio",
        providerMessageId: "SM-profile-failed",
        classification: "failed",
      }),
    );
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.selectWhere).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("ledgers unrecognized callback statuses instead of discarding them", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";

    const response = await POST(
      twilioRequest({
        MessageSid: "SM-new-status",
        MessageStatus: "provider-added-state",
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.recordSmsDeliveryCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: "SM-new-status",
        providerStatus: "provider_added_state",
        classification: "unknown",
      }),
    );
  });

  it("rejects a malformed status callback without its required MessageSid", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";

    const response = await POST(
      twilioRequest({ MessageStatus: "delivered" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "missing delivery message id",
    });
    expect(mocks.recordSmsDeliveryCallback).not.toHaveBeenCalled();
  });
});
