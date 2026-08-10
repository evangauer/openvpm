import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  return {
    verifyEmailPreferenceToken: vi.fn(),
    emailPreferenceBaseUrl: vi.fn(() => "https://app.openvpm.com"),
    setMarketingEmailPreferenceForHash: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/email-preferences", () => ({
  verifyEmailPreferenceToken: mocks.verifyEmailPreferenceToken,
  emailPreferenceBaseUrl: mocks.emailPreferenceBaseUrl,
}));
vi.mock("@/lib/platform-email-preferences", () => ({
  setMarketingEmailPreferenceForHash: mocks.setMarketingEmailPreferenceForHash,
}));

const { POST } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST email preference unsubscribe", () => {
  function oneClickRequest(url: string, body = "List-Unsubscribe=One-Click") {
    return new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("never mutates preference state from a GET handler", () => {
    expect(ROUTE_SOURCE).not.toMatch(/export\s+(?:async\s+)?function\s+GET/);
  });

  it("rejects missing, oversized, and invalid signed tokens", async () => {
    mocks.verifyEmailPreferenceToken.mockReturnValue(null);

    for (const url of [
      "https://app.openvpm.com/api/email-preferences/unsubscribe",
      "https://app.openvpm.com/api/email-preferences/unsubscribe?token=bad",
      `https://app.openvpm.com/api/email-preferences/unsubscribe?token=${"x".repeat(4097)}`,
    ]) {
      const response = await POST(oneClickRequest(url));
      expect(response.status).toBe(400);
    }
    expect(mocks.setMarketingEmailPreferenceForHash).not.toHaveBeenCalled();
  });

  it("requires the RFC 8058 one-click content type and form body", async () => {
    mocks.verifyEmailPreferenceToken.mockReturnValue({
      target: { kind: "recipient", id: "b".repeat(64) },
    });

    const requests = [
      new Request(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
        { method: "POST" },
      ),
      new Request(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "List-Unsubscribe": "One-Click" }),
        },
      ),
      oneClickRequest(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
        "List-Unsubscribe=not-one-click",
      ),
    ];

    for (const request of requests) {
      expect((await POST(request)).status).toBe(400);
    }
    expect(mocks.setMarketingEmailPreferenceForHash).not.toHaveBeenCalled();
  });

  it("atomically opts a recipient out without reading or storing PII", async () => {
    mocks.verifyEmailPreferenceToken.mockReturnValue({
      target: { kind: "recipient", id: "b".repeat(64) },
    });

    const response = await POST(
      new Request(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.setMarketingEmailPreferenceForHash).toHaveBeenCalledWith({
      emailHash: "b".repeat(64),
      enabled: false,
      source: "unsubscribe_link",
    });
  });

  it("rejects noncanonical deployment hosts before touching preference state", async () => {
    mocks.verifyEmailPreferenceToken.mockReturnValue({
      target: { kind: "recipient", id: "a".repeat(64) },
    });

    const response = await POST(
      oneClickRequest(
        "https://demo.openvpm.com/api/email-preferences/unsubscribe?token=signed",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyEmailPreferenceToken).not.toHaveBeenCalled();
    expect(mocks.setMarketingEmailPreferenceForHash).not.toHaveBeenCalled();
  });

  it("fails closed without an unhandled error when canonical config is unavailable", async () => {
    mocks.emailPreferenceBaseUrl.mockImplementationOnce(() => {
      throw new Error("invalid app URL");
    });

    const response = await POST(
      oneClickRequest(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyEmailPreferenceToken).not.toHaveBeenCalled();
    expect(mocks.setMarketingEmailPreferenceForHash).not.toHaveBeenCalled();
  });

  it("fails closed when the preference cannot be persisted", async () => {
    mocks.verifyEmailPreferenceToken.mockReturnValue({
      target: { kind: "recipient", id: "b".repeat(64) },
    });
    mocks.setMarketingEmailPreferenceForHash.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const response = await POST(
      oneClickRequest(
        "https://app.openvpm.com/api/email-preferences/unsubscribe?token=signed",
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
