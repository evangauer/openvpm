import { clinicalDateKey, clinicalDateLabel } from "./clinical-dates";

export type WeightTrendInput = {
  recordedAt: Date | string | null;
  weightKg: number | string | null;
};

export type VitalTrendInput = {
  recordedAt: Date | string | null;
  temperatureC?: number | string | null;
  heartRateBpm?: number | string | null;
  respiratoryRateBpm?: number | string | null;
  weightKg?: number | string | null;
  bodyConditionScore?: number | string | null;
  painScore?: number | string | null;
};

export type LabTrendInput = {
  testName: string | null;
  resultValue: number | string | null;
  unit?: string | null;
  referenceRangeLow?: number | string | null;
  referenceRangeHigh?: number | string | null;
  createdAt: Date | string | null;
};

export type WeightTrendPoint = {
  date: string;
  dateLabel: string;
  weightKg: number;
};

export type VitalTrendPoint = {
  date: string;
  dateLabel: string;
  temperatureC: number | null;
  heartRateBpm: number | null;
  respiratoryRateBpm: number | null;
  weightKg: number | null;
  bodyConditionScore: number | null;
  painScore: number | null;
};

export type LabTrendPoint = {
  date: string;
  dateLabel: string;
  value: number;
  referenceRangeLow: number | null;
  referenceRangeHigh: number | null;
};

export type LabTrendGroup = {
  key: string;
  testName: string;
  unit: string | null;
  points: LabTrendPoint[];
  latestValue: number;
  previousValue: number;
  change: number;
};

export function parseClinicalNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildWeightTrend(
  weights: readonly WeightTrendInput[],
  timeZone?: string | null
): WeightTrendPoint[] {
  return weights
    .map((weight) => {
      const date = toDate(weight.recordedAt);
      const weightKg = parseClinicalNumber(weight.weightKg);
      if (!date || weightKg === null) return null;
      const key = clinicalDateKey(date, timeZone);
      const label = clinicalDateLabel(date, timeZone);
      if (!key || !label) return null;
      return {
        date: key,
        dateLabel: label,
        weightKg,
      };
    })
    .filter((point): point is WeightTrendPoint => Boolean(point))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeTrendText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function buildVitalTrend(
  vitals: readonly VitalTrendInput[],
  timeZone?: string | null
): VitalTrendPoint[] {
  return vitals
    .map((vital) => {
      const date = toDate(vital.recordedAt);
      if (!date) return null;
      const key = clinicalDateKey(date, timeZone);
      const label = clinicalDateLabel(date, timeZone);
      if (!key || !label) return null;
      return {
        date: key,
        dateLabel: label,
        temperatureC: parseClinicalNumber(vital.temperatureC),
        heartRateBpm: parseClinicalNumber(vital.heartRateBpm),
        respiratoryRateBpm: parseClinicalNumber(vital.respiratoryRateBpm),
        weightKg: parseClinicalNumber(vital.weightKg),
        bodyConditionScore: parseClinicalNumber(vital.bodyConditionScore),
        painScore: parseClinicalNumber(vital.painScore),
      };
    })
    .filter((point): point is VitalTrendPoint => Boolean(point))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildLabTrends(
  labResults: readonly LabTrendInput[],
  timeZone?: string | null,
  maxGroups = 4
): LabTrendGroup[] {
  const groups = new Map<
    string,
    { testName: string; unit: string | null; points: LabTrendPoint[] }
  >();

  for (const lab of labResults) {
    const testName = normalizeTrendText(lab.testName);
    const unit = normalizeTrendText(lab.unit);
    const value = parseClinicalNumber(lab.resultValue);
    const date = toDate(lab.createdAt);
    if (!testName || value === null || !date) continue;

    const key = `${testName.toLowerCase()}\u0000${unit.toLowerCase()}`;
    const dateKey = clinicalDateKey(date, timeZone);
    const dateLabel = clinicalDateLabel(date, timeZone);
    if (!dateKey || !dateLabel) continue;

    const group = groups.get(key) ?? {
      testName,
      unit: unit || null,
      points: [],
    };
    group.points.push({
      date: dateKey,
      dateLabel,
      value,
      referenceRangeLow: parseClinicalNumber(lab.referenceRangeLow),
      referenceRangeHigh: parseClinicalNumber(lab.referenceRangeHigh),
    });
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const points = [...group.points].sort((a, b) => a.date.localeCompare(b.date));
      if (points.length < 2) return null;
      const latest = points[points.length - 1]!;
      const previous = points[points.length - 2]!;
      return {
        key,
        testName: group.testName,
        unit: group.unit,
        points,
        latestValue: latest.value,
        previousValue: previous.value,
        change: latest.value - previous.value,
      };
    })
    .filter((group): group is LabTrendGroup => Boolean(group))
    .sort((a, b) => {
      const latestDate = b.points[b.points.length - 1]!.date.localeCompare(
        a.points[a.points.length - 1]!.date
      );
      if (latestDate !== 0) return latestDate;
      return a.testName.localeCompare(b.testName);
    })
    .slice(0, maxGroups);
}

export function hasTrendValues<T extends Record<string, unknown>>(
  points: readonly T[],
  keys: readonly (keyof T)[]
): boolean {
  return points.some((point) =>
    keys.some((key) => typeof point[key] === "number")
  );
}
