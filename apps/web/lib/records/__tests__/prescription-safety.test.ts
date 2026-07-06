import { describe, expect, it } from "vitest";
import {
  evaluatePrescriptionSafety,
  medicationNamesMatch,
  normalizeMedicationName,
} from "../prescription-safety";

describe("prescription safety", () => {
  it("normalizes medication names for matching", () => {
    expect(normalizeMedicationName("  Carprofen 75-mg tablet ")).toBe(
      "carprofen 75 mg tablet"
    );
    expect(medicationNamesMatch("Carprofen 75 mg", "carprofen")).toBe(true);
  });

  it("flags matching patient allergies and requires an override", () => {
    const result = evaluatePrescriptionSafety({
      medicationName: "Carprofen 75 mg tablet",
      allergies: [
        {
          allergen: "carprofen",
          severity: "severe",
          reaction: "Facial swelling",
        },
      ],
      activePrescriptions: [],
      interactions: [],
    });

    expect(result.requiresOverride).toBe(true);
    expect(result.warnings).toMatchObject([
      {
        type: "allergy",
        severity: "major",
        requiresOverride: true,
      },
    ]);
    expect(result.warnings[0]!.message).toContain("Facial swelling");
  });

  it("flags active medication interactions in either drug order", () => {
    const result = evaluatePrescriptionSafety({
      medicationName: "Enalapril",
      allergies: [],
      activePrescriptions: [{ medicationName: "Furosemide" }],
      interactions: [
        {
          drugA: "furosemide",
          drugB: "enalapril",
          severity: "moderate",
          description: "Monitor renal values and hydration.",
        },
      ],
    });

    expect(result.requiresOverride).toBe(true);
    expect(result.warnings).toEqual([
      {
        type: "interaction",
        severity: "moderate",
        title: "moderate interaction with Furosemide",
        message: "Monitor renal values and hydration.",
        requiresOverride: true,
      },
    ]);
  });

  it("shows minor interactions without requiring an override", () => {
    const result = evaluatePrescriptionSafety({
      medicationName: "Gabapentin",
      allergies: [],
      activePrescriptions: [{ medicationName: "Trazodone" }],
      interactions: [
        {
          drugA: "gabapentin",
          drugB: "trazodone",
          severity: "minor",
        },
      ],
    });

    expect(result.requiresOverride).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.requiresOverride).toBe(false);
  });

  it("returns no warnings when allergies and interactions do not match", () => {
    const result = evaluatePrescriptionSafety({
      medicationName: "Maropitant",
      allergies: [{ allergen: "amoxicillin", severity: "moderate" }],
      activePrescriptions: [{ medicationName: "Benazepril" }],
      interactions: [
        {
          drugA: "carprofen",
          drugB: "prednisone",
          severity: "major",
        },
      ],
    });

    expect(result).toEqual({ warnings: [], requiresOverride: false });
  });
});
