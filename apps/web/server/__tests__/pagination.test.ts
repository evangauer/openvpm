import { describe, expect, it } from "vitest";
import { LIST_OFFSET_MAX, listOffsetInput } from "../routers/pagination";

describe("dashboard list pagination input", () => {
  it("accepts normal offsets and rejects oversized offsets", () => {
    expect(listOffsetInput.safeParse(0).success).toBe(true);
    expect(listOffsetInput.safeParse(LIST_OFFSET_MAX).success).toBe(true);
    expect(listOffsetInput.safeParse(LIST_OFFSET_MAX + 1).success).toBe(false);
  });
});
