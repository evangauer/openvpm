import { describe, expect, it } from "vitest";
import { communicationStatusLabel } from "../status";

describe("communicationStatusLabel", () => {
  it("labels inbound read state from readAt and status", () => {
    expect(
      communicationStatusLabel({
        status: "pending",
        direction: "inbound",
        readAt: null,
      })
    ).toBe("Unread");

    expect(
      communicationStatusLabel({
        status: "pending",
        direction: "inbound",
        readAt: new Date("2026-07-01T14:00:00Z"),
      })
    ).toBe("Read by clinic");

    expect(
      communicationStatusLabel({
        status: "read",
        direction: "inbound",
        readAt: null,
      })
    ).toBe("Read by clinic");
  });

  it("labels portal delivery and read receipts for outbound clinic messages", () => {
    expect(
      communicationStatusLabel({
        status: "delivered",
        direction: "outbound",
        channel: "portal",
      })
    ).toBe("Delivered to portal");

    expect(
      communicationStatusLabel({
        status: "read",
        direction: "outbound",
        channel: "portal",
      })
    ).toBe("Read by client");
  });

  it("keeps provider delivery labels and unknown statuses stable", () => {
    expect(
      communicationStatusLabel({
        status: "failed",
        direction: "inbound",
        readAt: null,
      })
    ).toBe("Failed");
    expect(
      communicationStatusLabel({
        status: "delivered",
        direction: "outbound",
        channel: "sms",
      })
    ).toBe("Delivered");
    expect(communicationStatusLabel({ status: "queued" })).toBe("queued");
    expect(communicationStatusLabel({ status: "" })).toBe("");
  });
});
