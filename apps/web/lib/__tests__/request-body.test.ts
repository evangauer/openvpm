import { describe, expect, it } from "vitest";
import {
  readRequestBytesWithLimit,
  readRequestTextWithLimit,
} from "../request-body";

function postRequest(body?: BodyInit) {
  return new Request("https://openvpm.test/api/example", {
    method: "POST",
    body,
  });
}

describe("capped request body reader", () => {
  it("returns exact bytes up to the byte cap", async () => {
    const result = await readRequestBytesWithLimit(postRequest("abc"), 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual([97, 98, 99]);
    }
  });

  it("returns an empty byte array when there is no request body", async () => {
    const result = await readRequestBytesWithLimit(postRequest(), 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.byteLength).toBe(0);
    }
  });

  it("rejects byte streams that exceed the cap", async () => {
    await expect(readRequestBytesWithLimit(postRequest("abcd"), 3)).resolves.toEqual({
      ok: false,
    });
  });

  it("decodes capped text from the shared byte reader", async () => {
    await expect(readRequestTextWithLimit(postRequest("plain text"), 10)).resolves.toEqual({
      ok: true,
      text: "plain text",
    });
  });
});
