import { describe, expect, it } from "vitest";
import {
  ambulatoryWorkspaceSettings,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  kilogramsToPounds,
  poundsToKilograms,
  roundClinicalMeasurement,
} from "@/lib/ambulatory-workspace";

describe("ambulatory workspace settings", () => {
  it("defaults closed and metric for existing practices", () => {
    expect(ambulatoryWorkspaceSettings(undefined)).toEqual({
      enabled: false,
      measurementSystem: "metric",
      bodyConditionScale: 9,
      compactCloseout: true,
    });
  });

  it("parses an explicit US field-work profile", () => {
    expect(
      ambulatoryWorkspaceSettings({
        ambulatoryWorkspace: {
          enabled: true,
          measurementSystem: "us_customary",
          bodyConditionScale: 5,
          compactCloseout: true,
        },
      }),
    ).toEqual({
      enabled: true,
      measurementSystem: "us_customary",
      bodyConditionScale: 5,
      compactCloseout: true,
    });
  });

  it("fails closed for malformed settings", () => {
    expect(
      ambulatoryWorkspaceSettings({
        ambulatoryWorkspace: {
          enabled: "yes",
          measurementSystem: "imperial",
          bodyConditionScale: 7,
          compactCloseout: "yes",
        },
      }),
    ).toEqual({
      enabled: false,
      measurementSystem: "metric",
      bodyConditionScale: 9,
      compactCloseout: true,
    });
  });
});

describe("ambulatory measurement conversion", () => {
  it("round-trips temperature without changing canonical storage units", () => {
    const fahrenheit = celsiusToFahrenheit(38.6);
    expect(roundClinicalMeasurement(fahrenheit)).toBe(101.5);
    expect(roundClinicalMeasurement(fahrenheitToCelsius(fahrenheit))).toBe(
      38.6,
    );
  });

  it("round-trips large-animal weights without truncation", () => {
    const pounds = kilogramsToPounds(725.75);
    expect(roundClinicalMeasurement(pounds)).toBe(1600);
    expect(roundClinicalMeasurement(poundsToKilograms(pounds), 3)).toBe(725.75);
  });
});
