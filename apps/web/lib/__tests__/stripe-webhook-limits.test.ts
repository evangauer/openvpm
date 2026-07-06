import { describe, expect, it } from "vitest";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookBodyTooLarge,
  stripeWebhookContentLengthTooLarge,
} from "../stripe-webhook-limits";

describe("Stripe webhook payload limits", () => {
  it("rejects oversized content-length headers", () => {
    expect(
      stripeWebhookContentLengthTooLarge(
        new Headers({
          "content-length": String(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1),
        })
      )
    ).toBe(true);
    expect(
      stripeWebhookContentLengthTooLarge(
        new Headers({ "content-length": String(STRIPE_WEBHOOK_BODY_MAX_BYTES) })
      )
    ).toBe(false);
  });

  it("rejects oversized raw bodies", () => {
    expect(stripeWebhookBodyTooLarge("a".repeat(STRIPE_WEBHOOK_BODY_MAX_BYTES + 1))).toBe(
      true
    );
    expect(stripeWebhookBodyTooLarge("a".repeat(STRIPE_WEBHOOK_BODY_MAX_BYTES))).toBe(
      false
    );
  });
});
