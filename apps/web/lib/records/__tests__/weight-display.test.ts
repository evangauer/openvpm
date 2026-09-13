import { describe, expect, it } from "vitest";
import {
  correctedWeightKilograms,
  weightDisplayInput,
} from "../weight-display";

describe("weight correction display units", () => {
  it("shows stored kilograms in pounds for a customary chart and converts the edit back", () => {
    expect(weightDisplayInput("10", "us_customary")).toBe("22.046");
    expect(correctedWeightKilograms("502", "10", "us_customary")).toBe(
      "227.703",
    );
  });
  it("preserves exact canonical weight when changing only the date", () => {
    const original = "227.703";
    expect(
      correctedWeightKilograms(
        weightDisplayInput(original, "us_customary"),
        original,
        "us_customary",
      ),
    ).toBe(original);
  });
  it("keeps metric inputs and empty values intact for validation", () => {
    expect(correctedWeightKilograms("12.500", "10", "metric")).toBe("12.500");
    expect(correctedWeightKilograms("", "10", "us_customary")).toBe("");
  });
});
