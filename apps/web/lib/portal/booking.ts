/**
 * Pure helpers for client-portal self-service booking. No I/O — the portal
 * router validates ownership and persists; this just turns a requested
 * date + time + duration into a concrete slot and guards the inputs.
 */

import { dateInputTimeUtcInstant } from "@/lib/date-input";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_DURATION_MIN = 30;
export const PORTAL_BOOKING_MIN_DURATION_MINUTES = 5;
export const PORTAL_BOOKING_MAX_DURATION_MINUTES = 480;
export const PORTAL_BOOKING_DAY_START_HOUR = 8;
export const PORTAL_BOOKING_DAY_END_HOUR = 18;
export const PORTAL_BOOKING_REASON_MAX_LENGTH = 1000;

function isValidDateInput(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(`${value}T00:00:00`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getFullYear() === year &&
    parsed.getMonth() + 1 === month &&
    parsed.getDate() === day
  );
}

export interface SlotInput {
  /** "YYYY-MM-DD" */
  preferredDate: string;
  /** 24h "HH:MM" */
  preferredTime: string;
  durationMinutes?: number;
  /** Injected for testability; defaults to now in the router. */
  now?: Date;
  /** IANA timezone for the practice that owns the portal link. */
  timeZone?: string | null;
}

export interface Slot {
  startTime: Date;
  endTime: Date;
}

function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function portalBookingWindow(
  date: string,
  timeZone?: string | null
): {
  dayStart: Date;
  dayEnd: Date;
} {
  if (!isValidDateInput(date)) {
    throw new Error("preferredDate must be a valid YYYY-MM-DD date.");
  }

  return {
    dayStart: dateInputTimeUtcInstant(
      date,
      { hour: PORTAL_BOOKING_DAY_START_HOUR },
      timeZone
    ),
    dayEnd: dateInputTimeUtcInstant(
      date,
      { hour: PORTAL_BOOKING_DAY_END_HOUR },
      timeZone
    ),
  };
}

export function portalBookingTimeBounds(durationMinutes = DEFAULT_DURATION_MIN): {
  minTime: string;
  maxTime: string | null;
} {
  const duration = durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION_MIN;
  const openingMinutes = PORTAL_BOOKING_DAY_START_HOUR * 60;
  const latestStartMinutes = PORTAL_BOOKING_DAY_END_HOUR * 60 - duration;

  return {
    minTime: minutesToTime(openingMinutes),
    maxTime:
      latestStartMinutes >= openingMinutes
        ? minutesToTime(latestStartMinutes)
        : null,
  };
}

export function isPortalBookingStartWithinBounds(
  preferredTime: string,
  durationMinutes = DEFAULT_DURATION_MIN
): boolean {
  if (!TIME_RE.test(preferredTime)) return false;

  const bounds = portalBookingTimeBounds(durationMinutes);
  return Boolean(
    bounds.maxTime &&
      preferredTime >= bounds.minTime &&
      preferredTime <= bounds.maxTime
  );
}

export function isPortalBookingReasonValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= PORTAL_BOOKING_REASON_MAX_LENGTH
  );
}

export function assertSlotWithinPortalBookingHours(
  slot: Slot,
  date: string,
  timeZone?: string | null
): void {
  const { dayStart, dayEnd } = portalBookingWindow(date, timeZone);
  if (slot.startTime < dayStart || slot.endTime > dayEnd) {
    throw new Error(
      `Please choose a time between ${String(PORTAL_BOOKING_DAY_START_HOUR).padStart(
        2,
        "0"
      )}:00 and ${String(PORTAL_BOOKING_DAY_END_HOUR).padStart(2, "0")}:00.`
    );
  }
}

export function filterFutureOpenSlots<T extends { start: Date }>(
  slots: T[],
  now = new Date()
): T[] {
  return slots.filter((slot) => slot.start.getTime() > now.getTime());
}

export function buildRequestedSlot(input: SlotInput): Slot {
  if (!isValidDateInput(input.preferredDate)) {
    throw new Error("preferredDate must be a valid YYYY-MM-DD date.");
  }
  if (!TIME_RE.test(input.preferredTime)) {
    throw new Error("preferredTime must be in 24-hour HH:MM format.");
  }

  const [hour, minute] = input.preferredTime.split(":").map(Number) as [
    number,
    number,
  ];
  const startTime = dateInputTimeUtcInstant(
    input.preferredDate,
    { hour, minute },
    input.timeZone
  );
  if (Number.isNaN(startTime.getTime())) {
    throw new Error("Could not parse the requested date and time.");
  }

  const now = input.now ?? new Date();
  if (startTime.getTime() <= now.getTime()) {
    throw new Error("Please choose a date and time in the future.");
  }

  const duration =
    input.durationMinutes && input.durationMinutes > 0
      ? input.durationMinutes
      : DEFAULT_DURATION_MIN;
  const endTime = new Date(startTime.getTime() + duration * 60_000);

  return { startTime, endTime };
}
