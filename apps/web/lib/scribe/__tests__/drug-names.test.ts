import { describe, expect, it } from "vitest";
import { COMMON_VETERINARY_DRUG_NAMES, withCommonDrugNames } from "../drug-names";
import { buildScribePrompt, SCRIBE_SYSTEM_PROMPT } from "../draft";

describe("common veterinary drug names", () => {
  it("covers the names new clinics misheard in testing", () => {
    for (const name of ["maropitant", "Cerenia", "Otomax", "Simparica Trio"]) {
      expect(COMMON_VETERINARY_DRUG_NAMES).toContain(name);
    }
  });

  it("has no duplicates and nothing a speech hint cannot use", () => {
    const keys = COMMON_VETERINARY_DRUG_NAMES.map((name) => name.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of COMMON_VETERINARY_DRUG_NAMES) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9 '+-]*$/);
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });

  it("puts the clinic's own names first and fills the rest within the limit", () => {
    const names = withCommonDrugNames(["Otomax", "House Ear Wash"], {
      maxTerms: 10,
      maxCharacters: 120,
    });
    expect(names.slice(0, 3)).toEqual(["Otomax", "House Ear Wash", "maropitant"]);
    // Otomax is not repeated from the common list.
    expect(names.filter((name) => name.toLowerCase() === "otomax")).toHaveLength(1);
    expect(names.join(", ").length).toBeLessThanOrEqual(120);
  });
});

describe("note drafting with drug names", () => {
  it("gives the reference list and asks for [confirm] on a misheard name", () => {
    const prompt = buildScribePrompt({
      transcript: "I'll give myropetin for the nausea.",
      vocabulary: ["Hospital Ear Flush"],
    });
    expect(prompt).toContain(
      "Reference list of drug and product names, for spelling only:\nHospital Ear Flush, maropitant,",
    );
    // The list sits before the transcript, never inside it.
    expect(prompt.indexOf("Reference list")).toBeLessThan(prompt.indexOf("Transcript:"));
    expect(SCRIBE_SYSTEM_PROMPT).toContain('"maropitant [confirm]"');
    expect(SCRIBE_SYSTEM_PROMPT).toContain("never add a drug that was not said");
  });
});
