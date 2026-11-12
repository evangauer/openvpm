import {
  PATIENT_WEIGHT_MIN_KG,
  PATIENT_WEIGHT_MAX_KG,
} from "@/lib/records/patient-weight-policy";
import {
  VITALS_TEMPERATURE_MIN_C,
  VITALS_TEMPERATURE_MAX_C,
} from "@/lib/records/vitals-policy";

/** Clinic presentation preferences. Clinical storage and dosing remain kg/°C. */
export const WEIGHT_UNITS = ["kg", "lb", "oz", "g"] as const;
export const TEMPERATURE_UNITS = ["C", "F"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];
export type ClinicalUnits = {
  weightEntryUnit: WeightUnit;
  temperatureUnit: TemperatureUnit;
  dualDisplay: boolean;
};
export const DEFAULT_CLINICAL_UNITS: ClinicalUnits = {
  weightEntryUnit: "kg",
  temperatureUnit: "C",
  dualDisplay: true,
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function clinicalUnitsFromSettings(settings: unknown): ClinicalUnits {
  const root = object(settings);
  const legacy =
    object(root.ambulatoryWorkspace).measurementSystem === "us_customary";
  const units = object(root.units);
  return {
    weightEntryUnit: WEIGHT_UNITS.includes(units.weightEntryUnit as WeightUnit)
      ? (units.weightEntryUnit as WeightUnit)
      : legacy
        ? "lb"
        : "kg",
    temperatureUnit: TEMPERATURE_UNITS.includes(
      units.temperatureUnit as TemperatureUnit,
    )
      ? (units.temperatureUnit as TemperatureUnit)
      : legacy
        ? "F"
        : "C",
    dualDisplay:
      typeof units.dualDisplay === "boolean" ? units.dualDisplay : true,
  };
}

const KG_PER_UNIT: Record<WeightUnit, number> = {
  kg: 1,
  lb: 0.45359237,
  oz: 0.45359237 / 16,
  g: 0.001,
};
const WEIGHT_INPUT_SCALE: Record<WeightUnit, number> = {
  kg: 3,
  lb: 3,
  oz: 1,
  g: 0,
};

export function kilogramsToWeight(kg: number, unit: WeightUnit): number {
  return kg / KG_PER_UNIT[unit];
}
export function weightToKilograms(value: number, unit: WeightUnit): number {
  return value * KG_PER_UNIT[unit];
}
export function celsiusToTemperature(
  celsius: number,
  unit: TemperatureUnit,
): number {
  return unit === "F" ? (celsius * 9) / 5 + 32 : celsius;
}

function decimal(value: string, scale: number): number | null {
  const trimmed = value.trim();
  if (
    !/^\d+(?:\.\d+)?$/.test(trimmed) ||
    (trimmed.split(".")[1]?.length ?? 0) > scale
  )
    return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Validate before rounding, so out-of-range measurements cannot round into range. */
export function weightInputKilograms(
  value: string,
  unit: WeightUnit,
  maxKg = PATIENT_WEIGHT_MAX_KG,
): string | null {
  const amount = decimal(value, WEIGHT_INPUT_SCALE[unit]);
  if (amount === null) return null;
  const kg = weightToKilograms(amount, unit);
  if (kg < PATIENT_WEIGHT_MIN_KG - 1e-10 || kg > maxKg + 1e-10) return null;
  return (Math.round(kg * 1000) / 1000).toFixed(3);
}

export function temperatureInputCelsius(
  value: string,
  unit: TemperatureUnit,
): number | null {
  const amount = decimal(value, 1);
  if (amount === null) return null;
  const celsius = unit === "F" ? ((amount - 32) * 5) / 9 : amount;
  if (
    celsius < VITALS_TEMPERATURE_MIN_C - 1e-10 ||
    celsius > VITALS_TEMPERATURE_MAX_C + 1e-10
  )
    return null;
  return Math.round(celsius * 10) / 10;
}

function measurement(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function weightLabel(kg: number, unit: WeightUnit): string {
  const value = kilogramsToWeight(kg, unit);
  const decimals =
    unit === "g" ? 0 : unit === "oz" ? 1 : Math.abs(value) < 0.1 ? 3 : 2;
  return `${value.toFixed(decimals)} ${unit}`;
}
export function formatClinicalWeight(
  kg: number | string | null | undefined,
  units = DEFAULT_CLINICAL_UNITS,
): string {
  const n = measurement(kg);
  if (n === null) return "—";
  const primary = weightLabel(n, units.weightEntryUnit);
  const secondary = units.weightEntryUnit === "kg" ? "lb" : "kg";
  return units.dualDisplay
    ? `${primary} (${weightLabel(n, secondary)})`
    : primary;
}
export function formatClinicalTemperature(
  celsius: number | string | null | undefined,
  units = DEFAULT_CLINICAL_UNITS,
): string {
  const n = measurement(celsius);
  if (n === null) return "—";
  const label = (unit: TemperatureUnit) =>
    `${celsiusToTemperature(n, unit).toFixed(1)} °${unit}`;
  return units.dualDisplay
    ? `${label(units.temperatureUnit)} (${label(units.temperatureUnit === "C" ? "F" : "C")})`
    : label(units.temperatureUnit);
}
