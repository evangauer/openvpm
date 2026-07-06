/**
 * Pure import planning for dry-runs: given already-parsed records and the keys
 * that already exist in the practice, report what an import WOULD do without
 * touching the database. Lets a clinic validate a migration safely first.
 */

export interface ClientImportPlan {
  total: number;
  willInsert: number;
  duplicates: number;
}

/** Duplicate = a record whose email already exists in the practice. */
export function planClientImport(
  records: { email?: string }[],
  existingEmails: Set<string>
): ClientImportPlan {
  const normalized = new Set([...existingEmails].map((e) => e.toLowerCase()));
  let duplicates = 0;
  for (const r of records) {
    const email = r.email?.trim().toLowerCase();
    if (!email) continue;
    if (normalized.has(email)) {
      duplicates++;
      continue;
    }
    normalized.add(email);
  }
  return {
    total: records.length,
    duplicates,
    willInsert: records.length - duplicates,
  };
}

export interface PatientImportPlan {
  total: number;
  willInsert: number;
  unmatchedClient: number;
}

/** Referential integrity: a pet can only import if its owner already exists. */
export function planPatientImport(
  records: { clientEmail: string }[],
  existingClientEmails: Set<string>
): PatientImportPlan {
  const normalized = new Set([...existingClientEmails].map((e) => e.toLowerCase()));
  let unmatched = 0;
  for (const r of records) {
    if (!normalized.has(r.clientEmail.toLowerCase())) unmatched++;
  }
  return {
    total: records.length,
    unmatchedClient: unmatched,
    willInsert: records.length - unmatched,
  };
}
