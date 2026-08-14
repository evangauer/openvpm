import {
  dateInputDayUtcRange,
  formatDateInputForTimeZone,
} from "@/lib/date-input";

const DAY_MS = 24 * 60 * 60 * 1000;

/** End a trial at the close of its final clinic calendar day. */
export function trialEndOfCalendarDay(
  days: number,
  timeZone = "America/New_York",
  now: Date = new Date(),
): Date {
  const nominalEnd = new Date(now.getTime() + Math.max(0, days) * DAY_MS);
  const finalDay = formatDateInputForTimeZone(nominalEnd, timeZone);
  const { end } = dateInputDayUtcRange(finalDay, timeZone);
  return new Date(end.getTime() - 1_000);
}

function validTimeZone(timeZone?: string | null): string {
  const resolved = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format(
      new Date(0)
    );
    return resolved;
  } catch {
    return "UTC";
  }
}

function dateInputToUtcMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

export function trialCalendarDaysLeft(
  trialEndsAt: Date | string | null | undefined,
  timeZone?: string | null,
  now: Date = new Date()
): number | null {
  if (!trialEndsAt) return null;

  const end = trialEndsAt instanceof Date ? trialEndsAt : new Date(trialEndsAt);
  if (Number.isNaN(end.getTime()) || Number.isNaN(now.getTime())) return null;

  const resolvedTimeZone = validTimeZone(timeZone);
  const endDay = formatDateInputForTimeZone(end, resolvedTimeZone);
  const nowDay = formatDateInputForTimeZone(now, resolvedTimeZone);
  const endMs = dateInputToUtcMs(endDay);
  const nowMs = dateInputToUtcMs(nowDay);
  if (endMs === null || nowMs === null) return null;

  return Math.max(0, Math.round((endMs - nowMs) / DAY_MS));
}
