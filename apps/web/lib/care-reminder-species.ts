/**
 * Patient species values stored on the chart. Kept in step with the database
 * enum so care-reminder filters can offer every species without a new column.
 */
export const CARE_REMINDER_SPECIES = [
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

export type CareReminderSpecies = (typeof CARE_REMINDER_SPECIES)[number];

export const CARE_REMINDER_SPECIES_LABELS: Record<CareReminderSpecies, string> =
  {
    canine: "Dog",
    feline: "Cat",
    avian: "Bird",
    rabbit: "Rabbit",
    reptile: "Reptile",
    equine: "Horse",
    bovine: "Cow",
    ovine: "Sheep",
    caprine: "Goat",
    porcine: "Pig",
    poultry: "Poultry",
    camelid: "Camelid",
    other: "Other",
  };
