import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { staffSchedules, users } from "@openpims/db";
import { dateInputTimeUtcInstant } from "@/lib/date-input";
import { weekdayOfDateInput } from "@/lib/booking/page-config";
import {
  mergeAvailabilityWindows,
  type AvailabilityWindow,
} from "./availability";

export interface ProviderScheduleWindowRow {
  userId: string;
  locationId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ProviderCoverage {
  /** False means the clinic has not opted into provider-hours enforcement. */
  configured: boolean;
  windows: AvailabilityWindow[];
}

function timeParts(value: string) {
  const [hour = 0, minute = 0] = value.slice(0, 5).split(":").map(Number);
  return { hour, minute };
}

/**
 * Resolve a calendar day's provider coverage at one clinic location.
 *
 * Null-location rows are retained as a legacy practice-wide fallback. Once a
 * provider (or, for pooled coverage, the practice) has any saved hours, an
 * empty result means closed rather than falling back to generic 8–6 hours.
 */
export function providerCoverageFromRows(input: {
  rows: ProviderScheduleWindowRow[];
  date: string;
  timezone?: string | null;
  locationId: string;
  doctorId?: string;
}): ProviderCoverage {
  const scopedRows = input.doctorId
    ? input.rows.filter((row) => row.userId === input.doctorId)
    : input.rows;
  if (scopedRows.length === 0) return { configured: false, windows: [] };

  const dayOfWeek = weekdayOfDateInput(input.date);
  const windows = scopedRows
    .filter(
      (row) =>
        row.dayOfWeek === dayOfWeek &&
        (row.locationId === input.locationId || row.locationId === null),
    )
    .map((row) => ({
      start: dateInputTimeUtcInstant(
        input.date,
        timeParts(row.startTime),
        input.timezone,
      ),
      end: dateInputTimeUtcInstant(
        input.date,
        timeParts(row.endTime),
        input.timezone,
      ),
    }));

  return { configured: true, windows: mergeAvailabilityWindows(windows) };
}

/** Read active veterinarian hours once, then apply the pure coverage policy. */
export async function providerCoverageForDate(
  db: Database,
  input: {
    practiceId: string;
    date: string;
    timezone?: string | null;
    locationId: string;
    doctorId?: string;
  },
): Promise<ProviderCoverage> {
  const rows = await db
    .select({
      userId: staffSchedules.userId,
      locationId: staffSchedules.locationId,
      dayOfWeek: staffSchedules.dayOfWeek,
      startTime: staffSchedules.startTime,
      endTime: staffSchedules.endTime,
    })
    .from(staffSchedules)
    .innerJoin(
      users,
      and(
        eq(staffSchedules.userId, users.id),
        eq(users.practiceId, input.practiceId),
        eq(users.isVeterinarian, true),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(staffSchedules.practiceId, input.practiceId),
        isNull(staffSchedules.deletedAt),
      ),
    )
    .orderBy(
      asc(staffSchedules.userId),
      asc(staffSchedules.dayOfWeek),
      asc(staffSchedules.startTime),
    );

  return providerCoverageFromRows({ ...input, rows });
}
