export const PATIENT_NOTE_MAX_LENGTH = 20_000;
export const PATIENT_NOTE_TYPES = [
  "general",
  "follow_up",
  "phone_call",
] as const;
export const PATIENT_NOTE_LABELS = {
  general: "General note",
  follow_up: "Follow-up",
  phone_call: "Phone call",
} as const;
