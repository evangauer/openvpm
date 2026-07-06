import {
  findDrug,
  DOSING_DISCLAIMER,
  type DosingSpecies,
  type FormularyDrug,
  type SpeciesDose,
} from "./formulary";

export interface DoseInput {
  drugId: string;
  species: DosingSpecies;
  weightKg: number;
  /** Optional concentration (mg/mL) to compute a liquid/injectable volume. */
  concentrationMgPerMl?: number;
}

export const DOSING_WEIGHT_MAX_KG = 200;

export interface TabletSuggestion {
  strengthMg: number;
  /** Tablets per dose at the midpoint of the range, rounded to 1/4 tablet. */
  tabletsPerDose: number;
}

export interface DoseResult {
  drug: { id: string; name: string; category: string };
  species: DosingSpecies;
  weightKg: number;
  route: string;
  frequency: string;
  mgPerKgLow: number;
  mgPerKgHigh: number;
  doseLowMg: number;
  doseHighMg: number;
  cappedByMax: boolean;
  volumeLowMl?: number;
  volumeHighMl?: number;
  tabletSuggestions?: TabletSuggestion[];
  warnings: string[];
  disclaimer: string;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Nearest quarter, so tablet splitting stays practical (½, ¼ tablet). */
function roundToQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

function doseForSpecies(
  drug: FormularyDrug,
  species: DosingSpecies
): SpeciesDose | undefined {
  return drug.doses.find((d) => d.species === species);
}

/**
 * Calculate a weight-based dose range for a formulary drug. Pure function —
 * no I/O. Throws on invalid weight; returns a `notFound`/`unsupported` style
 * error via thrown Error the caller can surface as a 4xx.
 */
export function calculateDose(input: DoseInput): DoseResult {
  if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
    throw new Error("Weight must be a positive number of kilograms.");
  }
  if (input.weightKg > DOSING_WEIGHT_MAX_KG) {
    throw new Error("Weight exceeds a plausible range (>200kg). Check units.");
  }

  const drug = findDrug(input.drugId);
  if (!drug) {
    throw new Error(`Unknown drug: ${input.drugId}`);
  }

  const dose = doseForSpecies(drug, input.species);
  if (!dose) {
    throw new Error(
      `No reference dose for ${drug.name} in ${input.species}. Do not extrapolate across species.`
    );
  }

  let doseLowMg = input.weightKg * dose.mgPerKgLow;
  let doseHighMg = input.weightKg * dose.mgPerKgHigh;

  let cappedByMax = false;
  if (dose.maxSingleDoseMg !== undefined) {
    if (doseHighMg > dose.maxSingleDoseMg) {
      doseHighMg = dose.maxSingleDoseMg;
      cappedByMax = true;
    }
    if (doseLowMg > dose.maxSingleDoseMg) {
      doseLowMg = dose.maxSingleDoseMg;
      cappedByMax = true;
    }
  }

  doseLowMg = round(doseLowMg, 2);
  doseHighMg = round(doseHighMg, 2);

  const warnings = [...(drug.warnings ?? [])];
  if (dose.notes) warnings.push(dose.notes);
  if (cappedByMax) {
    warnings.push(`Dose capped at the maximum single dose of ${dose.maxSingleDoseMg} mg.`);
  }

  const result: DoseResult = {
    drug: { id: drug.id, name: drug.name, category: drug.category },
    species: input.species,
    weightKg: input.weightKg,
    route: dose.route,
    frequency: dose.frequency,
    mgPerKgLow: dose.mgPerKgLow,
    mgPerKgHigh: dose.mgPerKgHigh,
    doseLowMg,
    doseHighMg,
    cappedByMax,
    warnings,
    disclaimer: DOSING_DISCLAIMER,
  };

  const concentration = input.concentrationMgPerMl;
  if (concentration !== undefined) {
    if (!Number.isFinite(concentration) || concentration <= 0) {
      throw new Error("Concentration must be a positive number (mg/mL).");
    }
    result.volumeLowMl = round(doseLowMg / concentration, 2);
    result.volumeHighMl = round(doseHighMg / concentration, 2);
  }

  if (drug.tabletStrengthsMg?.length) {
    const midpoint = (doseLowMg + doseHighMg) / 2;
    result.tabletSuggestions = drug.tabletStrengthsMg
      .map((strengthMg) => ({
        strengthMg,
        tabletsPerDose: roundToQuarter(midpoint / strengthMg),
      }))
      // Only suggest practical splits (¼ to 4 tablets).
      .filter((s) => s.tabletsPerDose >= 0.25 && s.tabletsPerDose <= 4);
  }

  return result;
}
