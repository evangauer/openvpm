import {
  CLOSEOUT_FOLLOW_UP_NOTES_MAX_LENGTH,
  CLOSEOUT_INSTRUCTIONS_MAX_LENGTH,
  CLOSEOUT_WARNING_SIGNS_MAX_LENGTH,
} from "./closeout-policy";

export const DISCHARGE_TOOL_PATH = "/tools/discharge-instructions";
export const DISCHARGE_AUTHOR_ROLES = [
  "admin",
  "veterinarian",
  "technician",
] as const;

export const handoutFields = [
  {
    key: "instructions",
    label: "Home care",
    limit: CLOSEOUT_INSTRUCTIONS_MAX_LENGTH,
  },
  {
    key: "warningSigns",
    label: "When to call the clinic",
    limit: CLOSEOUT_WARNING_SIGNS_MAX_LENGTH,
  },
  {
    key: "followUp",
    label: "Follow-up",
    limit: CLOSEOUT_FOLLOW_UP_NOTES_MAX_LENGTH,
  },
] as const;

type HandoutField = (typeof handoutFields)[number]["key"];
export type DischargeHandout = Record<HandoutField, string> & {
  patient: string;
  contact: string;
};

export function handoutSections(draft: DischargeHandout) {
  return handoutFields
    .map(({ key, label }) => ({ label, text: draft[key].trim() }))
    .filter(({ text }) => text.length > 0);
}

export function handoutText(practice: string, draft: DischargeHandout) {
  return [
    `Discharge instructions for ${draft.patient.trim()}`,
    [practice, draft.contact.trim()].filter(Boolean).join("\n"),
    ...handoutSections(draft).map(({ label, text }) => `${label}\n${text}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}
