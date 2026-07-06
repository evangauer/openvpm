import {
  formatDateInputForTimeZone,
  formatDateInputLocal,
} from "@/lib/date-input";
import { localeForCountry } from "@/lib/locale/format";
import { isValidClinicalDateInput } from "@/lib/records/date-input";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function localDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

function dateInputDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function dateInputForDifference(
  value: string | Date | null | undefined,
  timeZone?: string | null
): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return timeZone
      ? formatPortalDateInput(value, timeZone)
      : formatDateInputLocal(value);
  }

  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    return isValidClinicalDateInput(trimmed) ? trimmed : null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return timeZone
    ? formatPortalDateInput(parsed, timeZone)
    : formatDateInputLocal(parsed);
}

export function formatPortalDateInputLocal(date = new Date()): string {
  return formatDateInputLocal(date);
}

export function formatPortalDateInput(
  date = new Date(),
  timeZone?: string | null
): string {
  return formatDateInputForTimeZone(date, timeZone);
}

export function parsePortalDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    if (!isValidClinicalDateInput(trimmed)) return null;
    const [year, month, day] = trimmed.split("-").map(Number);
    return new Date(year!, month! - 1, day!);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatPortalDate(
  value: string | Date | null | undefined,
  country?: string | null,
  timeZone?: string | null
): string {
  const date = parsePortalDate(value);
  if (!date) return "N/A";

  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  };

  if (
    timeZone &&
    !(typeof value === "string" && DATE_ONLY_RE.test(value.trim()))
  ) {
    try {
      return date.toLocaleDateString(localeForCountry(country), {
        ...options,
        timeZone,
      });
    } catch {
      // Fall back to the runtime's local date if a saved timezone is invalid.
    }
  }

  return date.toLocaleDateString(localeForCountry(country), options);
}

export function formatPortalDateTime(
  value: string | Date | null | undefined,
  country?: string | null,
  timeZone?: string | null
): string {
  if (!value) return "N/A";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";

  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };

  try {
    return date.toLocaleString(localeForCountry(country), {
      ...options,
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return date.toLocaleString(localeForCountry(country), options);
  }
}

export function portalCalendarDayDifference(
  value: string | Date | null | undefined,
  now = new Date(),
  timeZone?: string | null
): number | null {
  if (!timeZone) {
    const date = parsePortalDate(value);
    if (!date) return null;
    return localDayNumber(date) - localDayNumber(now);
  }

  const dateInput = dateInputForDifference(value, timeZone);
  if (!dateInput) return null;
  const todayInput = formatPortalDateInput(now, timeZone);
  return dateInputDayNumber(dateInput) - dateInputDayNumber(todayInput);
}

export function calculatePortalAge(
  dob: string | Date | null | undefined,
  now = new Date()
): string {
  const birth = parsePortalDate(dob);
  if (!birth) return "Unknown age";

  let totalMonths =
    (now.getFullYear() - birth.getFullYear()) * 12 +
    (now.getMonth() - birth.getMonth());
  if (now.getDate() < birth.getDate()) {
    totalMonths -= 1;
  }
  totalMonths = Math.max(0, totalMonths);

  if (totalMonths < 12) {
    return `${totalMonths} month${totalMonths !== 1 ? "s" : ""} old`;
  }
  const years = Math.floor(totalMonths / 12);
  return `${years} year${years !== 1 ? "s" : ""} old`;
}
