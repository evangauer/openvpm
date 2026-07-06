import { describe, expect, it } from "vitest";
import {
  clinicalDecimalInput,
  clinicalTextInput,
  compareClinicalDateInputs,
  hasMaxDecimalPlaces,
  isOrderedLabReferenceRange,
  isValidClinicalDateInput,
  isValidLabReferenceInput,
  optionalClinicalTextInput,
} from "../clinical-inputs";

describe("clinical input validation", () => {
  it("accepts only real YYYY-MM-DD calendar dates", () => {
    expect(isValidClinicalDateInput("2026-06-27")).toBe(true);
    expect(isValidClinicalDateInput("2026-02-31")).toBe(false);
    expect(isValidClinicalDateInput("2026-6-27")).toBe(false);
    expect(isValidClinicalDateInput("not-a-date")).toBe(false);
  });

  it("compares validated date inputs lexically", () => {
    expect(compareClinicalDateInputs("2026-06-27", "2026-06-27")).toBe(0);
    expect(compareClinicalDateInputs("2026-06-28", "2026-06-27")).toBe(1);
    expect(compareClinicalDateInputs("2026-06-26", "2026-06-27")).toBe(-1);
  });

  it("accepts lab numeric strings that fit the database column", () => {
    expect(isValidLabReferenceInput("7")).toBe(true);
    expect(isValidLabReferenceInput("-2.125")).toBe(true);
    expect(isValidLabReferenceInput("9999999.999")).toBe(true);
    expect(isValidLabReferenceInput("1.2345")).toBe(false);
    expect(isValidLabReferenceInput("10000000")).toBe(false);
    expect(isValidLabReferenceInput("positive")).toBe(false);
  });

  it("checks decimal precision for clinical numeric inputs", () => {
    expect(hasMaxDecimalPlaces(38.6, 1)).toBe(true);
    expect(hasMaxDecimalPlaces(38.66, 1)).toBe(false);
    expect(hasMaxDecimalPlaces(12.345, 3)).toBe(true);
    expect(hasMaxDecimalPlaces(12.3456, 3)).toBe(false);

    const temperature = clinicalDecimalInput("Temperature", { min: 20, max: 45, scale: 1 });
    expect(temperature.safeParse(38.6).success).toBe(true);
    expect(temperature.safeParse(38.66).success).toBe(false);
    expect(temperature.safeParse(50).success).toBe(false);
  });

  it("trims and bounds clinical text inputs", () => {
    const medication = clinicalTextInput("Medication name", 12);
    expect(medication.parse("  Carprofen ")).toBe("Carprofen");
    expect(medication.safeParse("   ").success).toBe(false);
    expect(medication.safeParse("A".repeat(13)).success).toBe(false);

    const lotNumber = optionalClinicalTextInput("Lot number", 4);
    expect(lotNumber.parse(" A1 ")).toBe("A1");
    expect(lotNumber.safeParse("12345").success).toBe(false);
    expect(lotNumber.safeParse(undefined).success).toBe(true);
  });

  it("checks lab reference range ordering when both bounds are present", () => {
    expect(isOrderedLabReferenceRange(undefined, "10")).toBe(true);
    expect(isOrderedLabReferenceRange("-1", "10")).toBe(true);
    expect(isOrderedLabReferenceRange("10", "9.999")).toBe(false);
  });
});
