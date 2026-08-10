import { describe, it, expect } from "vitest";
import {
  overlaps,
  detectConflicts,
  hasConflict,
  conflictMessage,
  type ExistingBooking,
} from "../conflicts";

const d = (iso: string) => new Date(iso);

describe("overlaps (strict)", () => {
  it("true when intervals intersect", () => {
    expect(overlaps(d("2026-06-01T09:00Z"), d("2026-06-01T10:00Z"), d("2026-06-01T09:30Z"), d("2026-06-01T10:30Z"))).toBe(true);
  });
  it("false for back-to-back (end == next start)", () => {
    expect(overlaps(d("2026-06-01T09:00Z"), d("2026-06-01T09:30Z"), d("2026-06-01T09:30Z"), d("2026-06-01T10:00Z"))).toBe(false);
  });
  it("true when one contains the other", () => {
    expect(overlaps(d("2026-06-01T09:00Z"), d("2026-06-01T11:00Z"), d("2026-06-01T09:30Z"), d("2026-06-01T10:00Z"))).toBe(true);
  });
  it("false when fully separate", () => {
    expect(overlaps(d("2026-06-01T09:00Z"), d("2026-06-01T09:30Z"), d("2026-06-01T11:00Z"), d("2026-06-01T11:30Z"))).toBe(false);
  });
});

function booking(over: Partial<ExistingBooking> = {}): ExistingBooking {
  return {
    id: "b1",
    startTime: d("2026-06-01T09:00Z"),
    endTime: d("2026-06-01T10:00Z"),
    doctorId: "doc1",
    roomId: "room1",
    status: "scheduled",
    ...over,
  };
}

const candidate = {
  startTime: d("2026-06-01T09:30Z"),
  endTime: d("2026-06-01T10:30Z"),
  doctorId: "doc1",
  roomId: "room1",
};

describe("detectConflicts", () => {
  it("flags doctor and room conflicts on overlap", () => {
    const r = detectConflicts(candidate, [booking()]);
    expect(r.doctor).toHaveLength(1);
    expect(r.room).toHaveLength(1);
    expect(hasConflict(r)).toBe(true);
  });

  it("ignores a different doctor and different room", () => {
    const r = detectConflicts(candidate, [booking({ doctorId: "doc2", roomId: "room2" })]);
    expect(hasConflict(r)).toBe(false);
  });

  it("ignores cancelled and no-show bookings", () => {
    expect(hasConflict(detectConflicts(candidate, [booking({ status: "cancelled" })]))).toBe(false);
    expect(hasConflict(detectConflicts(candidate, [booking({ status: "no_show" })]))).toBe(false);
  });

  it("excludes the booking being rescheduled", () => {
    const r = detectConflicts({ ...candidate, excludeId: "b1" }, [booking()]);
    expect(hasConflict(r)).toBe(false);
  });

  it("does not flag back-to-back same-room bookings", () => {
    const r = detectConflicts(
      { startTime: d("2026-06-01T10:00Z"), endTime: d("2026-06-01T10:30Z"), roomId: "room1" },
      [booking()]
    );
    expect(hasConflict(r)).toBe(false);
  });

  it("flags only the room when no doctor is given", () => {
    const r = detectConflicts(
      { startTime: d("2026-06-01T09:30Z"), endTime: d("2026-06-01T10:30Z"), roomId: "room1" },
      [booking()]
    );
    expect(r.doctor).toHaveLength(0);
    expect(r.room).toHaveLength(1);
  });

  it("treats an unassigned location as a conservative single resource", () => {
    const r = detectConflicts(
      {
        startTime: d("2026-06-01T09:30Z"),
        endTime: d("2026-06-01T10:30Z"),
        locationId: "location-1",
      },
      [booking({ doctorId: null, roomId: null, locationId: "location-1" })]
    );
    expect(r.location).toHaveLength(1);
    expect(conflictMessage(r)).toMatch(/clinic location/i);
  });
});

describe("conflictMessage", () => {
  it("returns null when clear", () => {
    expect(conflictMessage({ doctor: [], room: [], location: [] })).toBeNull();
  });
  it("mentions the room when only the room conflicts", () => {
    expect(
      conflictMessage({ doctor: [], room: [booking()], location: [] })
    ).toMatch(/room/i);
  });
  it("mentions both when both conflict", () => {
    expect(
      conflictMessage({ doctor: [booking()], room: [booking()], location: [] })
    ).toMatch(/both/i);
  });
});
