import { describe, expect, it } from "vitest";
import {
  normalizeDateValue,
  normalizeSexValue,
  normalizeSpeciesValue,
} from "../normalize";

const NOW = new Date("2026-07-10T12:00:00Z");

describe("migration value normalizers", () => {
  it("maps the species spellings real exports use onto our enum", () => {
    expect(normalizeSpeciesValue("Dog")).toBe("canine");
    expect(normalizeSpeciesValue("CANINE")).toBe("canine");
    expect(normalizeSpeciesValue("cat")).toBe("feline");
    expect(normalizeSpeciesValue("Kitten")).toBe("feline");
    expect(normalizeSpeciesValue("Bird")).toBe("avian");
    expect(normalizeSpeciesValue("bunny")).toBe("rabbit");
    expect(normalizeSpeciesValue("Bearded  Dragon")).toBe("reptile");
    expect(normalizeSpeciesValue("Horse")).toBe("equine");
    expect(normalizeSpeciesValue("Ferret")).toBe("other");
    expect(normalizeSpeciesValue("Guinea Pig")).toBe("other");
  });

  it("returns null for unrecognized species instead of guessing", () => {
    expect(normalizeSpeciesValue("dragon")).toBeNull();
    expect(normalizeSpeciesValue("")).toBeNull();
    expect(normalizeSpeciesValue(undefined)).toBeNull();
  });

  it("maps sex abbreviations and phrasings onto our enum", () => {
    expect(normalizeSexValue("M")).toBe("male");
    expect(normalizeSexValue("f")).toBe("female");
    expect(normalizeSexValue("MN")).toBe("male_neutered");
    expect(normalizeSexValue("Neutered Male")).toBe("male_neutered");
    expect(normalizeSexValue("male neutered")).toBe("male_neutered");
    expect(normalizeSexValue("Castrated")).toBe("male_neutered");
    expect(normalizeSexValue("FS")).toBe("female_spayed");
    expect(normalizeSexValue("Spayed Female")).toBe("female_spayed");
    expect(normalizeSexValue("female_spayed")).toBe("female_spayed");
    expect(normalizeSexValue("unknown")).toBeUndefined();
    expect(normalizeSexValue(undefined)).toBeUndefined();
  });

  it("normalizes ISO and US date formats to YYYY-MM-DD", () => {
    expect(normalizeDateValue("2019-03-05", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("2019-3-5", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("3/5/2019", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("03-05-2019", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("3.5.2019", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("12/31/2025", NOW)).toBe("2025-12-31");
  });

  it("resolves two-digit years into the past, never the future", () => {
    // Birthdays and history: 3/5/19 is 2019, but 3/5/99 is 1999.
    expect(normalizeDateValue("3/5/19", NOW)).toBe("2019-03-05");
    expect(normalizeDateValue("3/5/26", NOW)).toBe("2026-03-05");
    expect(normalizeDateValue("3/5/27", NOW)).toBe("1927-03-05");
    expect(normalizeDateValue("3/5/99", NOW)).toBe("1999-03-05");
  });

  it("rejects impossible and unreadable dates", () => {
    expect(normalizeDateValue("2026-02-30", NOW)).toBeNull();
    expect(normalizeDateValue("13/1/2020", NOW)).toBeNull();
    expect(normalizeDateValue("0/10/2020", NOW)).toBeNull();
    expect(normalizeDateValue("last spring", NOW)).toBeNull();
    expect(normalizeDateValue("", NOW)).toBeNull();
    expect(normalizeDateValue(undefined, NOW)).toBeNull();
  });
});
