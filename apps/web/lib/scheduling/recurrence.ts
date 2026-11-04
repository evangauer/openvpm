import {
  dateInputTimeUtcInstant,
  formatDateInputForTimeZone,
} from "@/lib/date-input";

export type RecurrenceFrequency = "weekly" | "monthly" | "annual";

/**
 * Compute the start instant of the Nth occurrence (0-based) of a series.
 *
 * Occurrences are computed in the practice's wall clock: the date advances on
 * the local calendar and the local time of day is kept, so a 9:00 AM visit
 * stays at 9:00 AM across daylight-saving changes. Every occurrence is
 * derived from the series start (not the previous occurrence), so a monthly
 * series on the 31st clamps to shorter month ends without drifting.
 */
export function computeOccurrenceDate(
  baseDate: Date,
  frequency: RecurrenceFrequency,
  interval: number,
  n: number,
  timeZone?: string | null,
): Date {
  const resolvedTimeZone = resolveRecurrenceTimeZone(timeZone);
  const base = recurrenceBaseParts(baseDate, resolvedTimeZone);
  const occurrenceDate = recurrenceDateInput(
    base.dateInput,
    frequency,
    interval,
    n,
  );

  return dateInputTimeUtcInstant(
    occurrenceDate,
    {
      hour: base.hour,
      minute: base.minute,
      second: base.second,
    },
    resolvedTimeZone,
  );
}

export function resolveRecurrenceTimeZone(timeZone?: string | null): string {
  const resolved = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format(
      new Date(0),
    );
    return resolved;
  } catch {
    return "UTC";
  }
}

function recurrenceBaseParts(
  date: Date,
  timeZone: string,
): { dateInput: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const second = Number(value("second"));

  if (!year || !month || !day || [hour, minute, second].some(Number.isNaN)) {
    const fallback = new Date(date);
    return {
      dateInput: formatDateInputForTimeZone(fallback, "UTC"),
      hour: fallback.getUTCHours(),
      minute: fallback.getUTCMinutes(),
      second: fallback.getUTCSeconds(),
    };
  }

  return {
    dateInput: `${year}-${month}-${day}`,
    hour,
    minute,
    second,
  };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Advance a YYYY-MM-DD calendar date by N recurrence steps. Monthly and annual
 * steps clamp to the last day of the target month (Jan 31 → Feb 28/29,
 * Feb 29 → Feb 28 in common years) instead of overflowing into the next month.
 */
export function recurrenceDateInput(
  baseDateInput: string,
  frequency: RecurrenceFrequency,
  interval: number,
  n: number,
): string {
  const [year, month, day] = baseDateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  if (frequency === "weekly") {
    const d = new Date(Date.UTC(year, month - 1, day + 7 * interval * n));
    return formatDateInputForTimeZone(d, "UTC");
  }

  const monthsToAdd = (frequency === "monthly" ? 1 : 12) * interval * n;
  const totalMonths = year * 12 + (month - 1) + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths - targetYear * 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonthIndex));
  return formatDateInputForTimeZone(
    new Date(Date.UTC(targetYear, targetMonthIndex, targetDay)),
    "UTC",
  );
}
