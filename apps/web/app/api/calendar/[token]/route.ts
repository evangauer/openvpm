import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, isNull, lte, notInArray } from "drizzle-orm";
import {
  appointments,
  appointmentTypes,
  patients,
  practices,
  rooms,
  locations,
  users,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import {
  rateLimit,
  rateLimitResponseHeaders,
} from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  calendarRateLimitKey,
  isCalendarFeedTokenShape,
} from "@/lib/calendar/tokens";
import {
  buildPracticeCalendarIcs,
  CALENDAR_FEED_EXCLUDED_STATUSES,
  CALENDAR_FEED_FUTURE_DAYS,
  CALENDAR_FEED_PAST_DAYS,
} from "@/lib/calendar/ics";

export const dynamic = "force-dynamic";

/**
 * Read-only ICS schedule feed, polled unauthenticated by calendar clients
 * (Google, Apple, Outlook) holding the practice's capability URL.
 *
 * Security model mirrors portal links: token shape is validated before any
 * work, lookups run under withSystem with an explicit practice-alive check,
 * and every miss is the same generic 404 (no token-validity oracle). Events
 * are PHI-minimized in lib/calendar/ics.ts.
 */

// Calendar clients poll roughly hourly per subscriber; 120/hour covers a
// whole clinic of subscribers with headroom. The IP cap blunts token
// scanning without touching legitimate pollers.
const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 60 * 60 * 1000;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token: tokenParam } = await params;
  // Accept both /api/calendar/<token> and the friendlier <token>.ics form.
  const token = tokenParam.endsWith(".ics")
    ? tokenParam.slice(0, -4)
    : tokenParam;
  if (!isCalendarFeedTokenShape(token)) {
    return notFound();
  }

  const ipResult = await rateLimit({
    key: `calendar-feed:ip:${clientIpFromRequest(request)}`,
    limit: IP_LIMIT,
    windowMs: IP_WINDOW_MS,
  });
  if (!ipResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateLimitResponseHeaders(IP_LIMIT, ipResult) }
    );
  }

  const tokenResult = await rateLimit({
    key: calendarRateLimitKey("calendar-feed", token),
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });
  if (!tokenResult.success) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: rateLimitResponseHeaders(TOKEN_LIMIT, tokenResult),
      }
    );
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - CALENDAR_FEED_PAST_DAYS * DAY_MS);
  const windowEnd = new Date(
    now.getTime() + CALENDAR_FEED_FUTURE_DAYS * DAY_MS
  );

  const feed = await withSystem(db, async (tx) => {
    const [practice] = await tx
      .select({
        id: practices.id,
        name: practices.name,
        timezone: practices.timezone,
      })
      .from(practices)
      .where(
        and(
          eq(practices.calendarFeedToken, token),
          isNull(practices.deletedAt)
        )
      )
      .limit(1);
    if (!practice) return null;

    const rows = await tx
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        updatedAt: appointments.updatedAt,
        status: appointments.status,
        patientName: patients.name,
        typeName: appointmentTypes.name,
        roomName: rooms.name,
        locationName: locations.name,
        doctorName: users.name,
      })
      .from(appointments)
      .leftJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(appointmentTypes, eq(appointments.typeId, appointmentTypes.id))
      .leftJoin(rooms, eq(appointments.roomId, rooms.id))
      .leftJoin(
        locations,
        and(
          eq(appointments.locationId, locations.id),
          eq(locations.practiceId, practice.id),
        ),
      )
      .leftJoin(users, eq(appointments.doctorId, users.id))
      .where(
        and(
          eq(appointments.practiceId, practice.id),
          isNull(appointments.deletedAt),
          notInArray(appointments.status, [...CALENDAR_FEED_EXCLUDED_STATUSES]),
          gte(appointments.startTime, windowStart),
          lte(appointments.startTime, windowEnd)
        )
      );

    return buildPracticeCalendarIcs({
      practiceName: practice.name,
      timezone: practice.timezone ?? null,
      appointments: rows,
      now,
    });
  });

  if (!feed) {
    return notFound();
  }

  return new NextResponse(feed, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, max-age=900",
      "Content-Disposition": 'inline; filename="openvpm-schedule.ics"',
    },
  });
}
