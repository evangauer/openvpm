import { describe, expect, it } from "vitest";
import {
  hasSoapContent,
  normalizeSoapSection,
  soapSectionText,
} from "../soap-content";

describe("SOAP content helpers", () => {
  it("treats empty rich-text markup as empty clinical content", () => {
    expect(soapSectionText("<p><br></p>")).toBe("");
    expect(soapSectionText("<ul><li>&nbsp;</li></ul>")).toBe("");
    expect(normalizeSoapSection("<p> &nbsp; </p>")).toBeUndefined();
  });

  it("detects meaningful text inside rich-text markup and entities", () => {
    expect(soapSectionText("<p>Eating &amp; drinking normally</p>")).toBe(
      "Eating & drinking normally"
    );
    expect(
      hasSoapContent({
        subjective: "<p><br></p>",
        objective: "<p>Temp 101.2F</p>",
      })
    ).toBe(true);
  });
});
