import { describe, expect, it } from "vitest";
import {
  bookingWindowForDate,
  DEFAULT_BOOKING_PAGE_CONFIG,
  DEFAULT_WEEKLY_HOURS,
  isDateWithinBookingWindow,
  isValidBookingSlug,
  minimumBookableInstant,
  parseBookingPageConfig,
  suggestBookingSlug,
  weekdayOfDateInput,
} from "../page-config";

describe("parseBookingPageConfig", () => {
  it("returns defaults for empty or missing config", () => {
    expect(parseBookingPageConfig({})).toEqual(DEFAULT_BOOKING_PAGE_CONFIG);
    expect(parseBookingPageConfig(null)).toEqual(DEFAULT_BOOKING_PAGE_CONFIG);
    expect(parseBookingPageConfig(undefined)).toEqual(
      DEFAULT_BOOKING_PAGE_CONFIG
    );
  });

  it("keeps valid fields and repairs invalid ones instead of throwing", () => {
    const parsed = parseBookingPageConfig({
      hours: "not-hours",
      bookableTypeIds: ["not-a-uuid"],
      autoConfirm: true,
      leadTimeMinutes: -5,
      bookingWindowDays: 9999,
      welcomeText: "Hi there",
      accentColor: "teal",
    });
    expect(parsed.hours).toEqual(DEFAULT_WEEKLY_HOURS);
    expect(parsed.bookableTypeIds).toBeNull();
    expect(parsed.autoConfirm).toBe(true);
    expect(parsed.leadTimeMinutes).toBe(
      DEFAULT_BOOKING_PAGE_CONFIG.leadTimeMinutes
    );
    expect(parsed.bookingWindowDays).toBe(
      DEFAULT_BOOKING_PAGE_CONFIG.bookingWindowDays
    );
    expect(parsed.welcomeText).toBe("Hi there");
    expect(parsed.accentColor).toBe(DEFAULT_BOOKING_PAGE_CONFIG.accentColor);
  });

  it("rejects hours where open is not before close", () => {
    const parsed = parseBookingPageConfig({
      hours: [
        null,
        { open: "18:00", close: "08:00" },
        null,
        null,
        null,
        null,
        null,
      ],
    });
    expect(parsed.hours).toEqual(DEFAULT_WEEKLY_HOURS);
  });
});

describe("isValidBookingSlug", () => {
  it("accepts simple lowercase slugs", () => {
    expect(isValidBookingSlug("oxnard-vet")).toBe(true);
    expect(isValidBookingSlug("clinic123")).toBe(true);
  });

  it("rejects short, malformed, and reserved slugs", () => {
    expect(isValidBookingSlug("ab")).toBe(false);
    expect(isValidBookingSlug("-leading-dash")).toBe(false);
    expect(isValidBookingSlug("trailing-dash-")).toBe(false);
    expect(isValidBookingSlug("Has-Caps")).toBe(false);
    expect(isValidBookingSlug("admin")).toBe(false);
    expect(isValidBookingSlug("portal")).toBe(false);
    expect(isValidBookingSlug("a".repeat(65))).toBe(false);
  });
});

describe("suggestBookingSlug", () => {
  it("slugifies practice names", () => {
    expect(suggestBookingSlug("Sunny Paws Vet!")).toBe("sunny-paws-vet");
    expect(suggestBookingSlug("  Côte d'Azur Vétérinaire ")).toBe(
      "cote-d-azur-veterinaire"
    );
  });

  it("avoids reserved words and empty results", () => {
    expect(suggestBookingSlug("Admin")).toBe("admin-clinic");
    expect(suggestBookingSlug("!!!")).toBe("");
  });
});

describe("weekly hours windows", () => {
  it("maps calendar dates to weekdays without timezone drift", () => {
    // 2026-07-16 is a Thursday, 2026-07-19 a Sunday.
    expect(weekdayOfDateInput("2026-07-16")).toBe(4);
    expect(weekdayOfDateInput("2026-07-19")).toBe(0);
  });

  it("returns null for closed days", () => {
    expect(
      bookingWindowForDate(DEFAULT_BOOKING_PAGE_CONFIG, "2026-07-19", "UTC")
    ).toBeNull();
  });

  it("computes the open window in the practice timezone", () => {
    // Monday 2026-07-20, default hours 08:00-18:00, America/New_York (EDT, UTC-4).
    const window = bookingWindowForDate(
      DEFAULT_BOOKING_PAGE_CONFIG,
      "2026-07-20",
      "America/New_York"
    );
    expect(window).not.toBeNull();
    expect(window!.dayStart.toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect(window!.dayEnd.toISOString()).toBe("2026-07-20T22:00:00.000Z");
  });

  it("throws on malformed dates", () => {
    expect(() =>
      bookingWindowForDate(DEFAULT_BOOKING_PAGE_CONFIG, "2026-13-40", "UTC")
    ).toThrow();
  });
});

describe("booking window and lead time", () => {
  const now = new Date("2026-07-16T12:00:00Z");

  it("rejects past dates and dates beyond the horizon", () => {
    expect(
      isDateWithinBookingWindow(DEFAULT_BOOKING_PAGE_CONFIG, "2026-07-10", now)
    ).toBe(false);
    expect(
      isDateWithinBookingWindow(DEFAULT_BOOKING_PAGE_CONFIG, "2026-07-20", now)
    ).toBe(true);
    // Default window is 60 days; 100 days out is too far.
    expect(
      isDateWithinBookingWindow(DEFAULT_BOOKING_PAGE_CONFIG, "2026-10-24", now)
    ).toBe(false);
  });

  it("computes the earliest bookable instant from lead time", () => {
    expect(
      minimumBookableInstant(DEFAULT_BOOKING_PAGE_CONFIG, now).toISOString()
    ).toBe("2026-07-16T13:00:00.000Z");
    expect(
      minimumBookableInstant(
        { ...DEFAULT_BOOKING_PAGE_CONFIG, leadTimeMinutes: 0 },
        now
      ).toISOString()
    ).toBe(now.toISOString());
  });
});
