/**
 * Pure RFC 5545 (iCalendar) generation for the practice schedule feed.
 *
 * Design constraints:
 * - Appointment times are timestamptz, so events emit exact UTC `Z` times
 *   and skip VTIMEZONE entirely; calendar clients render in the viewer's
 *   local zone. X-WR-TIMEZONE carries the practice zone as a display hint.
 * - PHI minimization: SUMMARY is "<patient> - <visit type>" only, LOCATION
 *   is the practice (plus room), DESCRIPTION at most the doctor's name.
 *   No client names, no notes, no clinical content.
 * - UID is stable per appointment id so edits update events in place, and
 *   LAST-MODIFIED (from updatedAt) lets clients detect the change.
 */

export interface CalendarFeedAppointment {
  id: string;
  startTime: Date;
  endTime: Date;
  updatedAt: Date | null;
  status: string;
  patientName: string | null;
  typeName: string | null;
  roomName: string | null;
  locationName: string | null;
  doctorName: string | null;
}

export interface CalendarFeedInput {
  practiceName: string;
  timezone: string | null;
  appointments: CalendarFeedAppointment[];
  now: Date;
}

/** Feed window relative to now: recent past for context, two months out. */
export const CALENDAR_FEED_PAST_DAYS = 7;
export const CALENDAR_FEED_FUTURE_DAYS = 60;

/** Statuses that never belong in a calendar. */
export const CALENDAR_FEED_EXCLUDED_STATUSES = [
  "cancelled",
  "no_show",
] as const;

const CRLF = "\r\n";

/** RFC 5545 3.3.11: escape backslash, semicolon, comma, and newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 3.1: fold content lines longer than 75 octets. */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    // Continuation lines start with a space, costing one octet.
    let width = first ? 75 : 74;
    let end = Math.min(start + width, bytes.length);
    // Never split inside a UTF-8 multi-byte sequence.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return parts.join(`${CRLF} `);
}

/** 2026-07-08T13:00:00.000Z -> 20260708T130000Z */
export function formatIcsUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function icsStatus(status: string): "CONFIRMED" | "TENTATIVE" {
  return status === "scheduled" ? "TENTATIVE" : "CONFIRMED";
}

export function buildPracticeCalendarIcs(input: CalendarFeedInput): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenVPM//Schedule Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`${input.practiceName} schedule`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  if (input.timezone) {
    lines.push(`X-WR-TIMEZONE:${escapeIcsText(input.timezone)}`);
  }

  const stamp = formatIcsUtc(input.now);

  const excluded: readonly string[] = CALENDAR_FEED_EXCLUDED_STATUSES;
  for (const appt of input.appointments) {
    if (excluded.includes(appt.status)) continue;

    const summary = appt.patientName
      ? appt.typeName
        ? `${appt.patientName} - ${appt.typeName}`
        : appt.patientName
      : appt.typeName ?? "Appointment";
    const clinicLocation = appt.locationName ?? input.practiceName;
    const location = appt.roomName
      ? `${clinicLocation}, ${appt.roomName}`
      : clinicLocation;

    lines.push(
      "BEGIN:VEVENT",
      `UID:appt-${appt.id}@openvpm`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsUtc(appt.startTime)}`,
      `DTEND:${formatIcsUtc(appt.endTime)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `LOCATION:${escapeIcsText(location)}`,
      `STATUS:${icsStatus(appt.status)}`
    );
    if (appt.updatedAt) {
      lines.push(`LAST-MODIFIED:${formatIcsUtc(appt.updatedAt)}`);
    }
    if (appt.doctorName) {
      lines.push(`DESCRIPTION:${escapeIcsText(`With Dr. ${appt.doctorName}`)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
