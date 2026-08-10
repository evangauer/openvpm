import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { locations, rooms, users } from "@openpims/db";

export type AppointmentLocationFailure = {
  ok: false;
  code: "NOT_FOUND" | "PRECONDITION_FAILED";
  message: string;
};

export type AppointmentLocationResolution =
  | {
      ok: true;
      locationId: string;
    }
  | AppointmentLocationFailure;

export function appointmentSchedulingLockKey(practiceId: string): string {
  return `appointment-scheduling:${practiceId}`;
}

/**
 * Serialize conflict checks and appointment writes for one practice. The
 * practice-wide lock is intentionally conservative while public requests are
 * still unassigned to a provider or room.
 */
export async function takeAppointmentSchedulingLock(
  db: Database,
  practiceId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${appointmentSchedulingLockKey(
      practiceId,
    )}::text))`,
  );
}

export async function listActiveAppointmentLocations(
  db: Database,
  practiceId: string,
) {
  return db
    .select({
      id: locations.id,
      name: locations.name,
      address: locations.address,
      phone: locations.phone,
      isPrimary: locations.isPrimary,
    })
    .from(locations)
    .where(
      and(eq(locations.practiceId, practiceId), isNull(locations.deletedAt)),
    )
    .orderBy(desc(locations.isPrimary), locations.name);
}

/**
 * Resolve one active location without silently guessing for a multi-location
 * clinic. A room is authoritative; otherwise an explicit selection wins. A
 * provider's home location is a safe fallback, followed by the clinic's only
 * active location. Multi-location writes with no signal fail closed.
 */
export async function resolveAppointmentLocation(
  db: Database,
  input: {
    practiceId: string;
    locationId?: string | null;
    roomId?: string | null;
    doctorId?: string | null;
  },
): Promise<AppointmentLocationResolution> {
  const activeLocations = await listActiveAppointmentLocations(
    db,
    input.practiceId,
  );
  if (activeLocations.length === 0) {
    return {
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "Add an active clinic location before scheduling appointments.",
    };
  }
  const activeLocationIds = new Set(activeLocations.map((row) => row.id));

  if (input.locationId && !activeLocationIds.has(input.locationId)) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "Location not found",
    };
  }

  let roomLocationId: string | null = null;
  if (input.roomId) {
    const [room] = await db
      .select({ id: rooms.id, locationId: rooms.locationId })
      .from(rooms)
      .where(
        and(
          eq(rooms.id, input.roomId),
          eq(rooms.practiceId, input.practiceId),
          isNull(rooms.deletedAt),
        ),
      )
      .limit(1);
    if (!room || !room.locationId || !activeLocationIds.has(room.locationId)) {
      return { ok: false, code: "NOT_FOUND", message: "Room not found" };
    }
    roomLocationId = room.locationId;
  }

  if (
    roomLocationId &&
    input.locationId &&
    roomLocationId !== input.locationId
  ) {
    return {
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "Choose a room at the appointment's clinic location.",
    };
  }
  let doctorLocationId: string | null = null;
  if (input.doctorId) {
    const [doctor] = await db
      .select({ locationId: users.locationId })
      .from(users)
      .where(
        and(
          eq(users.id, input.doctorId),
          eq(users.practiceId, input.practiceId),
          eq(users.isVeterinarian, true),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!doctor) {
      return { ok: false, code: "NOT_FOUND", message: "Doctor not found" };
    }
    if (doctor.locationId && activeLocationIds.has(doctor.locationId)) {
      doctorLocationId = doctor.locationId;
    }
  }

  if (roomLocationId) return { ok: true, locationId: roomLocationId };
  if (input.locationId) return { ok: true, locationId: input.locationId };
  if (doctorLocationId) return { ok: true, locationId: doctorLocationId };

  if (activeLocations.length === 1) {
    return { ok: true, locationId: activeLocations[0]!.id };
  }

  return {
    ok: false,
    code: "PRECONDITION_FAILED",
    message: "Choose a clinic location before scheduling this appointment.",
  };
}
