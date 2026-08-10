import { describe, it, expect } from "vitest";
import {
  findOpenSlots,
  findOpenSlotsAcrossWindows,
  intersectAvailabilityWindows,
  mergeAvailabilityWindows,
  slotFitsAvailability,
} from "../availability";

const d = (iso: string) => new Date(iso);

describe("findOpenSlots", () => {
  it("fills an empty day with non-overlapping slots", () => {
    const slots = findOpenSlots({
      dayStart: d("2026-06-02T09:00:00Z"),
      dayEnd: d("2026-06-02T12:00:00Z"),
      slotMinutes: 30,
      busy: [],
    });
    expect(slots).toHaveLength(6); // 3 hours / 30 min
    expect(slots[0]!.start.toISOString()).toBe("2026-06-02T09:00:00.000Z");
    expect(slots[5]!.end.toISOString()).toBe("2026-06-02T12:00:00.000Z");
  });

  it("removes slots that overlap a busy interval but keeps adjacent ones", () => {
    const slots = findOpenSlots({
      dayStart: d("2026-06-02T09:00:00Z"),
      dayEnd: d("2026-06-02T11:00:00Z"),
      slotMinutes: 30,
      busy: [
        {
          startTime: d("2026-06-02T09:30:00Z"),
          endTime: d("2026-06-02T10:00:00Z"),
        },
      ],
    });
    const starts = slots.map((s) => s.start.toISOString());
    // 09:00 ok, 09:30 blocked, 10:00 ok (back-to-back), 10:30 ok
    expect(starts).toEqual([
      "2026-06-02T09:00:00.000Z",
      "2026-06-02T10:00:00.000Z",
      "2026-06-02T10:30:00.000Z",
    ]);
  });

  it("does not return a slot that would run past dayEnd", () => {
    const slots = findOpenSlots({
      dayStart: d("2026-06-02T09:00:00Z"),
      dayEnd: d("2026-06-02T09:45:00Z"),
      slotMinutes: 30,
      busy: [],
    });
    // Only 09:00-09:30 fits; 09:30-10:00 would exceed dayEnd.
    expect(slots).toHaveLength(1);
  });

  it("supports a finer step than the slot length", () => {
    const slots = findOpenSlots({
      dayStart: d("2026-06-02T09:00:00Z"),
      dayEnd: d("2026-06-02T10:00:00Z"),
      slotMinutes: 30,
      stepMinutes: 15,
      busy: [],
    });
    // starts at :00, :15, :30 (last that still fits a 30-min slot before 10:00)
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-06-02T09:00:00.000Z",
      "2026-06-02T09:15:00.000Z",
      "2026-06-02T09:30:00.000Z",
    ]);
  });

  it("throws on a non-positive slot length", () => {
    expect(() =>
      findOpenSlots({
        dayStart: d("2026-06-02T09:00:00Z"),
        dayEnd: d("2026-06-02T10:00:00Z"),
        slotMinutes: 0,
        busy: [],
      }),
    ).toThrow(/positive/);
  });
});

describe("multi-window availability", () => {
  it("merges overlapping provider coverage without duplicate slots", () => {
    const windows = mergeAvailabilityWindows([
      { start: d("2026-06-02T09:00:00Z"), end: d("2026-06-02T12:00:00Z") },
      { start: d("2026-06-02T10:00:00Z"), end: d("2026-06-02T13:00:00Z") },
      { start: d("2026-06-02T14:00:00Z"), end: d("2026-06-02T15:00:00Z") },
    ]);
    expect(windows).toEqual([
      { start: d("2026-06-02T09:00:00Z"), end: d("2026-06-02T13:00:00Z") },
      { start: d("2026-06-02T14:00:00Z"), end: d("2026-06-02T15:00:00Z") },
    ]);
    expect(
      findOpenSlotsAcrossWindows({ windows, slotMinutes: 60, busy: [] }),
    ).toHaveLength(5);
  });

  it("intersects coverage with the client-facing request window", () => {
    expect(
      intersectAvailabilityWindows(
        [
          { start: d("2026-06-02T07:00:00Z"), end: d("2026-06-02T10:00:00Z") },
          { start: d("2026-06-02T16:00:00Z"), end: d("2026-06-02T20:00:00Z") },
        ],
        { start: d("2026-06-02T08:00:00Z"), end: d("2026-06-02T18:00:00Z") },
      ),
    ).toEqual([
      { start: d("2026-06-02T08:00:00Z"), end: d("2026-06-02T10:00:00Z") },
      { start: d("2026-06-02T16:00:00Z"), end: d("2026-06-02T18:00:00Z") },
    ]);
  });

  it("requires the entire requested slot to fit coverage", () => {
    const windows = [
      { start: d("2026-06-02T09:00:00Z"), end: d("2026-06-02T10:00:00Z") },
    ];
    expect(
      slotFitsAvailability(
        { start: d("2026-06-02T09:30:00Z"), end: d("2026-06-02T10:00:00Z") },
        windows,
      ),
    ).toBe(true);
    expect(
      slotFitsAvailability(
        { start: d("2026-06-02T09:30:00Z"), end: d("2026-06-02T10:30:00Z") },
        windows,
      ),
    ).toBe(false);
  });
});
