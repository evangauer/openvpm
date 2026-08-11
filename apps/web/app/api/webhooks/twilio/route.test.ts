import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRequest: vi.fn(() => true),
  ingestSmsProviderEvent: vi.fn(async (_input: unknown) => ({
    eventId: "00000000-0000-0000-0000-000000000002",
    duplicate: false,
    conflict: false,
  })),
  projectSmsProviderEvent: vi.fn(async (_eventId: string) => ({
    outcome: "projected",
  })),
}));

vi.mock("twilio", () => ({
  default: { validateRequest: mocks.validateRequest },
}));

vi.mock("@/lib/messaging/sms-provider-events", () => ({
  ingestSmsProviderEvent: mocks.ingestSmsProviderEvent,
  projectSmsProviderEvent: mocks.projectSmsProviderEvent,
}));

const { POST } = await import("./route");
const { MESSAGING_WEBHOOK_BODY_MAX_BYTES } =
  await import("@/lib/messaging-webhook-limits");

function request(params: Record<string, string>, signature = "signature") {
  return new Request("https://openvpm.test/api/webhooks/twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.validateRequest.mockReturnValue(true);
  mocks.ingestSmsProviderEvent.mockResolvedValue({
    eventId: "00000000-0000-0000-0000-000000000002",
    duplicate: false,
    conflict: false,
  });
  mocks.projectSmsProviderEvent.mockResolvedValue({ outcome: "projected" });
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("Twilio durable webhook intake", () => {
  it("rejects oversized payloads before signature verification or persistence", async () => {
    const response = await POST(
      new Request("https://openvpm.test/api/webhooks/twilio", {
        method: "POST",
        headers: {
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
        },
        body: "x",
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.validateRequest).not.toHaveBeenCalled();
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("rejects unsigned callbacks before persistence", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    mocks.validateRequest.mockReturnValue(false);
    const response = await POST(request({ MessageSid: "SM1" }));
    expect(response.status).toBe(401);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("persists a signed inbound reply before projection", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    const params = {
      MessageSid: "SM-inbound-1",
      From: "+15555550199",
      To: "+15555550100",
      MessagingServiceSid: "MG-profile-1",
      Body: "Hello clinic",
    };
    await POST(request(params));
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "twilio",
        kind: "inbound",
        providerEventId: "SM-inbound-1",
        providerMessageId: "SM-inbound-1",
        providerEventType: "message.received",
        fromE164: "+15555550199",
        toE164: "+15555550100",
        messagingProfileId: "MG-profile-1",
        messageBody: "Hello clinic",
        inboundClassification: "other",
      }),
    );
    expect(
      mocks.ingestSmsProviderEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.projectSmsProviderEvent.mock.invocationCallOrder[0]!);
  });

  it("lets signed provider STOP override ambiguous body text", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    await POST(
      request({
        MessageSid: "SM-stop-1",
        From: "+15555550199",
        To: "+15555550100",
        Body: "No thanks",
        OptOutType: "STOP",
      }),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ inboundClassification: "stop" }),
    );
  });

  it("does not accept contradictory provider metadata as START", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    await POST(
      request({
        MessageSid: "SM-start-1",
        From: "+15555550199",
        To: "+15555550100",
        Body: "START",
        OptOutType: "HELP",
      }),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ inboundClassification: "other" }),
    );
  });

  it("requires a durable inbound message identity", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    const response = await POST(
      request({
        From: "+15555550199",
        To: "+15555550100",
        Body: "STOP",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("rejects a recognized MessageSid callback with no complete fact", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    const response = await POST(request({ MessageSid: "SM-incomplete" }));
    expect(response.status).toBe(400);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("prefers non-inbound delivery status even if callback includes message fields", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    await POST(
      request({
        MessageSid: "SM-delivered-with-body",
        MessageStatus: "delivered",
        From: "+15555550199",
        To: "+15555550100",
        Body: "original outbound body",
      }),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "delivery",
        deliveryClassification: "delivered",
      }),
    );
  });

  it("preserves Twilio received callbacks as inbound messages", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    await POST(
      request({
        MessageSid: "SM-received",
        SmsStatus: "received",
        From: "+15555550199",
        To: "+15555550100",
        Body: "Hello",
      }),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "inbound", messageBody: "Hello" }),
    );
  });

  it("persists delivery lifecycle facts without sender-profile hints", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    const params = {
      EventSid: "EV-status-1",
      MessageSid: "SM-status-1",
      MessageStatus: "undelivered",
      ErrorCode: "30003",
      MessagingServiceSid: "MG-must-not-attribute",
    };
    await POST(request(params));
    const input = mocks.ingestSmsProviderEvent.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      provider: "twilio",
      kind: "delivery",
      providerEventId: "EV-status-1",
      providerMessageId: "SM-status-1",
      providerEventType: "message.status",
      providerStatus: "undelivered",
      providerErrorCode: "30003",
      deliveryClassification: "failed",
    });
    expect(input).not.toHaveProperty("messagingProfileId");
  });

  it("retains unrecognized delivery status as unknown evidence", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    await POST(
      request({
        MessageSid: "SM-status-2",
        MessageStatus: "carrier_new_state",
      }),
    );
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryClassification: "unknown" }),
    );
  });

  it("acks signed callbacks with no supported inbound or delivery fact", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    const response = await POST(request({ AccountSid: "AC1" }));
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("never projects a fingerprint conflict", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    mocks.ingestSmsProviderEvent.mockResolvedValueOnce({
      eventId: "00000000-0000-0000-0000-000000000002",
      duplicate: false,
      conflict: true,
    });
    await POST(
      request({
        MessageSid: "SM-conflict",
        From: "+15555550199",
        To: "+15555550100",
        Body: "Hello",
      }),
    );
    expect(mocks.projectSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("does not ACK when durable inbox insertion fails", async () => {
    process.env.TWILIO_AUTH_TOKEN = "token";
    mocks.ingestSmsProviderEvent.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      POST(
        request({
          MessageSid: "SM-failure",
          From: "+15555550199",
          To: "+15555550100",
          Body: "Hello",
        }),
      ),
    ).rejects.toThrow("database unavailable");
    expect(mocks.projectSmsProviderEvent).not.toHaveBeenCalled();
  });
});
