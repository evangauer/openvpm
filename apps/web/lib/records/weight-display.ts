import {
  kilogramsToPounds,
  poundsToKilograms,
  roundClinicalMeasurement,
  type MeasurementSystem,
} from "@/lib/ambulatory-workspace";

export function weightDisplayInput(
  weightKg: string,
  measurementSystem: MeasurementSystem,
): string {
  return measurementSystem === "us_customary"
    ? String(roundClinicalMeasurement(kilogramsToPounds(Number(weightKg)), 3))
    : weightKg;
}

/** Avoid changing a stored measurement from rounding when only its date is corrected. */
export function correctedWeightKilograms(
  value: string,
  originalKg: string,
  measurementSystem: MeasurementSystem,
): string {
  if (value.trim() === weightDisplayInput(originalKg, measurementSystem))
    return originalKg;
  if (measurementSystem === "metric" || !value.trim()) return value.trim();
  return String(roundClinicalMeasurement(poundsToKilograms(Number(value)), 3));
}
