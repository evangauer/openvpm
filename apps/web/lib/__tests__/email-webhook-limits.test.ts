import { describe, expect, it } from "vitest";
import {
  EMAIL_WEBHOOK_BODY_MAX_BYTES,
  emailWebhookBodyTooLarge,
  emailWebhookContentLengthTooLarge,
} from "../email-webhook-limits";

describe("email webhook payload limits", () => {
  it("rejects oversized content-length headers", () => {
    expect(
      emailWebhookContentLengthTooLarge(
        new Headers({
          "content-length": String(EMAIL_WEBHOOK_BODY_MAX_BYTES + 1),
        })
      )
    ).toBe(true);
    expect(
      emailWebhookContentLengthTooLarge(
        new Headers({ "content-length": String(EMAIL_WEBHOOK_BODY_MAX_BYTES) })
      )
    ).toBe(false);
  });

  it("rejects oversized raw bodies", () => {
    expect(
      emailWebhookBodyTooLarge("a".repeat(EMAIL_WEBHOOK_BODY_MAX_BYTES + 1))
    ).toBe(true);
    expect(
      emailWebhookBodyTooLarge("a".repeat(EMAIL_WEBHOOK_BODY_MAX_BYTES))
    ).toBe(false);
  });
});
