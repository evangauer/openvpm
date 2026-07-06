import { formatDateInputForTimeZone } from "@/lib/date-input";

export type CalendarView = "day" | "week" | "month";

export interface CalendarDay {
  date: Date;
  dateKey: string;
  isCurrentMonth: boolean;
  isToday: boolean;
}

export function toISODate(date: Date, timeZone?: string | null): string {
  if (timeZone) return formatDateInputForTimeZone(date, timeZone);

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfCalendarDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfCalendarDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addCalendarDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addCalendarMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const originalDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTargetMonth = new Date(
    d.getFullYear(),
    d.getMonth() + 1,
    0
  ).getDate();
  d.setDate(Math.min(originalDay, daysInTargetMonth));
  return d;
}

export function startOfWeek(date: Date, weekStartsOn = 0): Date {
  const d = startOfCalendarDay(date);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

export function endOfWeek(date: Date, weekStartsOn = 0): Date {
  return endOfCalendarDay(addCalendarDays(startOfWeek(date, weekStartsOn), 6));
}

export function startOfMonthGrid(date: Date, weekStartsOn = 0): Date {
  return startOfWeek(
    new Date(date.getFullYear(), date.getMonth(), 1),
    weekStartsOn
  );
}

export function buildWeekDays(date: Date, weekStartsOn = 0): Date[] {
  const start = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_, index) =>
    addCalendarDays(start, index)
  );
}

export function buildMonthGrid(date: Date, weekStartsOn = 0): CalendarDay[] {
  const todayKey = toISODate(new Date());
  const currentMonth = date.getMonth();
  const start = startOfMonthGrid(date, weekStartsOn);

  return Array.from({ length: 42 }, (_, index) => {
    const day = addCalendarDays(start, index);
    const dateKey = toISODate(day);
    return {
      date: day,
      dateKey,
      isCurrentMonth: day.getMonth() === currentMonth,
      isToday: dateKey === todayKey,
    };
  });
}

export function getCalendarRange(
  date: Date,
  view: CalendarView,
  weekStartsOn = 0
): { start: Date; end: Date } {
  if (view === "week") {
    return {
      start: startOfWeek(date, weekStartsOn),
      end: endOfWeek(date, weekStartsOn),
    };
  }

  if (view === "month") {
    const grid = buildMonthGrid(date, weekStartsOn);
    return {
      start: startOfCalendarDay(grid[0]!.date),
      end: endOfCalendarDay(grid[grid.length - 1]!.date),
    };
  }

  return {
    start: startOfCalendarDay(date),
    end: endOfCalendarDay(date),
  };
}

export function isSameCalendarDay(a: Date, b: Date): boolean {
  return toISODate(a) === toISODate(b);
}

export function groupByCalendarDate<T>(
  items: readonly T[],
  getDate: (item: T) => Date | string,
  timeZone?: string | null
): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const rawDate = getDate(item);
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    const key = toISODate(date, timeZone);
    groups[key] ??= [];
    groups[key]!.push(item);
    return groups;
  }, {});
}
