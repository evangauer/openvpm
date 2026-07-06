import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_URL_MAX_LENGTH,
  isWebhookDeliveryUrl,
} from "../webhook-urls";

describe("webhook URL validation", () => {
  it("allows HTTP and HTTPS delivery URLs", () => {
    expect(isWebhookDeliveryUrl("https://example.com/openvpm")).toBe(true);
    expect(isWebhookDeliveryUrl("http://localhost:3001/webhook")).toBe(true);
  });

  it("rejects non-deliverable schemes and oversized URLs", () => {
    expect(isWebhookDeliveryUrl("ftp://example.com/openvpm")).toBe(false);
    expect(isWebhookDeliveryUrl("mailto:ops@example.com")).toBe(false);
    expect(
      isWebhookDeliveryUrl(
        `https://example.com/${"a".repeat(WEBHOOK_URL_MAX_LENGTH)}`
      )
    ).toBe(false);
  });

  it("guards dispatcher delivery URLs before fetch", () => {
    const source = readFileSync("lib/webhook-dispatcher.ts", "utf8");

    expect(source).toContain("isWebhookDeliveryUrl(wh.url)");
    expect(source.indexOf("isWebhookDeliveryUrl(wh.url)")).toBeLessThan(
      source.indexOf("fetch(wh.url")
    );
  });
});
