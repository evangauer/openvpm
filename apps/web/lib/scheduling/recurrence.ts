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
  // The first visit is exactly what staff booked, even in a repeated hour.
  if (n === 0) return new Date(baseDate.getTime());
  const resolvedTimeZone = resolveRecurrenceTimeZone(timeZone);
  const base = recurrenceBaseParts(baseDate, resolvedTimeZone);
  const occurrenceDate = recurrenceDateInput(
    base.dateInput,
    frequency,
    interval,
    n,
  );

  return wallClockInstant(
    occurrenceDate,
    { hour: base.hour, minute: base.minute, second: base.second },
    resolvedTimeZone,
  );
}

/**
 * Resolve a practice wall-clock time to an instant with fixed DST rules,
 * independent of which side of UTC the zone is on:
 * - a time skipped by spring-forward moves later by the gap (2:30 → 3:30);
 * - a time repeated at fall-back uses its first occurrence.
 * Both candidates come from the zone's offsets a day before and after.
 */
function wallClockInstant(
  dateInput: string,
  time: { hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const wallMs = Date.UTC(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    time.second,
  );
  const DAY_MS = 24 * 60 * 60 * 1000;
  const offsetBefore = timeZoneOffsetMs(new Date(wallMs - DAY_MS), timeZone);
  const offsetAfter = timeZoneOffsetMs(new Date(wallMs + DAY_MS), timeZone);
  if (offsetBefore === null || offsetAfter === null) {
    return dateInputTimeUtcInstant(dateInput, time, timeZone);
  }

  const valid = [wallMs - offsetBefore, wallMs - offsetAfter]
    .filter(
      (instant) =>
        timeZoneOffsetMs(new Date(instant), timeZone) === wallMs - instant,
    )
    .sort((a, b) => a - b);
  // Repeated time: the earliest instant. Skipped time: read it with the
  // offset in effect before the change, which lands after the gap.
  return new Date(valid[0] ?? wallMs - offsetBefore);
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  if (Number.isNaN(local)) return null;
  // Intl reports whole seconds; drop the instant's milliseconds to match.
  return local - Math.floor(instant.getTime() / 1000) * 1000;
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
