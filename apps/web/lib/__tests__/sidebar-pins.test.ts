import { describe, expect, it } from "vitest";
import {
  availableNavigation,
  CORE_PATHS,
  isNavigationActive,
} from "../navigation";
import {
  parseSidebarPins,
  serializeSidebarPins,
  sidebarPinsKey,
} from "../sidebar-pins";

describe("personal sidebar tools", () => {
  it("keeps the core workflow small and field visits optional", () => {
    expect(CORE_PATHS).toEqual([
      "/",
      "/schedule",
      "/patients",
      "/clients",
      "/billing",
      "/inbox",
    ]);
    expect(
      availableNavigation("admin", false).some(
        (item) => item.href === "/offline/field.html",
      ),
    ).toBe(false);
    expect(
      availableNavigation("admin", true).some(
        (item) => item.href === "/offline/field.html",
      ),
    ).toBe(true);
    expect(
      availableNavigation("viewer", true).map((item) => item.href),
    ).not.toContain("/offline/field.html");
    expect(
      availableNavigation("viewer", true).map((item) => item.href),
    ).not.toContain("/controlled-substances");
    expect(
      availableNavigation("front_desk", true).map((item) => item.href),
    ).not.toContain("/reports");
    expect(availableNavigation(undefined, true)).toEqual([]);
  });

  it("isolates identities and accepts only known optional tool paths", () => {
    expect(sidebarPinsKey("clinic-a", "user-a")).not.toBe(
      sidebarPinsKey("clinic-b", "user-a"),
    );
    expect(sidebarPinsKey("clinic-a", "user-a")).not.toBe(
      sidebarPinsKey("clinic-a", "user-b"),
    );
    expect(
      parseSidebarPins(
        JSON.stringify({
          version: 1,
          pinned: [
            "/reports",
            "/",
            "/settings",
            "/reports",
            "https://example.invalid",
            3,
            "/inventory",
          ],
        }),
      ),
    ).toEqual(["/reports", "/inventory"]);
    expect(
      parseSidebarPins(
        serializeSidebarPins(["/inventory", "/offline/field.html"]),
      ),
    ).toEqual(["/inventory", "/offline/field.html"]);
  });

  it.each([
    null,
    "invalid",
    "{}",
    '{"version":2,"pinned":["/reports"]}',
    '{"version":1,"pinned":null}',
    "x".repeat(4097),
  ])("recovers from missing or invalid preferences", (value) => {
    expect(parseSidebarPins(value)).toEqual([]);
  });

  it("identifies nested tools without matching unrelated route prefixes", () => {
    expect(isNavigationActive("/lab-results", "/lab-reports/123")).toBe(true);
    expect(isNavigationActive("/records", "/records/new-soap/123")).toBe(true);
    expect(isNavigationActive("/records", "/records-other")).toBe(false);
    expect(isNavigationActive("/", "/patients")).toBe(false);
  });
});
