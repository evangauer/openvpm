import { describe, expect, it } from "vitest";
import {
  twilioDeliveryClassification,
  twilioProviderStatus,
} from "../twilio-events";

describe("Twilio delivery event normalization", () => {
  it.each([
    ["queued", "sent"],
    ["sending", "sent"],
    ["sent", "sent"],
    ["delivered", "delivered"],
    ["read", "delivered"],
    ["failed", "failed"],
    ["undelivered", "failed"],
    ["canceled", "failed"],
    ["new-provider-state", "unknown"],
  ] as const)(
    "maps %s to %s while retaining the provider token",
    (raw, expected) => {
      expect(twilioProviderStatus(raw)).toBe(raw.replaceAll("-", "_"));
      expect(twilioDeliveryClassification(raw)).toBe(expected);
    },
  );
});
