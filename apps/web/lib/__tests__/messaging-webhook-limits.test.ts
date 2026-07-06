import { describe, expect, it } from "vitest";
import {
  MESSAGING_WEBHOOK_BODY_MAX_BYTES,
  messagingWebhookBodyTooLarge,
  messagingWebhookContentLengthTooLarge,
} from "../messaging-webhook-limits";

describe("messaging webhook payload limits", () => {
  it("rejects oversized content-length headers", () => {
    expect(
      messagingWebhookContentLengthTooLarge(
        new Headers({
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1),
        })
      )
    ).toBe(true);
    expect(
      messagingWebhookContentLengthTooLarge(
        new Headers({
          "content-length": String(MESSAGING_WEBHOOK_BODY_MAX_BYTES),
        })
      )
    ).toBe(false);
  });

  it("rejects oversized raw bodies", () => {
    expect(
      messagingWebhookBodyTooLarge(
        "a".repeat(MESSAGING_WEBHOOK_BODY_MAX_BYTES + 1)
      )
    ).toBe(true);
    expect(
      messagingWebhookBodyTooLarge("a".repeat(MESSAGING_WEBHOOK_BODY_MAX_BYTES))
    ).toBe(false);
  });
});
