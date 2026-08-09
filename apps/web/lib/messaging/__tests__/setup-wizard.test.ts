import { describe, expect, it } from "vitest";
import {
  defaultMessagingSetupMode,
  setupModeTitle,
} from "../setup-wizard";

describe("messaging setup wizard helpers", () => {
  it("fails closed to a new number even when a clinic phone is present", () => {
    expect(defaultMessagingSetupMode("+1 555 555 0100")).toBe("buy");
    expect(defaultMessagingSetupMode("  (555) 555-0100  ")).toBe("buy");
  });

  it("falls back to buying a new number when no phone is on file", () => {
    expect(defaultMessagingSetupMode(null)).toBe("buy");
    expect(defaultMessagingSetupMode(undefined)).toBe("buy");
    expect(defaultMessagingSetupMode("   ")).toBe("buy");
  });

  it("labels setup modes for the wizard confirmation step", () => {
    expect(setupModeTitle("host")).toBe(
      "Existing-number texting is not available"
    );
    expect(setupModeTitle("buy")).toBe("Get a new local number");
  });
});
