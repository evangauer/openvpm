import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./provider-display-name";

describe("providerDisplayName", () => {
  it("adds a Dr. prefix to bare names", () => {
    expect(providerDisplayName("Sarah Chen")).toBe("Dr. Sarah Chen");
  });

  it("does not double an existing prefix", () => {
    expect(providerDisplayName("Dr. Sarah Chen")).toBe("Dr. Sarah Chen");
    expect(providerDisplayName("Dr Sarah Chen")).toBe("Dr Sarah Chen");
    expect(providerDisplayName("dr. sarah chen")).toBe("dr. sarah chen");
    expect(providerDisplayName("Doctor Sarah Chen")).toBe("Doctor Sarah Chen");
  });

  it("trims surrounding whitespace", () => {
    expect(providerDisplayName("  Dr. Sarah Chen ")).toBe("Dr. Sarah Chen");
    expect(providerDisplayName("  Sarah Chen ")).toBe("Dr. Sarah Chen");
  });

  it("only treats a whole-word title as a prefix", () => {
    expect(providerDisplayName("Drew Patel")).toBe("Dr. Drew Patel");
    expect(providerDisplayName("Doctorow Lee")).toBe("Dr. Doctorow Lee");
  });

  it("recognizes a title with no space after the period", () => {
    expect(providerDisplayName("Dr.Sarah Chen")).toBe("Dr.Sarah Chen");
  });

  it("returns the fallback for missing names", () => {
    expect(providerDisplayName(null)).toBe("Unassigned provider");
    expect(providerDisplayName(undefined)).toBe("Unassigned provider");
    expect(providerDisplayName("   ")).toBe("Unassigned provider");
    expect(providerDisplayName(null, "Team")).toBe("Team");
  });
});
