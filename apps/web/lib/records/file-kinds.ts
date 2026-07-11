/**
 * Patient files land in one `files` table differentiated by `category`
 * (where the upload came from) and mime type. These helpers are the single
 * source of truth for sorting that bucket into what the UI treats as
 * photos, signed consents, and other documents.
 */

/** Category written by QR capture uploads and patient photo uploads. */
export const PATIENT_PHOTO_CATEGORY = "patient-photos";
/** Category written when a consent request is signed (signed PDF). */
export const CONSENT_FILE_CATEGORY = "consents";

export type PatientFileKind = "photo" | "consent" | "document";

export function patientFileKind(file: {
  category: string | null;
  mimeType: string | null;
}): PatientFileKind {
  if (file.category === CONSENT_FILE_CATEGORY) return "consent";
  if (file.mimeType?.startsWith("image/")) return "photo";
  return "document";
}

/** Human label for a file row: signed consents show what was signed. */
export function patientFileLabel(file: {
  category: string | null;
  mimeType: string | null;
  fileName: string;
  consentTitle?: string | null;
}): string {
  if (patientFileKind(file) === "consent" && file.consentTitle) {
    return file.consentTitle;
  }
  return file.fileName;
}
