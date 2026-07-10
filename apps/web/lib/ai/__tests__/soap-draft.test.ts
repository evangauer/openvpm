import { describe, expect, it } from "vitest";
import { SOAP_SECTION_MAX_LENGTH } from "@/lib/records/soap-content";
import { buildSoapDraftPrompt, parseSoapDraft } from "../soap-draft";

const CONTEXT = {
  patient: {
    name: "Biscuit",
    species: "canine",
    breed: "Beagle",
    sex: "male_neutered",
    dob: "2020-04-01",
  },
  allergies: [{ allergen: "Penicillin", severity: "severe" }],
  activeProblems: [{ description: "Chronic otitis", status: "active" }],
  latestVitals: {
    temperatureC: "38.5",
    heartRateBpm: 90,
    respiratoryRateBpm: 24,
    weightKg: "12.400",
  },
  visitContext: "Annual wellness exam",
};

describe("buildSoapDraftPrompt", () => {
  it("grounds the prompt in the chart context", () => {
    const prompt = buildSoapDraftPrompt(CONTEXT);
    expect(prompt).toContain("Name: Biscuit");
    expect(prompt).toContain("Species: canine");
    expect(prompt).toContain("- Penicillin (severe)");
    expect(prompt).toContain("- Chronic otitis [active]");
    expect(prompt).toContain("Temperature (C): 38.5");
    expect(prompt).toContain("Annual wellness exam");
  });

  it("omits empty sections instead of inventing placeholders", () => {
    const prompt = buildSoapDraftPrompt({
      patient: {
        name: "Biscuit",
        species: null,
        breed: null,
        sex: null,
        dob: null,
      },
      allergies: [],
      activeProblems: [],
      latestVitals: null,
    });
    expect(prompt).toContain("Name: Biscuit");
    expect(prompt).not.toContain("Known allergies");
    expect(prompt).not.toContain("Problem list");
    expect(prompt).not.toContain("Most recent vitals");
    expect(prompt).not.toContain("Visit context");
  });
});

describe("parseSoapDraft", () => {
  it("parses a plain JSON draft", () => {
    const draft = parseSoapDraft(
      JSON.stringify({
        subjective: "Owner reports itchy ears.",
        objective: "Ears erythematous.",
        assessment: "Otitis externa suspected.",
        plan: "Cytology and topical treatment.",
      })
    );
    expect(draft).toEqual({
      subjective: "Owner reports itchy ears.",
      objective: "Ears erythematous.",
      assessment: "Otitis externa suspected.",
      plan: "Cytology and topical treatment.",
    });
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const draft = parseSoapDraft(
      'Here you go:\n```json\n{"subjective":"S","objective":"O","assessment":"A","plan":"P"}\n```\nLet me know.'
    );
    expect(draft).toEqual({
      subjective: "S",
      objective: "O",
      assessment: "A",
      plan: "P",
    });
  });

  it("fills missing or non-string sections with empty strings", () => {
    const draft = parseSoapDraft('{"subjective":"S","plan":42}');
    expect(draft).toEqual({
      subjective: "S",
      objective: "",
      assessment: "",
      plan: "",
    });
  });

  it("caps sections at the SOAP column limit", () => {
    const long = "A".repeat(SOAP_SECTION_MAX_LENGTH + 100);
    const draft = parseSoapDraft(JSON.stringify({ subjective: long }));
    expect(draft?.subjective).toHaveLength(SOAP_SECTION_MAX_LENGTH);
  });

  it("returns null for unusable responses", () => {
    expect(parseSoapDraft("")).toBeNull();
    expect(parseSoapDraft("no json here")).toBeNull();
    expect(parseSoapDraft("{broken json")).toBeNull();
    expect(parseSoapDraft("[1,2,3]")).toBeNull();
    // A well-formed object with no content is also unusable.
    expect(parseSoapDraft("{}")).toBeNull();
    expect(
      parseSoapDraft('{"subjective":"","objective":"  "}')
    ).toBeNull();
  });
});
