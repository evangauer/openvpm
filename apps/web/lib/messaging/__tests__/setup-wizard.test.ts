import { describe, expect, it } from "vitest";
import {
  defaultMessagingSetupMode,
  setupModeTitle,
} from "../setup-wizard";

describe("messaging setup wizard helpers", () => {
  it("prefers hosting an existing location number when one is present", () => {
    expect(defaultMessagingSetupMode("+1 555 555 0100")).toBe("host");
    expect(defaultMessagingSetupMode("  (555) 555-0100  ")).toBe("host");
  });

  it("falls back to buying a new number when no phone is on file", () => {
    expect(defaultMessagingSetupMode(null)).toBe("buy");
    expect(defaultMessagingSetupMode(undefined)).toBe("buy");
    expect(defaultMessagingSetupMode("   ")).toBe("buy");
  });

  it("labels setup modes for the wizard confirmation step", () => {
    expect(setupModeTitle("host")).toBe("Text-enable your existing number");
    expect(setupModeTitle("buy")).toBe("Get a new local number");
  });
});
