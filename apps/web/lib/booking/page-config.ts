/**
 * Pure config + hours logic for public booking pages. No I/O.
 *
 * A booking page's `config` jsonb is never trusted raw: everything read from
 * the database goes through `parseBookingPageConfig`, which fills safe
 * defaults and drops invalid values instead of throwing. Requestable visit
 * types deliberately fail closed when missing or malformed.
 */

import { z } from "zod";
import { dateInputTimeUtcInstant } from "@/lib/date-input";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const BOOKING_SLUG_MIN_LENGTH = 3;
export const BOOKING_SLUG_MAX_LENGTH = 64;
export const BOOKING_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const BOOKING_REASON_MAX_LENGTH = 1000;
export const BOOKING_WELCOME_MAX_LENGTH = 500;

/** Slugs that collide with app routes or invite abuse. */
export const RESERVED_BOOKING_SLUGS = new Set([
  "api",
  "app",
  "admin",
  "book",
  "booking",
  "clients",
  "dashboard",
  "demo",
  "login",
  "new",
  "openvpm",
  "portal",
  "register",
  "settings",
  "signup",
  "static",
  "support",
  "test",
  "www",
]);

export function isValidBookingSlug(value: string): boolean {
  return (
    value.length >= BOOKING_SLUG_MIN_LENGTH &&
    value.length <= BOOKING_SLUG_MAX_LENGTH &&
    BOOKING_SLUG_RE.test(value) &&
    !RESERVED_BOOKING_SLUGS.has(value)
  );
}

/** Suggest a slug from a practice name ("Sunny Paws Vet!" → "sunny-paws-vet"). */
export function suggestBookingSlug(practiceName: string): string {
  const slug = practiceName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BOOKING_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  if (slug.length >= BOOKING_SLUG_MIN_LENGTH && !RESERVED_BOOKING_SLUGS.has(slug)) {
    return slug;
  }
  return slug ? `${slug}-clinic`.slice(0, BOOKING_SLUG_MAX_LENGTH) : "";
}

const dayHoursSchema = z
  .object({
    open: z.string().regex(TIME_RE),
    close: z.string().regex(TIME_RE),
  })
  .refine((d) => d.open < d.close, {
    message: "Opening time must be before closing time.",
  });

export type BookingDayHours = z.infer<typeof dayHoursSchema>;

/** Index 0 = Sunday … 6 = Saturday (JS Date#getDay convention). null = closed. */
export type BookingWeeklyHours = [
  BookingDayHours | null,
  BookingDayHours | null,
  BookingDayHours | null,
  BookingDayHours | null,
  BookingDayHours | null,
  BookingDayHours | null,
  BookingDayHours | null,
];

const weeklyHoursSchema = z.tuple([
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
  dayHoursSchema.nullable(),
]);

/** Mon–Fri 08:00–18:00 (mirrors the portal's historical window), weekends closed. */
export const DEFAULT_WEEKLY_HOURS: BookingWeeklyHours = [
  null,
  { open: "08:00", close: "18:00" },
  { open: "08:00", close: "18:00" },
  { open: "08:00", close: "18:00" },
  { open: "08:00", close: "18:00" },
  { open: "08:00", close: "18:00" },
  null,
];

export const BOOKING_LEAD_TIME_DEFAULT_MINUTES = 60;
export const BOOKING_WINDOW_DEFAULT_DAYS = 60;
export const BOOKING_WINDOW_MAX_DAYS = 365;

const configSchema = z.object({
  hours: weeklyHoursSchema.catch(() => DEFAULT_WEEKLY_HOURS),
  /** Explicitly selected active appointment types; empty fails public booking closed. */
  bookableTypeIds: z
    .array(z.string().uuid())
    .nullable()
    .catch([])
    .transform((ids) => ids ?? []),
  /**
   * Legacy compatibility only. Public booking is request-only, so old saved
   * `true` values and stale clients are normalized to false on every read/write.
   */
  autoConfirm: z
    .boolean()
    .catch(false)
    .transform(() => false),
  allowNewClients: z.boolean().catch(true),
  leadTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60)
    .catch(BOOKING_LEAD_TIME_DEFAULT_MINUTES),
  bookingWindowDays: z
    .number()
    .int()
    .min(1)
    .max(BOOKING_WINDOW_MAX_DAYS)
    .catch(BOOKING_WINDOW_DEFAULT_DAYS),
  welcomeText: z
    .string()
    .trim()
    .max(BOOKING_WELCOME_MAX_LENGTH)
    .catch("")
    .default(""),
  /** Hex accent for the public page, e.g. "#0d9488". */
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .catch("#0d9488"),
});

export type BookingPageConfig = z.infer<typeof configSchema>;

export const DEFAULT_BOOKING_PAGE_CONFIG: BookingPageConfig = {
  hours: DEFAULT_WEEKLY_HOURS,
  bookableTypeIds: [],
  autoConfirm: false,
  allowNewClients: true,
  leadTimeMinutes: BOOKING_LEAD_TIME_DEFAULT_MINUTES,
  bookingWindowDays: BOOKING_WINDOW_DEFAULT_DAYS,
  welcomeText: "",
  accentColor: "#0d9488",
};

/** Tolerant parse: unknown/invalid fields fall back to defaults, never throws. */
export function parseBookingPageConfig(raw: unknown): BookingPageConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  return { ...DEFAULT_BOOKING_PAGE_CONFIG };
}

/** Strict parse for writes from the settings UI: throws on invalid input. */
export const bookingPageConfigInput = configSchema;

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

/** Weekday (0=Sun) of a YYYY-MM-DD calendar date, timezone-independent. */
export function weekdayOfDateInput(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export interface BookingDayWindow {
  dayStart: Date;
  dayEnd: Date;
}

/**
 * The open window for a calendar date under the page's weekly hours, as UTC
 * instants in the practice timezone. Returns null when closed that day.
 */
export function bookingWindowForDate(
  config: BookingPageConfig,
  date: string,
  timeZone?: string | null
): BookingDayWindow | null {
  if (!isValidDateInput(date)) {
    throw new Error("date must be a valid YYYY-MM-DD date.");
  }
  const hours = config.hours[weekdayOfDateInput(date)];
  if (!hours) return null;

  const [openHour, openMinute] = hours.open.split(":").map(Number);
  const [closeHour, closeMinute] = hours.close.split(":").map(Number);
  return {
    dayStart: dateInputTimeUtcInstant(
      date,
      { hour: openHour!, minute: openMinute! },
      timeZone
    ),
    dayEnd: dateInputTimeUtcInstant(
      date,
      { hour: closeHour!, minute: closeMinute! },
      timeZone
    ),
  };
}

/**
 * Whether a calendar date is inside the page's booking window: not in the
 * past and no further out than `bookingWindowDays` from `now`.
 */
export function isDateWithinBookingWindow(
  config: BookingPageConfig,
  date: string,
  now: Date = new Date()
): boolean {
  if (!isValidDateInput(date)) return false;
  const endOfDate = new Date(`${date}T23:59:59Z`).getTime() + 14 * 60 * 60 * 1000;
  if (endOfDate < now.getTime()) return false;
  const horizon =
    now.getTime() + config.bookingWindowDays * 24 * 60 * 60 * 1000;
  const startOfDate = new Date(`${date}T00:00:00Z`).getTime() - 14 * 60 * 60 * 1000;
  return startOfDate <= horizon;
}

/** Earliest bookable instant given the page's lead time. */
export function minimumBookableInstant(
  config: BookingPageConfig,
  now: Date = new Date()
): Date {
  return new Date(now.getTime() + config.leadTimeMinutes * 60_000);
}
