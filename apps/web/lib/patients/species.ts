export const PATIENT_SPECIES = [
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "bovine",
  "ovine",
  "caprine",
  "porcine",
  "poultry",
  "camelid",
  "other",
] as const;

export type PatientSpecies = (typeof PATIENT_SPECIES)[number];

export const PATIENT_SPECIES_OPTIONS: ReadonlyArray<{
  value: PatientSpecies;
  label: string;
}> = [
  { value: "canine", label: "Canine" },
  { value: "feline", label: "Feline" },
  { value: "avian", label: "Avian" },
  { value: "rabbit", label: "Rabbit" },
  { value: "reptile", label: "Reptile" },
  { value: "equine", label: "Equine" },
  { value: "bovine", label: "Bovine" },
  { value: "ovine", label: "Ovine" },
  { value: "caprine", label: "Caprine" },
  { value: "porcine", label: "Porcine" },
  { value: "poultry", label: "Poultry" },
  { value: "camelid", label: "Camelid" },
  { value: "other", label: "Other" },
];

export const PATIENT_SPECIES_LABELS: Record<PatientSpecies, string> =
  Object.fromEntries(
    PATIENT_SPECIES_OPTIONS.map(({ value, label }) => [value, label]),
  ) as Record<PatientSpecies, string>;

export const PATIENT_SPECIES_EMOJI: Record<PatientSpecies, string> = {
  canine: "🐶",
  feline: "🐱",
  avian: "🐦",
  rabbit: "🐰",
  reptile: "🦎",
  equine: "🐴",
  bovine: "🐄",
  ovine: "🐑",
  caprine: "🐐",
  porcine: "🐖",
  poultry: "🐓",
  camelid: "🦙",
  other: "🐾",
};
