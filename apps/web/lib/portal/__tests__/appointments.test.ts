import { describe, expect, it } from "vitest";
import {
  isPortalUpcomingAppointment,
  splitPortalAppointments,
} from "../appointments";

describe("portal appointment list helpers", () => {
  const now = new Date("2026-07-01T16:00:00.000Z");

  it("keeps active visits upcoming even after their start time passes", () => {
    expect(
      isPortalUpcomingAppointment(
        { startTime: "2026-07-01T15:00:00.000Z", status: "checked_in" },
        now
      )
    ).toBe(true);
    expect(
      isPortalUpcomingAppointment(
        { startTime: "2026-07-01T15:30:00.000Z", status: "in_exam" },
        now
      )
    ).toBe(true);
  });

  it("keeps terminal visits in history even when imported with future times", () => {
    const future = "2026-07-02T15:00:00.000Z";

    expect(
      isPortalUpcomingAppointment(
        { startTime: future, status: "checked_out" },
        now
      )
    ).toBe(false);
    expect(
      isPortalUpcomingAppointment({ startTime: future, status: "no_show" }, now)
    ).toBe(false);
    expect(
      isPortalUpcomingAppointment({ startTime: future, status: "cancelled" }, now)
    ).toBe(false);
  });

  it("splits and sorts upcoming appointments soonest first and history newest first", () => {
    const split = splitPortalAppointments(
      [
        {
          id: "future-late",
          startTime: "2026-07-05T15:00:00.000Z",
          status: "scheduled",
        },
        {
          id: "past-old",
          startTime: "2026-06-01T15:00:00.000Z",
          status: "checked_out",
        },
        {
          id: "active",
          startTime: "2026-07-01T15:00:00.000Z",
          status: "in_exam",
        },
        {
          id: "past-new",
          startTime: "2026-06-28T15:00:00.000Z",
          status: "cancelled",
        },
        {
          id: "future-soon",
          startTime: "2026-07-02T15:00:00.000Z",
          status: "confirmed",
        },
      ],
      now
    );

    expect(split.upcoming.map((appointment) => appointment.id)).toEqual([
      "active",
      "future-soon",
      "future-late",
    ]);
    expect(split.past.map((appointment) => appointment.id)).toEqual([
      "past-new",
      "past-old",
    ]);
  });
});
