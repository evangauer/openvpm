import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("bounded collection validation", () => {
  it("rejects an oversized collection before parsing its elements", () => {
    // Regression for GHSA-mrhx-c7xc-m3w5: size limits must bound validation
    // work, not merely reject after traversing an attacker-controlled array.
    const parseElement = vi.fn((value: string) => value.trim());
    const schema = z.array(z.string().transform(parseElement)).max(2);
    const oversized = schema.safeParse(["one", "two", "three"]);
    expect(oversized.success).toBe(false);
    expect(parseElement).not.toHaveBeenCalled();
    expect(schema.parse([" one ", " two "])).toEqual(["one", "two"]);
    expect(parseElement).toHaveBeenCalledTimes(2);
  });
});
