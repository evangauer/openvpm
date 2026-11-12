import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserUuid } from "../browser-uuid";

afterEach(() => vi.unstubAllGlobals());

describe("browserUuid", () => {
  it("uses native UUID generation when available", () => {
    const randomUUID = vi.fn(() => "native-uuid");
    vi.stubGlobal("crypto", { randomUUID });
    expect(browserUuid()).toBe("native-uuid");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates distinct RFC 4122 v4 IDs without randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    });
    const ids = Array.from({ length: 100 }, () => browserUuid());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("fails instead of generating weak IDs when secure randomness is absent", () => {
    vi.stubGlobal("crypto", {});
    expect(() => browserUuid()).toThrow();
  });
});
