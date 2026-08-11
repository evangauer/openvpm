import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyTelnyxSignature: vi.fn(() => true),
  ingestSmsProviderEvent: vi.fn(async (_input: unknown) => ({
    eventId: "00000000-0000-0000-0000-000000000001",
    duplicate: false,
    conflict: false,
  })),
  projectSmsProviderEvent: vi.fn(async (_eventId: string) => ({
    outcome: "projected",
  })),
}));

vi.mock("@/lib/messaging/telnyx-signature", () => ({
  verifyTelnyxSignature: mocks.verifyTelnyxSignature,
}));

vi.mock("@/lib/messaging/sms-provider-events", () => ({
  ingestSmsProviderEvent: mocks.ingestSmsProviderEvent,
  projectSmsProviderEvent: mocks.projectSmsProviderEvent,
}));

const { POST } = await import("./route");
const { MESSAGING_WEBHOOK_BODY_MAX_BYTES } =
  await import("@/lib/messaging-webhook-limits");

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://openvpm.test/api/webhooks/telnyx", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": "signature",
      "telnyx-timestamp": "timestamp",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function inboundBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: "message.received",
      id: "evt-inbound-1",
      occurred_at: "2026-08-11T12:00:00.000Z",
      payload: {
        id: "msg-inbound-1",
        from: { phone_number: "+15555550199" },
        to: [{ phone_number: "+15555550100" }],
        messaging_profile_id: "profile-1",
        text: "Hello",
        ...overrides,
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.verifyTelnyxSignature.mockReturnValue(true);
  mocks.ingestSmsProviderEvent.mockResolvedValue({
    eventId: "00000000-0000-0000-0000-000000000001",
    duplicate: false,
    conflict: false,
  });
  mocks.projectSmsProviderEvent.mockResolvedValue({ outcome: "projected" });
  delete process.env.TELNYX_PUBLIC_KEY;
  delete process.env.HOSTED_BILLING_ENABLED;
  delete process.env.MESSAGING_INBOUND_ENABLED;
});

describe("Telnyx durable webhook intake", () => {
  it("rejects oversized bodies before signature verification or persistence", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("rejects streamed oversized bodies without trusting content-length", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/telnyx", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": "signature",
          "telnyx-timestamp": "timestamp",
        },
        body: "x".repeat(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("treats a blank Telnyx public key as missing", async () => {
    process.env.TELNYX_PUBLIC_KEY = "   ";
    const response = await POST(request(inboundBody()));
    expect(response.status).toBe(401);
    expect(mocks.verifyTelnyxSignature).not.toHaveBeenCalled();
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid signature before persistence", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    mocks.verifyTelnyxSignature.mockReturnValue(false);
    const response = await POST(request(inboundBody()));
    expect(response.status).toBe(401);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("captures signed inbound events even while hosted projection is disabled", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    process.env.HOSTED_BILLING_ENABLED = "true";
    process.env.MESSAGING_INBOUND_ENABLED = "false";
    const body = inboundBody({ text: "STOP", autoresponse_type: "stop" });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "telnyx",
        kind: "inbound",
        providerEventId: "evt-inbound-1",
        providerMessageId: "msg-inbound-1",
        providerEventType: "message.received",
        fromE164: "+15555550199",
        toE164: "+15555550100",
        messagingProfileId: "profile-1",
        messageBody: "STOP",
        inboundClassification: "stop",
        rawBody: JSON.stringify(body),
      }),
    );
    expect(mocks.projectSmsProviderEvent).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("makes signed STOP win over contradictory carrier START metadata", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    await POST(
      request(
        inboundBody({
          text: "Please stop texting me",
          autoresponse_type: "start",
        }),
      ),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ inboundClassification: "stop" }),
    );
  });

  it("does not clear consent for START unless signed carrier metadata agrees", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    await POST(request(inboundBody({ text: "START" })));
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ inboundClassification: "other" }),
    );
  });

  it("requires a durable inbound provider message identity", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const body = inboundBody();
    delete (body.data.payload as Record<string, unknown>).id;
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("rejects recognized event types whose payload is missing", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const response = await POST(
      request({ data: { event_type: "message.received", id: "evt-bad" } }),
    );
    expect(response.status).toBe(400);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing sender", { from: undefined }],
    ["missing destination", { to: undefined, messaging_profile_id: undefined }],
    ["empty body", { text: "   " }],
  ])(
    "rejects malformed recognized inbound events: %s",
    async (_label, patch) => {
      process.env.TELNYX_PUBLIC_KEY = "pub";
      const response = await POST(request(inboundBody(patch)));
      expect(response.status).toBe(400);
      expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
    },
  );

  it("persists delivery receipts before opportunistic projection", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const body = {
      data: {
        event_type: "message.delivered",
        id: "evt-delivery-1",
        occurred_at: "2026-08-11T12:00:00.000Z",
        payload: { id: "msg-1", status: "delivered" },
      },
    };
    await POST(request(body));
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delivery",
        providerEventId: "evt-delivery-1",
        providerMessageId: "msg-1",
        deliveryClassification: "delivered",
        rawBody: JSON.stringify(body),
      }),
    );
    expect(
      mocks.ingestSmsProviderEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.projectSmsProviderEvent.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["message.sent", { status: "sent" }, "sent"],
    ["message.finalized", { status: "delivery_unconfirmed" }, "sent"],
    ["message.finalized", { status: "delivery_failed" }, "failed"],
    ["message.finalized", { status: "carrier_new_state" }, "unknown"],
  ])(
    "normalizes %s delivery evidence as %s",
    async (eventType, payloadPatch, expected) => {
      process.env.TELNYX_PUBLIC_KEY = "pub";
      await POST(
        request({
          data: {
            event_type: eventType,
            id: `evt-${expected}`,
            payload: { id: `msg-${expected}`, ...payloadPatch },
          },
        }),
      );
      expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryClassification: expected }),
      );
    },
  );

  it("normalizes A2P lifecycle facts and excludes legal-identifier fields", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const body = {
      data: {
        event_type: "10dlc.campaign.update",
        id: "evt-a2p-1",
        payload: {
          campaignId: "campaign-1",
          status: "FAILED",
          description: "Carrier rejected the campaign",
          reasons: [
            { description: "Website could not be verified", fields: ["ein"] },
          ],
        },
      },
    };
    await POST(request(body));
    const input = mocks.ingestSmsProviderEvent.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      kind: "a2p",
      a2pCampaignId: "campaign-1",
      a2pObservedStatus: "action_required",
    });
    const { rawBody: _signedBody, ...durableFacts } = input;
    expect(JSON.stringify(durableFacts)).not.toContain("ein");
    expect(input.providerDetail).toBe(
      "Carrier rejected the campaign; Website could not be verified",
    );
  });

  it.each([
    [{ status: "SUCCESS", type: "DELETION" }, "suspended"],
    [{ status: "DELETED" }, "suspended"],
    [{ eventType: "CAMPAIGN_EXPIRED" }, "suspended"],
    [{ eventType: "MNO_CAMPAIGN_OPERATION_SUSPENDED" }, "suspended"],
    [{ eventType: "MNO_CAMPAIGN_OPERATION_REJECTED" }, "action_required"],
    [{ status: "FAILED" }, "action_required"],
  ])(
    "maps official A2P lifecycle payload %# as %s",
    async (patch, expected) => {
      process.env.TELNYX_PUBLIC_KEY = "pub";
      await POST(
        request({
          data: {
            event_type: "10dlc.campaign.update",
            id: `evt-a2p-${expected}`,
            payload: { campaignId: "campaign-1", ...patch },
          },
        }),
      );
      expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ a2pObservedStatus: expected }),
      );
    },
  );

  it("rejects malformed A2P phone identity instead of silently dropping it", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const response = await POST(
      request({
        data: {
          event_type: "10dlc.phone_number.update",
          id: "evt-a2p-invalid-phone",
          payload: { campaignId: "campaign-1", phoneNumber: "not-a-phone" },
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("acks unsupported signed event types without creating inbox noise", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    const response = await POST(
      request({ data: { event_type: "call.initiated", payload: {} } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("never projects a fingerprint conflict", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    mocks.ingestSmsProviderEvent.mockResolvedValueOnce({
      eventId: "00000000-0000-0000-0000-000000000001",
      duplicate: false,
      conflict: true,
    });
    await POST(request(inboundBody()));
    expect(mocks.projectSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("does not ACK when durable inbox insertion fails", async () => {
    process.env.TELNYX_PUBLIC_KEY = "pub";
    mocks.ingestSmsProviderEvent.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(POST(request(inboundBody()))).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.projectSmsProviderEvent).not.toHaveBeenCalled();
  });
});
