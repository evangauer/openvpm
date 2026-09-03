import { describe, expect, it } from "vitest";
import { mergeAttributes } from "@tiptap/core";

describe("Tiptap attribute merging", () => {
  it("keeps JSON __proto__ input from becoming inherited DOM attributes", () => {
    const input = JSON.parse(
      '{"__proto__":{"src":"invalid://security-test","onerror":"securityTest()"}}'
    ) as Record<string, unknown>;

    const merged = mergeAttributes(input);
    const enumeratedKeys: string[] = [];

    for (const key in merged) {
      enumeratedKeys.push(key);
    }

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect(merged.src).toBeUndefined();
    expect(merged.onerror).toBeUndefined();
    expect(enumeratedKeys).toEqual(["__proto__"]);
  });
});
