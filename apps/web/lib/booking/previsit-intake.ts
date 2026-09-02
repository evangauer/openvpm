import { z } from "zod";
import { APPOINTMENT_NOTES_MAX_LENGTH } from "@/lib/scheduling/appointment-policy";

export const PREVISIT_INTAKE_FIELD_MAX_LENGTH = 500;

/**
 * Stable display catalog shared by booking-page settings and the public form.
 * Service address intentionally comes first so a field veterinarian can find
 * the visit even when lower-priority history fills the appointment note.
 */
export const PREVISIT_INTAKE_FIELD_DEFINITIONS = [
  {
    key: "serviceAddress",
    label: "Service or farm address",
    placeholder: "Street address, farm name, gate, unit, or arrival directions",
  },
  {
    key: "symptoms",
    label: "Current signs or symptoms",
    placeholder: "What are you seeing right now?",
  },
  {
    key: "concernOnset",
    label: "When it started or changed",
    placeholder: "Include timing and whether it is improving or getting worse",
  },
  {
    key: "currentMedications",
    label: "Current medications or supplements",
    placeholder: "Names, doses, and timing if known",
  },
  {
    key: "allergies",
    label: "Known allergies or past reactions",
    placeholder: "Include medications, vaccines, foods, or other reactions",
  },
  {
    key: "medicalHistory",
    label: "Relevant medical history",
    placeholder: "Previous diagnoses, procedures, or similar episodes",
  },
  {
    key: "diet",
    label: "Diet",
    placeholder: "Food, grazing, recent changes, or possible exposures",
  },
  {
    key: "handlingNotes",
    label: "Handling or access notes",
    placeholder:
      "Temperament, restraint needs, gate directions, or arrival notes",
  },
] as const;

export type PrevisitIntakeFieldKey =
  (typeof PREVISIT_INTAKE_FIELD_DEFINITIONS)[number]["key"];

const PREVISIT_INTAKE_FIELD_KEYS = PREVISIT_INTAKE_FIELD_DEFINITIONS.map(
  ({ key }) => key,
) as [PrevisitIntakeFieldKey, ...PrevisitIntakeFieldKey[]];

/** Strict validation for a single configurable intake field key. */
export const previsitIntakeFieldKeyInput = z.enum(PREVISIT_INTAKE_FIELD_KEYS);

const optionalIntakeText = z
  .string()
  .trim()
  .max(PREVISIT_INTAKE_FIELD_MAX_LENGTH)
  .optional()
  .transform((value) => value || undefined);

/**
 * Owner-reported context collected before a public booking request.
 *
 * These answers are intentionally kept separate from permanent client
 * demographics and verified clinical records. Staff reconcile them before
 * promoting anything into the authoritative chart or client profile.
 */
export const previsitIntakeInput = z
  .object({
    serviceAddress: optionalIntakeText,
    symptoms: optionalIntakeText,
    concernOnset: optionalIntakeText,
    currentMedications: optionalIntakeText,
    allergies: optionalIntakeText,
    medicalHistory: optionalIntakeText,
    diet: optionalIntakeText,
    handlingNotes: optionalIntakeText,
  })
  .strict();

export type PrevisitIntake = z.infer<typeof previsitIntakeInput>;

/**
 * Drop values for fields the clinic disabled. Output order always follows the
 * catalog, regardless of the order or contents of a public request payload.
 */
export function filterPrevisitIntakeByFieldKeys(
  intake: PrevisitIntake,
  enabledFieldKeys: readonly PrevisitIntakeFieldKey[],
): PrevisitIntake {
  const enabled = new Set(enabledFieldKeys);
  return Object.fromEntries(
    PREVISIT_INTAKE_FIELD_DEFINITIONS.flatMap(({ key }) => {
      const value = intake[key];
      return enabled.has(key) && value !== undefined ? [[key, value]] : [];
    }),
  ) as PrevisitIntake;
}

const DISPLAY_FIELDS: ReadonlyArray<{
  key: Exclude<PrevisitIntakeFieldKey, "serviceAddress">;
  label: string;
}> = [
  { key: "symptoms", label: "Current signs" },
  { key: "concernOnset", label: "Started or changed" },
  { key: "currentMedications", label: "Current medications/supplements" },
  { key: "allergies", label: "Reported allergies/reactions" },
  { key: "medicalHistory", label: "Relevant history" },
  { key: "diet", label: "Diet" },
  { key: "handlingNotes", label: "Handling/access notes" },
];

function normalizeForNote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return "…";
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Compiles intake into the existing appointment note surface. This makes the
 * answers visible in the schedule, inbox, and encounter without a schema
 * change. Reason and service address always precede lower-priority history.
 */
export function formatOnlineBookingAppointmentNote(input: {
  reason: string;
  intake?: PrevisitIntake;
}): string {
  const prefix = "[Online request] ";
  const reason = normalizeForNote(input.reason);
  let note = `${prefix}${truncateToLength(
    reason,
    APPOINTMENT_NOTES_MAX_LENGTH - prefix.length,
  )}`;

  const serviceAddress = input.intake?.serviceAddress
    ? normalizeForNote(input.intake.serviceAddress)
    : "";
  if (serviceAddress) {
    const separator = " | Service/farm address (owner-reported): ";
    const available =
      APPOINTMENT_NOTES_MAX_LENGTH - note.length - separator.length;
    if (available > 1) {
      note += `${separator}${truncateToLength(serviceAddress, available)}`;
    }
  }

  const reportedFields = input.intake
    ? DISPLAY_FIELDS.flatMap(({ key, label }) => {
        const value = input.intake?.[key];
        if (!value) return [];
        const normalized = normalizeForNote(value);
        return normalized ? [`${label}: ${normalized}`] : [];
      })
    : [];

  if (reportedFields.length === 0) return note;

  const heading = " | Client-reported pre-visit history (unverified): ";
  for (const field of reportedFields) {
    const separator = note.includes(heading) ? " • " : heading;
    const available =
      APPOINTMENT_NOTES_MAX_LENGTH - note.length - separator.length;
    if (available <= 1) break;
    note += `${separator}${truncateToLength(field, available)}`;
    if (field.length > available) break;
  }

  return note;
}
