import { describe, expect, it } from "vitest";
import {
  ACQUISITION_VALUE_MAX_LENGTH,
  acquisitionFromSearchParams,
  acquisitionWithFunnelVisitorId,
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

  it("keeps a valid anonymous funnel id and normalizes its casing", () => {
    expect(
      acquisitionFromSearchParams(
        new URLSearchParams(
          "funnel_id=123E4567-E89B-42D3-A456-426614174000"
        )
      )
    ).toEqual({
      source: undefined,
      medium: undefined,
      campaign: undefined,
      funnelId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("drops a malformed funnel id", () => {
    expect(
      acquisitionFromSearchParams(new URLSearchParams("funnel_id=not-a-uuid"))
    ).toBeUndefined();
  });

  it("drops unsafe or oversized values and returns undefined when empty", () => {
    const params = new URLSearchParams({
      source: "<script>",
      utm_campaign: "x".repeat(ACQUISITION_VALUE_MAX_LENGTH + 1),
    });
    expect(acquisitionFromSearchParams(params)).toBeUndefined();
  });

  it("uses a first-party visitor id when the registration URL has none", () => {
    expect(
      acquisitionWithFunnelVisitorId(
        undefined,
        "123E4567-E89B-42D3-A456-426614174000"
      )
    ).toEqual({
      funnelId: "123e4567-e89b-42d3-a456-426614174000",
    });

    expect(
      acquisitionWithFunnelVisitorId(
        { source: "direct", campaign: "register" },
        "123E4567-E89B-42D3-A456-426614174000"
      )
    ).toEqual({
      source: "direct",
      campaign: "register",
      funnelId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("preserves explicit cross-domain attribution over a local fallback", () => {
    expect(
      acquisitionWithFunnelVisitorId(
        {
          source: "marketing",
          funnelId: "123e4567-e89b-42d3-a456-426614174000",
        },
        "223e4567-e89b-42d3-a456-426614174000"
      )
    ).toEqual({
      source: "marketing",
      funnelId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("does not persist malformed fallback identities", () => {
    expect(
      acquisitionWithFunnelVisitorId({ source: "direct" }, "not-a-uuid")
    ).toEqual({ source: "direct" });
    expect(acquisitionWithFunnelVisitorId(undefined, null)).toBeUndefined();
  });
});
