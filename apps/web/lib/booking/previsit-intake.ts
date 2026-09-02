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

/**
 * Preflights the complete public-request handoff before any persistence.
 * Accepted content is never truncated or omitted. Reason and service address
 * always precede the remaining history in the compiled appointment note.
 */
export function preflightOnlineBookingAppointmentNote(input: {
  reason: string;
  intake?: PrevisitIntake;
}):
  | { ok: true; note: string }
  | { ok: false; message: string; overBy: number; maxLength: number } {
  const prefix = "[Online request] ";
  const reason = normalizeForNote(input.reason);
  let note = `${prefix}${reason}`;

  const serviceAddress = input.intake?.serviceAddress
    ? normalizeForNote(input.intake.serviceAddress)
    : "";
  if (serviceAddress) {
    note += ` | Service/farm address (owner-reported): ${serviceAddress}`;
  }

  const reportedFields = input.intake
    ? DISPLAY_FIELDS.flatMap(({ key, label }) => {
        const value = input.intake?.[key];
        if (!value) return [];
        const normalized = normalizeForNote(value);
        return normalized ? [`${label}: ${normalized}`] : [];
      })
    : [];

  if (reportedFields.length > 0) {
    note += ` | Client-reported pre-visit history (unverified): ${reportedFields.join(" • ")}`;
  }

  if (note.length > APPOINTMENT_NOTES_MAX_LENGTH) {
    const overBy = note.length - APPOINTMENT_NOTES_MAX_LENGTH;
    return {
      ok: false,
      message: `Visit details are too long to send. Shorten the visit reason or optional intake answers by at least ${overBy} character${overBy === 1 ? "" : "s"}.`,
      overBy,
      maxLength: APPOINTMENT_NOTES_MAX_LENGTH,
    };
  }

  return { ok: true, note };
}
