import { formatDateInputForTimeZone } from "@/lib/date-input";
import { isValidClinicalDateInput } from "@/lib/records/date-input";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const CLINICAL_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

const CLINICAL_DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  ...CLINICAL_DATE_FORMAT,
  hour: "numeric",
  minute: "2-digit",
};

function dateOnlyToUtcDate(value: string): Date | null {
  if (!DATE_ONLY_RE.test(value) || !isValidClinicalDateInput(value)) {
    return null;
  }
  return new Date(`${value}T00:00:00.000Z`);
}

function parseClinicalInstant(
  value: Date | string | null | undefined
): Date | null {
  if (!value) return null;
  if (typeof value === "string") {
    const dateOnly = dateOnlyToUtcDate(value.trim());
    if (dateOnly) return dateOnly;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWithTimeZone(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone?: string | null
): string {
  try {
    return date.toLocaleDateString("en-US", {
      ...options,
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return date.toLocaleDateString("en-US", options);
  }
}

export function formatClinicalDate(
  value: Date | string | null | undefined,
  timeZone?: string | null,
  fallback = "--"
): string {
  if (!value) return fallback;

  if (typeof value === "string") {
    const dateOnly = dateOnlyToUtcDate(value.trim());
    if (dateOnly) {
      return formatWithTimeZone(dateOnly, CLINICAL_DATE_FORMAT, "UTC");
    }
  }

  const date = parseClinicalInstant(value);
  if (!date) return fallback;
  return formatWithTimeZone(date, CLINICAL_DATE_FORMAT, timeZone);
}

export function formatClinicalDateTime(
  value: Date | string | null | undefined,
  timeZone?: string | null,
  fallback = "--"
): string {
  if (!value) return fallback;

  if (typeof value === "string") {
    const dateOnly = dateOnlyToUtcDate(value.trim());
    if (dateOnly) return formatClinicalDate(value, timeZone, fallback);
  }

  const date = parseClinicalInstant(value);
  if (!date) return fallback;

  try {
    return date.toLocaleString("en-US", {
      ...CLINICAL_DATE_TIME_FORMAT,
      timeZone: timeZone ?? undefined,
    });
  } catch {
    return date.toLocaleString("en-US", CLINICAL_DATE_TIME_FORMAT);
  }
}

export function clinicalDateKey(
  value: Date | string | null | undefined,
  timeZone?: string | null
): string | null {
  const date = parseClinicalInstant(value);
  if (!date) return null;
  if (typeof value === "string" && dateOnlyToUtcDate(value.trim())) {
    return value.trim();
  }
  return formatDateInputForTimeZone(date, timeZone);
}

export function clinicalDateLabel(
  value: Date | string | null | undefined,
  timeZone?: string | null
): string | null {
  const date = parseClinicalInstant(value);
  if (!date) return null;
  if (typeof value === "string" && dateOnlyToUtcDate(value.trim())) {
    return formatWithTimeZone(date, { month: "short", day: "numeric" }, "UTC");
  }
  return formatWithTimeZone(date, { month: "short", day: "numeric" }, timeZone);
}
