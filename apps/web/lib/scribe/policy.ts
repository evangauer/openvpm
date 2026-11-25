import type { SoapDraft } from "@/lib/ai/soap-draft";

/**
 * Limits and formatting shared by the Scribe page and its server route. Kept
 * free of server-only imports so the page can use it.
 */

/** Room for a full 45-minute recording of fast conversation. */
export const SCRIBE_TRANSCRIPT_MAX_LENGTH = 60_000;
/** How much of the transcript so far is sent along with the next segment. */
export const SCRIBE_PREVIOUS_TAIL_LENGTH = 400;
export const SCRIBE_PATIENT_NAME_MAX_LENGTH = 120;
export const SCRIBE_SPECIES_MAX_LENGTH = 60;

export const SCRIBE_SECTIONS = [
  { key: "subjective", label: "Subjective" },
  { key: "objective", label: "Objective" },
  { key: "assessment", label: "Assessment" },
  { key: "plan", label: "Plan" },
] as const satisfies ReadonlyArray<{ key: keyof SoapDraft; label: string }>;

/** Plain-text note for pasting into another record system. */
export function formatScribeNote(draft: SoapDraft): string {
  return SCRIBE_SECTIONS.filter(({ key }) => draft[key].trim().length > 0)
    .map(({ key, label }) => `${label}\n${draft[key].trim()}`)
    .join("\n\n");
}
