import { afterEach, describe, expect, it, vi } from "vitest";

const VISITOR_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_VISITOR_ID = "223e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("funnel visitor identity", () => {
  it("reuses one volatile UUID when privacy settings block local storage", async () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(VISITOR_ID)
      .mockReturnValueOnce(SECOND_VISITOR_ID);
    vi.stubGlobal("crypto", { randomUUID });
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("blocked");
        }),
        setItem: vi.fn(() => {
          throw new Error("blocked");
        }),
      },
    });

    const { getFunnelVisitorId } = await import("../funnel-visitor");

    expect(getFunnelVisitorId()).toBe(VISITOR_ID);
    expect(getFunnelVisitorId()).toBe(VISITOR_ID);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("lets a valid URL identity override a stale local value", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      location: { search: `?funnel_id=${VISITOR_ID}` },
      localStorage: {
        getItem: vi.fn(() => SECOND_VISITOR_ID),
        setItem,
      },
    });

    const { getFunnelVisitorId } = await import("../funnel-visitor");

    expect(getFunnelVisitorId()).toBe(VISITOR_ID);
    expect(setItem).toHaveBeenCalledWith("openvpm_funnel_id", VISITOR_ID);
  });
});
