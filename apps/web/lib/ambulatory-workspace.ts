export const MEASUREMENT_SYSTEMS = ["metric", "us_customary"] as const;
export type MeasurementSystem = (typeof MEASUREMENT_SYSTEMS)[number];

export const BODY_CONDITION_SCALES = [5, 9] as const;
export type BodyConditionScale = (typeof BODY_CONDITION_SCALES)[number];

export interface AmbulatoryWorkspaceSettings {
  enabled: boolean;
  measurementSystem: MeasurementSystem;
  bodyConditionScale: BodyConditionScale;
  compactCloseout: boolean;
}

export const DEFAULT_AMBULATORY_WORKSPACE_SETTINGS: AmbulatoryWorkspaceSettings =
  {
    enabled: false,
    measurementSystem: "metric",
    bodyConditionScale: 9,
    compactCloseout: true,
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Practice settings are schemaless JSON for backward compatibility. Treat
 * malformed or partially migrated values as absent so a bad setting can never
 * silently enable a clinical workflow.
 */
export function ambulatoryWorkspaceSettings(
  practiceSettings: unknown,
): AmbulatoryWorkspaceSettings {
  if (!isRecord(practiceSettings)) {
    return { ...DEFAULT_AMBULATORY_WORKSPACE_SETTINGS };
  }
  const candidate = practiceSettings.ambulatoryWorkspace;
  if (!isRecord(candidate)) {
    return { ...DEFAULT_AMBULATORY_WORKSPACE_SETTINGS };
  }

  return {
    enabled: candidate.enabled === true,
    measurementSystem:
      candidate.measurementSystem === "us_customary"
        ? "us_customary"
        : "metric",
    bodyConditionScale: candidate.bodyConditionScale === 5 ? 5 : 9,
    compactCloseout: candidate.compactCloseout !== false,
  };
}

export function celsiusToFahrenheit(value: number): number {
  return (value * 9) / 5 + 32;
}

export function fahrenheitToCelsius(value: number): number {
  return ((value - 32) * 5) / 9;
}

export function kilogramsToPounds(value: number): number {
  return value * 2.2046226218;
}

export function poundsToKilograms(value: number): number {
  return value / 2.2046226218;
}

export function roundClinicalMeasurement(value: number, scale = 1): number {
  const factor = 10 ** scale;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
