import { describe, expect, it } from "vitest";
import {
  PATIENT_SEARCH_MAX_TOKENS,
  escapePatientSearchToken,
  hasBoundedPatientSearchTokens,
  normalizePatientSearchPhrase,
  patientSearchContainsPattern,
  patientSearchTokens,
} from "@/lib/patients/search";

describe("patient and owner search normalization", () => {
  it("normalizes whitespace and case while preserving token order", () => {
    expect(normalizePatientSearchPhrase("  LuCy\t  GRAY  ")).toBe("lucy gray");
    expect(patientSearchTokens("  LuCy\t  GRAY  ")).toEqual(["lucy", "gray"]);
    expect(patientSearchTokens("gray lucy")).toEqual(["gray", "lucy"]);
  });

  it("deduplicates tokens without broadening an empty search", () => {
    expect(patientSearchTokens("lucy LUCY gray lucy")).toEqual([
      "lucy",
      "gray",
    ]);
    expect(patientSearchTokens("   ")).toEqual([]);
  });

  it("escapes LIKE syntax so wildcard characters stay literal", () => {
    expect(escapePatientSearchToken(String.raw`50%_off\today`)).toBe(
      String.raw`50\%\_off\\today`,
    );
    expect(patientSearchContainsPattern("50%_off")).toBe(
      String.raw`%50\%\_off%`,
    );
  });

  it("bounds unique query complexity", () => {
    const allowed = Array.from(
      { length: PATIENT_SEARCH_MAX_TOKENS },
      (_, index) => `token${index}`,
    ).join(" ");
    expect(hasBoundedPatientSearchTokens(allowed)).toBe(true);
    expect(hasBoundedPatientSearchTokens(`${allowed} overflow`)).toBe(false);
    expect(hasBoundedPatientSearchTokens("same ".repeat(50))).toBe(true);
  });
});
