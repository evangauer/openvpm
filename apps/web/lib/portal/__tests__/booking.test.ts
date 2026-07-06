import { describe, it, expect } from "vitest";
import {
  assertSlotWithinPortalBookingHours,
  buildRequestedSlot,
  filterFutureOpenSlots,
  isPortalBookingReasonValid,
  isPortalBookingStartWithinBounds,
  PORTAL_BOOKING_REASON_MAX_LENGTH,
  portalBookingTimeBounds,
  portalBookingWindow,
} from "../booking";

const NOW = new Date("2026-06-01T12:00:00.000Z");

describe("buildRequestedSlot", () => {
  it("builds a slot with end = start + duration", () => {
    const { startTime, endTime } = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "09:00",
      durationMinutes: 45,
      now: NOW,
    });
    expect(endTime.getTime() - startTime.getTime()).toBe(45 * 60_000);
  });

  it("defaults to a 30-minute slot when duration is missing or invalid", () => {
    const a = buildRequestedSlot({ preferredDate: "2026-07-01", preferredTime: "09:00", now: NOW });
    expect(a.endTime.getTime() - a.startTime.getTime()).toBe(30 * 60_000);

    const b = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "09:00",
      durationMinutes: 0,
      now: NOW,
    });
    expect(b.endTime.getTime() - b.startTime.getTime()).toBe(30 * 60_000);
  });

  it("rejects a malformed date", () => {
    expect(() =>
      buildRequestedSlot({ preferredDate: "07/01/2026", preferredTime: "09:00", now: NOW })
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      buildRequestedSlot({ preferredDate: "2026-02-30", preferredTime: "09:00", now: NOW })
    ).toThrow(/valid YYYY-MM-DD/);
  });

  it("rejects a malformed or out-of-range time", () => {
    expect(() =>
      buildRequestedSlot({ preferredDate: "2026-07-01", preferredTime: "9am", now: NOW })
    ).toThrow(/HH:MM/);
    expect(() =>
      buildRequestedSlot({ preferredDate: "2026-07-01", preferredTime: "morning", now: NOW })
    ).toThrow(/HH:MM/);
    expect(() =>
      buildRequestedSlot({ preferredDate: "2026-07-01", preferredTime: "25:00", now: NOW })
    ).toThrow(/HH:MM/);
  });

  it("rejects a slot in the past", () => {
    expect(() =>
      buildRequestedSlot({ preferredDate: "2020-01-01", preferredTime: "09:00", now: NOW })
    ).toThrow(/future/);
  });

  it("returns the configured portal booking window for a valid date", () => {
    const { dayStart, dayEnd } = portalBookingWindow("2026-07-01");

    expect(dayStart.getHours()).toBe(8);
    expect(dayStart.getMinutes()).toBe(0);
    expect(dayEnd.getHours()).toBe(18);
    expect(dayEnd.getMinutes()).toBe(0);
  });

  it("returns the configured portal booking window for a practice timezone", () => {
    const { dayStart, dayEnd } = portalBookingWindow(
      "2026-07-01",
      "America/Los_Angeles"
    );

    expect(dayStart.toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-07-02T01:00:00.000Z");
  });

  it("builds requested portal slots from the practice timezone", () => {
    const { startTime, endTime } = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "09:15",
      durationMinutes: 45,
      now: NOW,
      timeZone: "America/Los_Angeles",
    });

    expect(startTime.toISOString()).toBe("2026-07-01T16:15:00.000Z");
    expect(endTime.toISOString()).toBe("2026-07-01T17:00:00.000Z");
  });

  it("computes browser time bounds from the portal booking window and duration", () => {
    expect(portalBookingTimeBounds(30)).toEqual({
      minTime: "08:00",
      maxTime: "17:30",
    });
    expect(portalBookingTimeBounds(120)).toEqual({
      minTime: "08:00",
      maxTime: "16:00",
    });
    expect(portalBookingTimeBounds(0)).toEqual({
      minTime: "08:00",
      maxTime: "17:30",
    });
    expect(portalBookingTimeBounds(601)).toEqual({
      minTime: "08:00",
      maxTime: null,
    });
  });

  it("validates manual start times against the portal booking bounds", () => {
    expect(isPortalBookingStartWithinBounds("08:00", 30)).toBe(true);
    expect(isPortalBookingStartWithinBounds("17:30", 30)).toBe(true);
    expect(isPortalBookingStartWithinBounds("17:45", 30)).toBe(false);
    expect(isPortalBookingStartWithinBounds("07:59", 30)).toBe(false);
    expect(isPortalBookingStartWithinBounds("16:00", 120)).toBe(true);
    expect(isPortalBookingStartWithinBounds("16:30", 120)).toBe(false);
    expect(isPortalBookingStartWithinBounds("09:00", 601)).toBe(false);
    expect(isPortalBookingStartWithinBounds("9am", 30)).toBe(false);
  });

  it("validates appointment request reasons with trim-aware bounds", () => {
    expect(PORTAL_BOOKING_REASON_MAX_LENGTH).toBe(1000);
    expect(isPortalBookingReasonValid(" Annual wellness ")).toBe(true);
    expect(isPortalBookingReasonValid("   ")).toBe(false);
    expect(
      isPortalBookingReasonValid(
        "A".repeat(PORTAL_BOOKING_REASON_MAX_LENGTH + 1)
      )
    ).toBe(false);
  });

  it("rejects requested slots outside portal booking hours", () => {
    const beforeOpen = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "07:30",
      durationMinutes: 30,
      now: NOW,
    });
    const endsAfterClose = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "17:45",
      durationMinutes: 30,
      now: NOW,
    });
    const insideWindow = buildRequestedSlot({
      preferredDate: "2026-07-01",
      preferredTime: "08:00",
      durationMinutes: 30,
      now: NOW,
    });

    expect(() =>
      assertSlotWithinPortalBookingHours(beforeOpen, "2026-07-01")
    ).toThrow(/between 08:00 and 18:00/);
    expect(() =>
      assertSlotWithinPortalBookingHours(endsAfterClose, "2026-07-01")
    ).toThrow(/between 08:00 and 18:00/);
    expect(() =>
      assertSlotWithinPortalBookingHours(insideWindow, "2026-07-01")
    ).not.toThrow();
  });

  it("filters open slots that have already started", () => {
    const slots = [
      {
        start: new Date("2026-07-01T09:30:00.000Z"),
        end: new Date("2026-07-01T10:00:00.000Z"),
      },
      {
        start: new Date("2026-07-01T10:00:00.000Z"),
        end: new Date("2026-07-01T10:30:00.000Z"),
      },
      {
        start: new Date("2026-07-01T10:30:00.000Z"),
        end: new Date("2026-07-01T11:00:00.000Z"),
      },
    ];

    expect(
      filterFutureOpenSlots(slots, new Date("2026-07-01T10:00:00.000Z"))
    ).toEqual([slots[2]]);
  });
});
