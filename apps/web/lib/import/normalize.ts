/**
 * Value normalizers for migration imports. Real PIMS exports (AVImark,
 * Cornerstone, ezyVet, spreadsheets) spell species, sex, and dates a dozen
 * ways; these map the common spellings onto OpenVPM's enums and ISO dates
 * so clinics do not have to hand-edit their files. Pure — no I/O.
 */

import type { PatientSpecies } from "@/lib/patients/species";

export type NormalizedSpecies = PatientSpecies;

const SPECIES_ALIASES: Record<string, NormalizedSpecies> = {
  canine: "canine",
  dog: "canine",
  puppy: "canine",
  k9: "canine",
  feline: "feline",
  cat: "feline",
  kitten: "feline",
  avian: "avian",
  bird: "avian",
  parrot: "avian",
  parakeet: "avian",
  cockatiel: "avian",
  chicken: "poultry",
  rabbit: "rabbit",
  bunny: "rabbit",
  lagomorph: "rabbit",
  reptile: "reptile",
  lizard: "reptile",
  snake: "reptile",
  turtle: "reptile",
  tortoise: "reptile",
  gecko: "reptile",
  iguana: "reptile",
  "bearded dragon": "reptile",
  equine: "equine",
  horse: "equine",
  pony: "equine",
  donkey: "equine",
  mule: "equine",
  bovine: "bovine",
  cow: "bovine",
  cattle: "bovine",
  calf: "bovine",
  ovine: "ovine",
  sheep: "ovine",
  lamb: "ovine",
  caprine: "caprine",
  goat: "caprine",
  kid: "caprine",
  porcine: "porcine",
  pig: "porcine",
  swine: "porcine",
  poultry: "poultry",
  hen: "poultry",
  rooster: "poultry",
  turkey: "poultry",
  duck: "poultry",
  camelid: "camelid",
  alpaca: "camelid",
  llama: "camelid",
  other: "other",
  exotic: "other",
  "pocket pet": "other",
  ferret: "other",
  "guinea pig": "other",
  hamster: "other",
  rat: "other",
  mouse: "other",
  hedgehog: "other",
  chinchilla: "other",
};

/** Map a source species value onto our enum, or null when unrecognized. */
export function normalizeSpeciesValue(
  value: string | undefined,
): NormalizedSpecies | null {
  const v = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  return SPECIES_ALIASES[v] ?? null;
}

export type NormalizedSex =
  | "male"
  | "female"
  | "male_neutered"
  | "female_spayed";

const SEX_ALIASES: Record<string, NormalizedSex> = {
  male: "male",
  m: "male",
  "male intact": "male",
  "intact male": "male",
  female: "female",
  f: "female",
  "female intact": "female",
  "intact female": "female",
  male_neutered: "male_neutered",
  mn: "male_neutered",
  nm: "male_neutered",
  neutered: "male_neutered",
  "neutered male": "male_neutered",
  "male neutered": "male_neutered",
  castrated: "male_neutered",
  "castrated male": "male_neutered",
  female_spayed: "female_spayed",
  fs: "female_spayed",
  sf: "female_spayed",
  spayed: "female_spayed",
  "spayed female": "female_spayed",
  "female spayed": "female_spayed",
};

/** Map a source sex value onto our enum, or undefined when unrecognized. */
export function normalizeSexValue(
  value: string | undefined,
): NormalizedSex | undefined {
  const v = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, " ");
  if (!v) return undefined;
  return SEX_ALIASES[v];
}

export type NormalizedPatientStatus = "active" | "inactive" | "deceased";

const PATIENT_STATUS_ALIASES: Record<string, NormalizedPatientStatus> = {
  active: "active",
  current: "active",
  inactive: "inactive",
  archived: "inactive",
  deceased: "deceased",
  dead: "deceased",
};

/** Map source chart status without ever turning an unknown status active. */
export function normalizePatientStatusValue(
  value: string | undefined,
): NormalizedPatientStatus | undefined {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "_");
  if (!normalized) return undefined;
  return PATIENT_STATUS_ALIASES[normalized];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Normalize a source date to YYYY-MM-DD. Accepts ISO (2019-03-05) and the
 * US formats PIMS exports actually use: 3/5/2019, 03-05-2019, 3.5.19.
 * Two-digit years resolve to the past (birthdays and history, never the
 * future). Returns null when the value cannot be read as a date.
 */
export function normalizeDateValue(
  value: string | undefined,
  now: Date = new Date(),
): string | null {
  const v = value?.trim();
  if (!v) return null;

  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (iso) {
    const [, y, m, d] = iso;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!isRealDate(year, month, day)) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  const us = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    let year = Number(us[3]);
    if (us[3]!.length === 2) {
      const century = Math.floor(now.getUTCFullYear() / 100) * 100;
      year += century;
      if (year > now.getUTCFullYear()) year -= 100;
    }
    if (!isRealDate(year, month, day)) return null;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  return null;
}
