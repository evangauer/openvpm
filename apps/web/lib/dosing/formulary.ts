/**
 * Starter veterinary formulary for the dosing calculator.
 *
 * IMPORTANT: These are common published reference ranges intended to assist a
 * licensed clinician, NOT to replace clinical judgment or a current drug
 * reference (e.g. Plumb's). Every calculated dose must be verified by the
 * prescriber before use. Ranges are conservative and species-specific; some
 * drugs are contraindicated in a species and are flagged accordingly.
 */

export type DosingSpecies = "canine" | "feline";

export interface SpeciesDose {
  species: DosingSpecies;
  mgPerKgLow: number;
  mgPerKgHigh: number;
  /** Administration route, e.g. PO, SC, IV, IM. */
  route: string;
  /** Dosing interval, e.g. q24h, q12h, q8h. */
  frequency: string;
  /** Optional hard cap on a single dose, regardless of weight. */
  maxSingleDoseMg?: number;
  notes?: string;
}

export interface FormularyDrug {
  id: string;
  name: string;
  category: string;
  /** Common injectable / oral-liquid concentrations in mg/mL. */
  concentrationsMgPerMl?: number[];
  /** Common tablet / capsule strengths in mg. */
  tabletStrengthsMg?: number[];
  doses: SpeciesDose[];
  /** Species-level or drug-level cautions surfaced with every result. */
  warnings?: string[];
}

export const DOSING_DISCLAIMER =
  "Reference ranges only. Verify every dose against a current veterinary drug " +
  "reference and the patient's full clinical picture before prescribing.";

export const FORMULARY_DRUG_ID_MAX_LENGTH = 64;

export const FORMULARY: FormularyDrug[] = [
  {
    id: "maropitant",
    name: "Maropitant (Cerenia)",
    category: "Antiemetic",
    concentrationsMgPerMl: [10],
    tabletStrengthsMg: [16, 24, 60, 160],
    doses: [
      { species: "canine", mgPerKgLow: 1, mgPerKgHigh: 2, route: "PO", frequency: "q24h", notes: "1 mg/kg SC or 2 mg/kg PO" },
      { species: "feline", mgPerKgLow: 1, mgPerKgHigh: 1, route: "SC", frequency: "q24h" },
    ],
  },
  {
    id: "carprofen",
    name: "Carprofen (Rimadyl)",
    category: "NSAID",
    tabletStrengthsMg: [25, 75, 100],
    doses: [
      { species: "canine", mgPerKgLow: 2.2, mgPerKgHigh: 4.4, route: "PO", frequency: "q12-24h", notes: "4.4 mg/kg/day total, split q12h or once daily" },
    ],
    warnings: ["Not recommended in cats. Use with caution in patients with renal, hepatic, or GI disease."],
  },
  {
    id: "meloxicam",
    name: "Meloxicam (Metacam)",
    category: "NSAID",
    concentrationsMgPerMl: [1.5, 5],
    doses: [
      { species: "canine", mgPerKgLow: 0.1, mgPerKgHigh: 0.2, route: "PO", frequency: "q24h", notes: "0.2 mg/kg loading dose day 1, then 0.1 mg/kg" },
      { species: "feline", mgPerKgLow: 0.05, mgPerKgHigh: 0.1, route: "PO", frequency: "q24h", maxSingleDoseMg: 0.3, notes: "Single-dose use; repeated dosing in cats is high-risk" },
    ],
    warnings: ["Repeated NSAID use in cats carries significant renal risk. Confirm hydration and renal values."],
  },
  {
    id: "gabapentin",
    name: "Gabapentin",
    category: "Analgesic / Anxiolytic",
    concentrationsMgPerMl: [50],
    tabletStrengthsMg: [100, 300, 400],
    doses: [
      { species: "canine", mgPerKgLow: 5, mgPerKgHigh: 10, route: "PO", frequency: "q8-12h" },
      { species: "feline", mgPerKgLow: 5, mgPerKgHigh: 10, route: "PO", frequency: "q12h", notes: "Higher single doses (e.g. 50-100 mg/cat) used situationally for transport anxiety" },
    ],
  },
  {
    id: "metronidazole",
    name: "Metronidazole",
    category: "Antibiotic / Antiprotozoal",
    tabletStrengthsMg: [250, 500],
    doses: [
      { species: "canine", mgPerKgLow: 10, mgPerKgHigh: 15, route: "PO", frequency: "q12h" },
      { species: "feline", mgPerKgLow: 10, mgPerKgHigh: 15, route: "PO", frequency: "q12h" },
    ],
    warnings: ["Cumulative high doses risk neurotoxicity. Avoid prolonged high-dose courses."],
  },
  {
    id: "amoxicillin-clavulanate",
    name: "Amoxicillin / Clavulanate (Clavamox)",
    category: "Antibiotic",
    tabletStrengthsMg: [62.5, 125, 250, 375],
    doses: [
      { species: "canine", mgPerKgLow: 12.5, mgPerKgHigh: 25, route: "PO", frequency: "q12h" },
      { species: "feline", mgPerKgLow: 12.5, mgPerKgHigh: 25, route: "PO", frequency: "q12h" },
    ],
  },
  {
    id: "famotidine",
    name: "Famotidine",
    category: "H2 antagonist",
    tabletStrengthsMg: [10, 20, 40],
    doses: [
      { species: "canine", mgPerKgLow: 0.5, mgPerKgHigh: 1, route: "PO", frequency: "q12-24h" },
      { species: "feline", mgPerKgLow: 0.5, mgPerKgHigh: 1, route: "PO", frequency: "q12-24h" },
    ],
  },
  {
    id: "oclacitinib",
    name: "Oclacitinib (Apoquel)",
    category: "Antipruritic",
    tabletStrengthsMg: [3.6, 5.4, 16],
    doses: [
      { species: "canine", mgPerKgLow: 0.4, mgPerKgHigh: 0.6, route: "PO", frequency: "q12h", notes: "q12h for up to 14 days, then q24h maintenance" },
    ],
    warnings: ["Labeled for dogs ≥12 months. Not for cats."],
  },
];

export function findDrug(drugId: string): FormularyDrug | undefined {
  return FORMULARY.find((d) => d.id === drugId);
}

export function isFormularyDrugId(drugId: string): boolean {
  return Boolean(findDrug(drugId));
}
