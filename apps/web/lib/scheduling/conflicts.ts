/**
 * Pure appointment-conflict detection. No I/O — the router fetches candidate
 * bookings in the time window and this classifies real conflicts.
 *
 * Overlap is STRICT: two intervals conflict only if they actually intersect,
 * so back-to-back appointments (one ends exactly when the next begins) do NOT
 * conflict. Cancelled / no-show bookings never block, and a booking being
 * rescheduled can be excluded by id.
 */

export interface CandidateSlot {
  startTime: Date;
  endTime: Date;
  doctorId?: string | null;
  roomId?: string | null;
  locationId?: string | null;
  /** Exclude this booking from the check (when rescheduling it). */
  excludeId?: string;
}

export interface ExistingBooking {
  id: string;
  startTime: Date;
  endTime: Date;
  doctorId: string | null;
  roomId: string | null;
  locationId?: string | null;
  status: string;
}

export interface ConflictResult {
  doctor: ExistingBooking[];
  room: ExistingBooking[];
  location: ExistingBooking[];
}

const NON_BLOCKING = new Set(["cancelled", "no_show"]);

/** Strict interval overlap: a starts before b ends AND a ends after b starts. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

export function detectConflicts(
  candidate: CandidateSlot,
  existing: ExistingBooking[]
): ConflictResult {
  const result: ConflictResult = { doctor: [], room: [], location: [] };
  for (const booking of existing) {
    if (candidate.excludeId && booking.id === candidate.excludeId) continue;
    if (NON_BLOCKING.has(booking.status)) continue;
    if (!overlaps(candidate.startTime, candidate.endTime, booking.startTime, booking.endTime)) {
      continue;
    }
    if (candidate.doctorId && booking.doctorId === candidate.doctorId) {
      result.doctor.push(booking);
    }
    if (candidate.roomId && booking.roomId === candidate.roomId) {
      result.room.push(booking);
    }
    if (
      !candidate.doctorId &&
      !candidate.roomId &&
      candidate.locationId &&
      booking.locationId === candidate.locationId
    ) {
      result.location.push(booking);
    }
  }
  return result;
}

export function hasConflict(result: ConflictResult): boolean {
  return (
    result.doctor.length > 0 ||
    result.room.length > 0 ||
    result.location.length > 0
  );
}

/** Human-readable conflict message, or null if there's no conflict. */
export function conflictMessage(result: ConflictResult): string | null {
  if (result.doctor.length > 0 && result.room.length > 0) {
    return "This time conflicts with another appointment for both this doctor and this room.";
  }
  if (result.doctor.length > 0) {
    return "This time conflicts with another appointment for this doctor.";
  }
  if (result.room.length > 0) {
    return "This room is already booked for an overlapping appointment.";
  }
  if (result.location.length > 0) {
    return "This clinic location already has an overlapping unassigned appointment.";
  }
  return null;
}
