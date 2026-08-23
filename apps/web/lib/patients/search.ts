export const PATIENT_SEARCH_MAX_TOKENS = 8;

export function normalizePatientSearchPhrase(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function patientSearchTokens(value: string): string[] {
  const normalized = normalizePatientSearchPhrase(value);
  if (!normalized) return [];

  return [...new Set(normalized.split(" "))];
}

export function hasBoundedPatientSearchTokens(value: string): boolean {
  return patientSearchTokens(value).length <= PATIENT_SEARCH_MAX_TOKENS;
}

/** Escape PostgreSQL LIKE metacharacters before the server adds wildcards. */
export function escapePatientSearchToken(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function patientSearchContainsPattern(token: string): string {
  return `%${escapePatientSearchToken(token)}%`;
}
