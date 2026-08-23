import { describe, expect, it } from "vitest";
import {
  clientSearchContainsPattern,
  escapeClientSearchValue,
} from "@/lib/clients/search";

describe("client search normalization", () => {
  it("escapes LIKE syntax so wildcard characters stay literal", () => {
    expect(escapeClientSearchValue(String.raw`50%_off\today`)).toBe(
      String.raw`50\%\_off\\today`,
    );
    expect(clientSearchContainsPattern("50%_off")).toBe(
      String.raw`%50\%\_off%`,
    );
  });

  it("preserves normal clinic search input", () => {
    expect(clientSearchContainsPattern("Linda Hoffman")).toBe(
      "%Linda Hoffman%",
    );
    expect(clientSearchContainsPattern("555-0100")).toBe("%555-0100%");
  });
});
