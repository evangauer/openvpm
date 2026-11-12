import { calculateDose } from "../dosing/calculator";
import { describe, expect, it } from "vitest";
import {
  clinicalUnitsFromSettings,
  weightInputKilograms,
  temperatureInputCelsius,
  weightToKilograms,
  kilogramsToWeight,
  formatClinicalWeight,
  formatClinicalTemperature,
  WEIGHT_UNITS,
} from "../clinical-units";

describe("clinic measurement units", () => {
  it("defaults to metric and preserves legacy ambulatory preferences without requiring that workspace", () => {
    expect(clinicalUnitsFromSettings(null)).toEqual({
      weightEntryUnit: "kg",
      temperatureUnit: "C",
      dualDisplay: true,
    });
    expect(
      clinicalUnitsFromSettings({
        ambulatoryWorkspace: {
          measurementSystem: "us_customary",
          enabled: false,
        },
      }),
    ).toEqual({
      weightEntryUnit: "lb",
      temperatureUnit: "F",
      dualDisplay: true,
    });
    expect(
      clinicalUnitsFromSettings({
        units: {
          weightEntryUnit: "oz",
          temperatureUnit: "C",
          dualDisplay: false,
        },
        ambulatoryWorkspace: { measurementSystem: "us_customary" },
      }),
    ).toEqual({
      weightEntryUnit: "oz",
      temperatureUnit: "C",
      dualDisplay: false,
    });
    expect(
      clinicalUnitsFromSettings({
        units: {
          weightEntryUnit: "stone",
          temperatureUnit: "K",
          dualDisplay: "false",
        },
      }),
    ).toEqual(clinicalUnitsFromSettings(null));
  });
  it.each(WEIGHT_UNITS)(
    "round trips exact conversions for %s before storage rounding",
    (unit) => {
      for (const kg of [0.001, 0.028, 11.793, 200, 99999.999])
        expect(
          weightToKilograms(kilogramsToWeight(kg, unit), unit),
        ).toBeCloseTo(kg, 9);
    },
  );
  it("normalizes entry precision only after conversion", () => {
    expect(weightInputKilograms("26", "lb")).toBe("11.793");
    expect(weightInputKilograms("1", "oz")).toBe("0.028");
    expect(weightInputKilograms("1", "g")).toBe("0.001");
    expect(weightInputKilograms("11.793", "kg")).toBe("11.793");
    expect(temperatureInputCelsius("101.5", "F")).toBe(38.6);
    expect(temperatureInputCelsius("38.6", "C")).toBe(38.6);
  });
  it("rejects invalid or out-of-range input before it can round into a valid measurement", () => {
    for (const value of [
      "",
      " ",
      "1e3",
      "-1",
      "0",
      "Infinity",
      "1,25",
      "0.0009",
      "100000",
    ])
      expect(weightInputKilograms(value, "kg")).toBeNull();
    expect(weightInputKilograms("0.001", "lb")).toBeNull();
    expect(weightInputKilograms("1.5", "g")).toBeNull();
    expect(weightInputKilograms("1.23", "oz")).toBeNull();
    expect(weightInputKilograms("441", "lb", 200)).toBeNull();
    expect(weightInputKilograms("440", "lb", 200)).toBe("199.581");
    expect(temperatureInputCelsius("67.9", "F")).toBeNull();
    expect(temperatureInputCelsius("113.1", "F")).toBeNull();
    expect(temperatureInputCelsius("68", "F")).toBe(20);
    expect(temperatureInputCelsius("113", "F")).toBe(45);
  });
  it("shows the clinic unit first and does not hide tiny recorded weights", () => {
    const units = clinicalUnitsFromSettings({
      units: { weightEntryUnit: "lb", temperatureUnit: "F" },
    });
    expect(formatClinicalWeight("11.793", units)).toBe("26.00 lb (11.79 kg)");
    expect(formatClinicalWeight("0.001")).toBe("0.001 kg (0.002 lb)");
    expect(formatClinicalTemperature("38.6", units)).toBe("101.5 °F (38.6 °C)");
    expect(formatClinicalWeight(null, units)).toBe("—");
    expect(formatClinicalTemperature("", units)).toBe("—");
    expect(formatClinicalWeight(11.793, { ...units, dualDisplay: false })).toBe(
      "26.00 lb",
    );
  });
});

it("keeps dosing in canonical kilograms regardless of entry units", () => {
  const weightKg = Number(weightInputKilograms("26", "lb"));
  const result = calculateDose({
    drugId: "carprofen",
    species: "canine",
    weightKg,
  });
  expect(result).toEqual(
    calculateDose({ drugId: "carprofen", species: "canine", weightKg: 11.793 }),
  );
  expect(result.weightUsed).toBe("11.79 kg (26.00 lb)");
  expect(result.doseLowMg).not.toBe(
    calculateDose({ drugId: "carprofen", species: "canine", weightKg: 26 })
      .doseLowMg,
  );
});
