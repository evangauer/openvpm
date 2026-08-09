export function formatDateInputLocal(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type ZonedPartType = "year" | "month" | "day" | "hour" | "minute" | "second";

function normalizeTimeZone(timeZone?: string | null): string | null {
  const normalized = timeZone?.trim();
  return normalized ? normalized : null;
}

function timeZoneDateTimeParts(
  date: Date,
  timeZone: string
): ZonedDateParts | null {
  try {
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
    const value = (type: ZonedPartType) =>
      parts.find((part) => part.type === type)?.value;
    const year = Number(value("year"));
    const month = Number(value("month"));
    const day = Number(value("day"));
    const hour = Number(value("hour"));
    const minute = Number(value("minute"));
    const second = Number(value("second"));

    if ([year, month, day, hour, minute, second].some(Number.isNaN)) {
      return null;
    }

    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

function datePartsToUtc(parts: ZonedDateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
}

function dateInputPlusDays(dateInput: string, days: number): string {
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function utcInstantForTimeZoneDateTime(
  target: ZonedDateParts,
  timeZone?: string | null
): Date {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  if (!normalizedTimeZone) {
    return new Date(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
      target.second,
      0
    );
  }

  const desired = datePartsToUtc(target);
  let instant = new Date(desired);

  for (let i = 0; i < 3; i += 1) {
    const actualParts = timeZoneDateTimeParts(instant, normalizedTimeZone);
    if (!actualParts) {
      return new Date(
        target.year,
        target.month - 1,
        target.day,
        target.hour,
        target.minute,
        target.second,
        0
      );
    }

    const delta = desired - datePartsToUtc(actualParts);
    if (delta === 0) {
      return instant;
    }

    instant = new Date(instant.getTime() + delta);
  }

  return instant;
}

export function formatDateInputForTimeZone(
  date = new Date(),
  timeZone?: string | null
): string {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  if (!normalizedTimeZone) return formatDateInputLocal(date);

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: normalizedTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fall back to the runtime's local day if a saved timezone is invalid.
  }

  return formatDateInputLocal(date);
}

export function dateInputUtcRangeForTimeZone(
  date = new Date(),
  timeZone?: string | null
): { date: string; start: Date; end: Date } {
  const dateInput = formatDateInputForTimeZone(date, timeZone);
  return dateInputDayUtcRange(dateInput, timeZone);
}

export function dateInputDayUtcRange(
  dateInput: string,
  timeZone?: string | null
): { date: string; start: Date; end: Date } {
  const nextDateInput = dateInputPlusDays(dateInput, 1);
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [nextYear, nextMonth, nextDay] = nextDateInput.split("-").map(
    Number
  ) as [number, number, number];

  return {
    date: dateInput,
    start: utcInstantForTimeZoneDateTime(
      { year, month, day, hour: 0, minute: 0, second: 0 },
      timeZone
    ),
    end: utcInstantForTimeZoneDateTime(
      {
        year: nextYear,
        month: nextMonth,
        day: nextDay,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone
    ),
  };
}

export function dateInputTimeUtcInstant(
  dateInput: string,
  time: { hour: number; minute?: number; second?: number },
  timeZone?: string | null
): Date {
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];

  return utcInstantForTimeZoneDateTime(
    {
      year,
      month,
      day,
      hour: time.hour,
      minute: time.minute ?? 0,
      second: time.second ?? 0,
    },
    timeZone
  );
}

/** Parse a browser datetime-local value as clinic wall time, never workstation time. */
export function dateTimeLocalInputUtcInstant(
  value: string,
  timeZone?: string | null,
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target: ZonedDateParts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0,
  };
  if (
    target.month < 1 ||
    target.month > 12 ||
    target.day < 1 ||
    target.day > 31 ||
    target.hour < 0 ||
    target.hour > 23 ||
    target.minute < 0 ||
    target.minute > 59
  ) return null;
  const calendarCheck = new Date(Date.UTC(target.year, target.month - 1, target.day));
  if (
    calendarCheck.getUTCFullYear() !== target.year ||
    calendarCheck.getUTCMonth() !== target.month - 1 ||
    calendarCheck.getUTCDate() !== target.day
  ) return null;

  const instant = dateInputTimeUtcInstant(
    `${yearText}-${monthText}-${dayText}`,
    { hour: target.hour, minute: target.minute },
    timeZone,
  );
  if (Number.isNaN(instant.getTime())) return null;

  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const roundTrip = normalizedTimeZone
    ? timeZoneDateTimeParts(instant, normalizedTimeZone)
    : {
        year: instant.getFullYear(),
        month: instant.getMonth() + 1,
        day: instant.getDate(),
        hour: instant.getHours(),
        minute: instant.getMinutes(),
        second: instant.getSeconds(),
      };
  if (
    !roundTrip ||
    roundTrip.year !== target.year ||
    roundTrip.month !== target.month ||
    roundTrip.day !== target.day ||
    roundTrip.hour !== target.hour ||
    roundTrip.minute !== target.minute
  ) return null;
  return instant;
}

export function formatDateTimeLocalInputForTimeZone(
  value: Date | string | null | undefined,
  timeZone?: string | null,
): string {
  if (!value || !normalizeTimeZone(timeZone)) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = timeZoneDateTimeParts(date, timeZone!.trim());
  if (!parts) return "";
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
