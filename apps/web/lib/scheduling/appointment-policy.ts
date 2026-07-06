import { isValidClinicalDateInput } from "@/lib/records/clinical-inputs";

export const APPOINTMENT_NOTES_MAX_LENGTH = 2000;
export const APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH = 128;
export const APPOINTMENT_DURATION_MIN_MINUTES = 5;
export const APPOINTMENT_DURATION_MAX_MINUTES = 480;
export const APPOINTMENT_DURATION_STEP_MINUTES = 5;
export const APPOINTMENT_RECURRENCE_INTERVAL_MIN = 1;
export const APPOINTMENT_RECURRENCE_INTERVAL_MAX = 12;
export const APPOINTMENT_RECURRENCE_OCCURRENCES_MIN = 1;
export const APPOINTMENT_RECURRENCE_OCCURRENCES_MAX = 52;

export function isAppointmentNotesInputValid(value: string): boolean {
  return value.trim().length <= APPOINTMENT_NOTES_MAX_LENGTH;
}

export function isAppointmentPatientSearchInputValid(value: string): boolean {
  return value.trim().length <= APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH;
}

export function isAppointmentDurationInputValid(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= APPOINTMENT_DURATION_MIN_MINUTES &&
    value <= APPOINTMENT_DURATION_MAX_MINUTES
  );
}

export function isAppointmentRecurrenceIntervalInputValid(
  value: number
): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= APPOINTMENT_RECURRENCE_INTERVAL_MIN &&
    value <= APPOINTMENT_RECURRENCE_INTERVAL_MAX
  );
}

export function isAppointmentRecurrenceOccurrencesInputValid(
  value: number
): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= APPOINTMENT_RECURRENCE_OCCURRENCES_MIN &&
    value <= APPOINTMENT_RECURRENCE_OCCURRENCES_MAX
  );
}

export function isAppointmentDateInputValid(value: string): boolean {
  return isValidClinicalDateInput(value);
}

export function appointmentDurationMinutes(
  startTime: string,
  endTime: string
): number | null {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end.getTime() - start.getTime();
  if (!Number.isFinite(diffMs)) return null;
  return diffMs / 60000;
}

export function isAppointmentDateTimeRangeValid(
  startTime: string,
  endTime: string
): boolean {
  const duration = appointmentDurationMinutes(startTime, endTime);
  return duration !== null && isAppointmentDurationInputValid(duration);
}
