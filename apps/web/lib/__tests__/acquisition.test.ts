import { describe, expect, it } from "vitest";
import {
  ACQUISITION_VALUE_MAX_LENGTH,
  acquisitionFromSearchParams,
} from "@/lib/acquisition";

describe("signup acquisition", () => {
  it("prefers an explicit placement source and keeps campaign context", () => {
    const params = new URLSearchParams(
      "source=homepage_hero&utm_source=google&utm_medium=cpc&utm_campaign=vet_tools"
    );
    expect(acquisitionFromSearchParams(params)).toEqual({
      source: "homepage_hero",
      medium: "cpc",
      campaign: "vet_tools",
    });
  });

  it("falls back to utm_source", () => {
    expect(
      acquisitionFromSearchParams(new URLSearchParams("utm_source=google"))
    ).toEqual({ source: "google", medium: undefined, campaign: undefined });
  });

  it("drops unsafe or oversized values and returns undefined when empty", () => {
    const params = new URLSearchParams({
      source: "<script>",
      utm_campaign: "x".repeat(ACQUISITION_VALUE_MAX_LENGTH + 1),
    });
    expect(acquisitionFromSearchParams(params)).toBeUndefined();
  });
});
