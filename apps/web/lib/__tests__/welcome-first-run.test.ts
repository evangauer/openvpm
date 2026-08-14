import { describe, expect, it } from "vitest";
import { suppressWelcomeForBilling } from "../welcome/first-run";

describe("first-run welcome routing", () => {
  it("does not interrupt a direct billing activation journey", () => {
    expect(
      suppressWelcomeForBilling(
        "/settings",
        new URLSearchParams("tab=billing"),
      ),
    ).toBe(true);
  });

  it("still allows the welcome everywhere else", () => {
    expect(
      suppressWelcomeForBilling("/settings", new URLSearchParams("tab=data")),
    ).toBe(false);
    expect(
      suppressWelcomeForBilling("/", new URLSearchParams("tab=billing")),
    ).toBe(false);
  });
});
