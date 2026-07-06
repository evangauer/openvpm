import { describe, expect, it } from "vitest";
import {
  JSON_REQUEST_BODY_MAX_BYTES,
  jsonRequestContentLengthTooLarge,
  readJsonRequestBody,
  readRequestTextWithLimit,
} from "../request-json";

function jsonRequest(body: string, headers: HeadersInit = {}) {
  return new Request("https://openvpm.test/api/example", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("capped JSON request reader", () => {
  it("rejects oversized content-length headers", () => {
    expect(
      jsonRequestContentLengthTooLarge(
        new Headers({
          "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1),
        })
      )
    ).toBe(true);
    expect(
      jsonRequestContentLengthTooLarge(
        new Headers({
          "content-length": String(JSON_REQUEST_BODY_MAX_BYTES),
        })
      )
    ).toBe(false);
  });

  it("rejects streamed bodies that exceed the byte cap", async () => {
    await expect(
      readJsonRequestBody(
        jsonRequest(`"${"x".repeat(JSON_REQUEST_BODY_MAX_BYTES)}"`)
      )
    ).resolves.toEqual({ ok: false, reason: "too_large" });
  });

  it("reads raw text up to the byte cap", async () => {
    await expect(
      readRequestTextWithLimit(
        new Request("https://openvpm.test/api/example", {
          method: "POST",
          body: "plain webhook body",
        }),
        32
      )
    ).resolves.toEqual({ ok: true, text: "plain webhook body" });
  });

  it("rejects oversized raw text while reading the stream", async () => {
    await expect(
      readRequestTextWithLimit(
        new Request("https://openvpm.test/api/example", {
          method: "POST",
          body: "abcdef",
        }),
        5
      )
    ).resolves.toEqual({ ok: false });
  });

  it("parses valid JSON and reports invalid JSON", async () => {
    await expect(
      readJsonRequestBody(jsonRequest('{"ok":true}'))
    ).resolves.toEqual({
      ok: true,
      data: { ok: true },
    });

    await expect(readJsonRequestBody(jsonRequest("{nope"))).resolves.toEqual({
      ok: false,
      reason: "invalid_json",
    });
  });
});
