import { describe, expect, it } from "vitest";
import { publicTelnyxWebhookUrl } from "../public-webhook";

describe("publicTelnyxWebhookUrl", () => {
  it("returns the canonical callback for a public HTTPS origin", () => {
    expect(publicTelnyxWebhookUrl("https://app.example.com/some/path")).toBe(
      "https://app.example.com/api/webhooks/telnyx",
    );
  });

  it.each([
    "http://app.example.com",
    "https://localhost:3000",
    "https://127.0.0.1",
    "https://0.0.0.0",
    "https://[::1]",
    "https://clinic.local",
  ])("rejects non-public callback origin %s", (origin) => {
    expect(publicTelnyxWebhookUrl(origin)).toBeNull();
  });

  it("rejects invalid, credentialed, and missing origins", () => {
    expect(publicTelnyxWebhookUrl(undefined)).toBeNull();
    expect(publicTelnyxWebhookUrl("not a url")).toBeNull();
    expect(
      publicTelnyxWebhookUrl("https://user:password@app.example.com"),
    ).toBeNull();
  });
});
