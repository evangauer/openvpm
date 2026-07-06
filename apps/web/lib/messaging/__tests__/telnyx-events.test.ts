import { describe, expect, it } from "vitest";
import {
  telnyxDeliveryStatus,
  telnyxProviderMessageId,
} from "../telnyx-events";

describe("Telnyx event helpers", () => {
  it("extracts the provider message id from common payload shapes", () => {
    expect(telnyxProviderMessageId({ id: "msg-1" })).toBe("msg-1");
    expect(telnyxProviderMessageId({ message_id: "msg-2" })).toBe("msg-2");
    expect(telnyxProviderMessageId({ id: "" })).toBeNull();
  });

  it("maps finalized delivery statuses to communications statuses", () => {
    expect(
      telnyxDeliveryStatus("message.finalized", {
        id: "msg-1",
        to: [{ status: "delivered" }],
      })
    ).toBe("delivered");
    expect(
      telnyxDeliveryStatus("message.finalized", {
        id: "msg-1",
        delivery_status: "delivery-failed",
      })
    ).toBe("failed");
    expect(
      telnyxDeliveryStatus("message.finalized", {
        id: "msg-1",
        status: "queued",
      })
    ).toBe("sent");
  });

  it("maps explicit Telnyx message lifecycle events", () => {
    expect(telnyxDeliveryStatus("message.sent", { id: "msg-1" })).toBe(
      "sent"
    );
    expect(telnyxDeliveryStatus("message.delivered", { id: "msg-1" })).toBe(
      "delivered"
    );
    expect(
      telnyxDeliveryStatus("message.delivery_failed", { id: "msg-1" })
    ).toBe("failed");
    expect(telnyxDeliveryStatus("message.received", { id: "msg-1" })).toBeNull();
  });
});
