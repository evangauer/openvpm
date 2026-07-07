import {
  dateInputDayUtcRange,
  formatDateInputForTimeZone,
} from "@/lib/date-input";

const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MAX_REPORT_RANGE_DAYS = 366;

export type ReportDateRangeInput = {
  startDate?: string;
  endDate?: string;
} | null | undefined;

export type ReportDatePreset = "last30" | "month" | "lastMonth" | "year";

export type ResolvedReportDateRange = {
  startDate: string;
  endDate: string;
  start: Date;
  end: Date;
  endExclusive: Date;
  days: number;
  previousStartDate: string;
  previousEndDate: string;
  previousStart: Date;
  previousEnd: Date;
  previousEndExclusive: Date;
  timeZone: string | null;
};

export function formatReportDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOnlyUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateInputParts(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return [year, month, day];
}

function dateInputFromUtc(year: number, month: number, day: number): string {
  return formatReportDateInput(new Date(Date.UTC(year, month - 1, day)));
}

function addDateInputDays(dateInput: string, days: number): string {
  const [year, month, day] = dateInputParts(dateInput);
  return dateInputFromUtc(year, month, day + days);
}

function monthStart(dateInput: string): string {
  const [year, month] = dateInputParts(dateInput);
  return dateInputFromUtc(year, month, 1);
}

function previousMonthRange(dateInput: string): {
  startDate: string;
  endDate: string;
} {
  const [year, month] = dateInputParts(dateInput);
  return {
    startDate: dateInputFromUtc(year, month - 1, 1),
    endDate: dateInputFromUtc(year, month, 0),
  };
}

function yearStart(dateInput: string): string {
  const [year] = dateInputParts(dateInput);
  return dateInputFromUtc(year, 1, 1);
}

function assertDateInput(value: string, label: string) {
  const parsed = dateOnlyUtc(value);
  if (
    !DATE_INPUT_RE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    formatReportDateInput(parsed) !== value
  ) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
}

export function validateReportDateRangeInput(input: ReportDateRangeInput) {
  if (input?.startDate) assertDateInput(input.startDate, "Start date");
  if (input?.endDate) assertDateInput(input.endDate, "End date");

  if (!input?.startDate || !input?.endDate) return;

  const start = dateOnlyUtc(input.startDate);
  const end = dateOnlyUtc(input.endDate);

  if (start.getTime() > end.getTime()) {
    throw new Error("Start date must be on or before end date");
  }

  const days = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (days > MAX_REPORT_RANGE_DAYS) {
    throw new Error(
      `Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`
    );
  }
}

export function reportDateRangeInputError(
  input: ReportDateRangeInput
): string | null {
  if (!input?.startDate) return "Start date is required";
  if (!input?.endDate) return "End date is required";

  try {
    validateReportDateRangeInput(input);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid report date range";
  }
}

export function isCompleteReportDateRangeInputValid(
  input: ReportDateRangeInput
): boolean {
  return reportDateRangeInputError(input) === null;
}

export function defaultReportDateRange(
  now = new Date(),
  timeZone?: string | null
): {
  startDate: string;
  endDate: string;
} {
  return reportPresetDateRange("last30", now, timeZone);
}

export function reportPresetDateRange(
  preset: ReportDatePreset,
  now = new Date(),
  timeZone?: string | null
): {
  startDate: string;
  endDate: string;
} {
  const today = formatDateInputForTimeZone(now, timeZone ?? "UTC");

  if (preset === "last30") {
    return {
      startDate: addDateInputDays(today, -29),
      endDate: today,
    };
  }

  if (preset === "month") {
    return {
      startDate: monthStart(today),
      endDate: today,
    };
  }

  if (preset === "lastMonth") {
    return previousMonthRange(today);
  }

  return {
    startDate: yearStart(today),
    endDate: today,
  };
}

/**
 * Expand a sparse per-day series to one point per day across the range so
 * charts draw a continuous line instead of floating dots. Ranges are capped
 * at MAX_REPORT_RANGE_DAYS, bounding the output.
 */
export function zeroFillDailySeries(
  daily: Array<{ date: string; amount: number }>,
  startDate: string,
  endDate: string
): Array<{ date: string; amount: number }> {
  const byDate = new Map(daily.map((d) => [d.date, d.amount]));
  const filled: Array<{ date: string; amount: number }> = [];
  for (
    let date = startDate;
    date <= endDate;
    date = addDateInputDays(date, 1)
  ) {
    filled.push({ date, amount: byDate.get(date) ?? 0 });
  }
  return filled;
}

export function resolveReportDateRange(
  input: ReportDateRangeInput,
  now = new Date(),
  timeZone?: string | null
): ResolvedReportDateRange {
  validateReportDateRangeInput(input);

  const reportTimeZone = timeZone ?? "UTC";
  const defaults = defaultReportDateRange(now, reportTimeZone);
  const startDate = input?.startDate ?? defaults.startDate;
  const endDate = input?.endDate ?? defaults.endDate;

  assertDateInput(startDate, "Start date");
  assertDateInput(endDate, "End date");

  const start = dateOnlyUtc(startDate);
  const endDay = dateOnlyUtc(endDate);

  if (start.getTime() > endDay.getTime()) {
    throw new Error("Start date must be on or before end date");
  }

  const days = Math.round((endDay.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (days > MAX_REPORT_RANGE_DAYS) {
    throw new Error(
      `Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`
    );
  }

  const previousEndDay = addUtcDays(start, -1);
  const previousStartDay = addUtcDays(previousEndDay, -(days - 1));
  const previousStartDate = formatReportDateInput(previousStartDay);
  const previousEndDate = formatReportDateInput(previousEndDay);
  const startRange = dateInputDayUtcRange(startDate, reportTimeZone);
  const endRange = dateInputDayUtcRange(endDate, reportTimeZone);
  const previousStartRange = dateInputDayUtcRange(
    previousStartDate,
    reportTimeZone
  );
  const previousEndRange = dateInputDayUtcRange(
    previousEndDate,
    reportTimeZone
  );

  return {
    startDate,
    endDate,
    start: startRange.start,
    end: new Date(endRange.end.getTime() - 1),
    endExclusive: endRange.end,
    days,
    previousStartDate,
    previousEndDate,
    previousStart: previousStartRange.start,
    previousEnd: new Date(previousEndRange.end.getTime() - 1),
    previousEndExclusive: previousEndRange.end,
    timeZone: reportTimeZone,
  };
}
