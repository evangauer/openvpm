import { describe, expect, it } from "vitest";
import { safeAuthNextPath } from "../auth-redirect";

describe("safeAuthNextPath", () => {
  it("preserves an internal billing destination", () => {
    expect(
      safeAuthNextPath("/settings?tab=billing", "/post-login"),
    ).toBe("/settings?tab=billing");
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/login?next=/settings",
    "/register",
    "/verify-email?token=secret",
  ])("rejects unsafe or looping destination %s", (value) => {
    expect(safeAuthNextPath(value, "/post-login")).toBe("/post-login");
  });
});
