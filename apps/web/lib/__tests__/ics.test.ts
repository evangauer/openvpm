import { describe, expect, it } from "vitest";
import {
  buildPracticeCalendarIcs,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  type CalendarFeedAppointment,
} from "../calendar/ics";

const NOW = new Date("2026-07-08T12:00:00.000Z");

function appt(
  overrides: Partial<CalendarFeedAppointment> = {}
): CalendarFeedAppointment {
  return {
    id: "a1",
    startTime: new Date("2026-07-08T13:00:00.000Z"),
    endTime: new Date("2026-07-08T13:30:00.000Z"),
    updatedAt: new Date("2026-07-07T09:15:00.000Z"),
    status: "confirmed",
    patientName: "Biscuit",
    typeName: "Wellness Exam",
    roomName: "Exam 1",
    locationName: "Main Clinic",
    doctorName: "Sarah Chen",
    ...overrides,
  };
}

function build(appointments: CalendarFeedAppointment[]) {
  return buildPracticeCalendarIcs({
    practiceName: "Aspen Creek Animal Hospital",
    timezone: "America/Denver",
    appointments,
    now: NOW,
  });
}

describe("ICS calendar feed builder", () => {
  it("emits exact UTC Z times with no VTIMEZONE", () => {
    const ics = build([appt()]);
    expect(ics).toContain("DTSTART:20260708T130000Z");
    expect(ics).toContain("DTEND:20260708T133000Z");
    expect(ics).not.toContain("VTIMEZONE");
    expect(ics).toContain("X-WR-TIMEZONE:America/Denver");
  });

  it("keeps UIDs stable and stamps LAST-MODIFIED from updatedAt", () => {
    const ics = build([appt()]);
    expect(ics).toContain("UID:appt-a1@openvpm");
    expect(ics).toContain("LAST-MODIFIED:20260707T091500Z");
  });

  it("minimizes PHI: patient + type + clinic location + room + doctor only", () => {
    const ics = build([appt()]);
    expect(ics).toContain("SUMMARY:Biscuit - Wellness Exam");
    expect(ics).toContain(
      foldIcsLine("LOCATION:Main Clinic\\, Exam 1")
    );
    expect(ics).toContain("DESCRIPTION:With Dr. Sarah Chen");
  });

  it("excludes cancelled and no-show appointments", () => {
    const ics = build([
      appt({ id: "keep" }),
      appt({ id: "gone1", status: "cancelled" }),
      appt({ id: "gone2", status: "no_show" }),
    ]);
    expect(ics).toContain("UID:appt-keep@openvpm");
    expect(ics).not.toContain("gone1");
    expect(ics).not.toContain("gone2");
  });

  it("maps scheduled to TENTATIVE and firmer statuses to CONFIRMED", () => {
    const tentative = build([appt({ status: "scheduled" })]);
    expect(tentative).toContain("STATUS:TENTATIVE");
    for (const status of ["confirmed", "checked_in", "in_exam", "checked_out"]) {
      expect(build([appt({ status })])).toContain("STATUS:CONFIRMED");
    }
  });

  it("falls back to a generic summary when names are missing", () => {
    const ics = build([
      appt({ patientName: null, typeName: null, roomName: null, doctorName: null }),
    ]);
    expect(ics).toContain("SUMMARY:Appointment");
    expect(ics).not.toContain("DESCRIPTION:");
    expect(ics).toContain("LOCATION:Main Clinic");
  });

  it("escapes RFC 5545 special characters", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
    const ics = build([appt({ patientName: "Mr. Whiskers, Jr." })]);
    expect(ics).toContain("SUMMARY:Mr. Whiskers\\, Jr. - Wellness Exam");
  });

  it("folds long lines at 75 octets with space continuations", () => {
    const long = `SUMMARY:${"x".repeat(200)}`;
    const folded = foldIcsLine(long);
    for (const [i, part] of folded.split("\r\n").entries()) {
      expect(Buffer.from(part, "utf8").length).toBeLessThanOrEqual(75);
      if (i > 0) expect(part.startsWith(" ")).toBe(true);
    }
    // Unfolding restores the original content.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("never splits a UTF-8 multi-byte character across folds", () => {
    const folded = foldIcsLine(`SUMMARY:${"é".repeat(100)}`);
    for (const part of folded.split("\r\n")) {
      // A broken sequence would throw or produce replacement characters.
      expect(part.includes("�")).toBe(false);
    }
  });

  it("uses CRLF line endings throughout", () => {
    const ics = build([appt()]);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("formats UTC instants per RFC 5545", () => {
    expect(formatIcsUtc(new Date("2026-01-02T03:04:05.678Z"))).toBe(
      "20260102T030405Z"
    );
  });
});
