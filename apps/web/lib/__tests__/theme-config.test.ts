import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app theme configuration", () => {
  it("disables system dark mode until dark mode is fully supported", () => {
    const source = readFileSync("lib/providers.tsx", "utf8");

    expect(source).toContain('export const ACTIVE_THEME = "light"');
    expect(source).toContain("forcedTheme={ACTIVE_THEME}");
    expect(source).toContain("enableSystem={false}");
    expect(source).not.toContain("enableSystem>");
  });
});
