export const PATIENT_HISTORY_RECORD_TYPES = [
  "soap_note",
  "prescription",
  "vaccination",
  "lab_result",
  "procedure",
  "problem",
  "vital_sign",
  "allergy",
] as const;

export type PatientHistoryRecordType =
  (typeof PATIENT_HISTORY_RECORD_TYPES)[number];

export const PATIENT_HISTORY_STATE_FILTERS = [
  "all",
  "current",
  "corrected",
] as const;

export type PatientHistoryStateFilter =
  (typeof PATIENT_HISTORY_STATE_FILTERS)[number];

export const PATIENT_HISTORY_DEFAULT_PAGE_SIZE = 25;
export const PATIENT_HISTORY_MAX_PAGE_SIZE = 50;
export const PATIENT_HISTORY_QUERY_MAX_LENGTH = 120;

/** Escape PostgreSQL LIKE metacharacters before the query adds wildcards. */
export function escapePatientHistoryQuery(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function patientHistoryContainsPattern(value: string): string {
  return `%${escapePatientHistoryQuery(value.trim())}%`;
}
