import { describe, expect, it } from "vitest";
import {
  buildScribeVocabulary,
  SCRIBE_VOCABULARY_MAX_CHARACTERS,
  SCRIBE_VOCABULARY_MAX_TERMS,
  spokenProductName,
} from "../vocabulary";
import {
  buildSpeechServerPrompt,
  buildTranscriptionPrompt,
} from "../transcribe";

describe("clinic spelling hints", () => {
  it("keeps the spoken part of a product name", () => {
    expect(spokenProductName("Simparica Trio (22.1-44 lbs, 6ct)")).toBe(
      "Simparica Trio",
    );
    expect(
      spokenProductName("Metacam 1.5mg/mL oral suspension — per mL"),
    ).toBe("Metacam");
    expect(spokenProductName("Heartgard Plus (26-50 lbs, 6ct)")).toBe(
      "Heartgard Plus",
    );
    expect(spokenProductName("Otomax")).toBe("Otomax");
    expect(spokenProductName("Hill's i/d")).toBe("Hill's");
    expect(spokenProductName("10mL syringe")).toBeNull();
    expect(spokenProductName("(misc)")).toBeNull();
  });

  it("drops duplicates and stays inside its size limits", () => {
    expect(
      buildScribeVocabulary([
        "Apoquel 16mg tablet",
        "Apoquel 5.4mg tablet",
        "apoquel 3.6mg",
        "Cerenia 24mg tablet",
      ]),
    ).toEqual(["Apoquel", "Cerenia"]);

    const many = Array.from({ length: 200 }, (_, i) => `Product${i} 5mg`);
    const terms = buildScribeVocabulary(many);
    expect(terms.length).toBeLessThanOrEqual(SCRIBE_VOCABULARY_MAX_TERMS);
    expect(terms.join(", ").length).toBeLessThanOrEqual(
      SCRIBE_VOCABULARY_MAX_CHARACTERS,
    );
  });

  it("passes the names to both kinds of speech-to-text, transcript last", () => {
    const input = {
      patientName: "Daisy",
      species: "canine",
      vocabulary: ["Simparica Trio", "Otomax"],
      previousTail: "She gets a chewable once a month.",
    };
    const server = buildSpeechServerPrompt(input);
    expect(server).toContain("Simparica Trio, Otomax.");
    expect(server.endsWith("She gets a chewable once a month.")).toBe(true);

    const model = buildTranscriptionPrompt(input);
    expect(model).toContain(
      "Product and drug names used at this clinic, for spelling only:\nSimparica Trio, Otomax\n",
    );
    expect(buildTranscriptionPrompt({ vocabulary: [] })).not.toContain(
      "Product and drug names",
    );
  });
});
