import { describe, expect, it, vi } from "vitest";
import {
  appointmentSchedulingLockKey,
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "../location";

const PRACTICE_ID = "practice-1";
const LOCATION_A = "location-a";
const LOCATION_B = "location-b";
const ROOM_ID = "room-1";
const DOCTOR_ID = "doctor-1";

type LocationRow = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isPrimary: boolean;
};

function locationDb(
  options: {
    locations?: LocationRow[];
    room?: { id: string; locationId: string | null } | null;
    doctor?: { locationId: string | null } | null;
  } = {},
) {
  const execute = vi.fn(async (_statement: unknown) => undefined);
  const select = vi.fn((fields?: Record<string, unknown>) => {
    const names = Object.keys(fields ?? {})
      .sort()
      .join(",");
    const result =
      names === "address,id,isPrimary,name,phone"
        ? (options.locations ?? [])
        : names === "id,locationId"
          ? options.room
            ? [options.room]
            : []
          : names === "locationId"
            ? options.doctor
              ? [options.doctor]
              : []
            : [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  return { db: { execute, select }, execute, select };
}

const locationA: LocationRow = {
  id: LOCATION_A,
  name: "Main Clinic",
  address: "1 Main St",
  phone: null,
  isPrimary: true,
};
const locationB: LocationRow = {
  id: LOCATION_B,
  name: "North Clinic",
  address: "2 North St",
  phone: null,
  isPrimary: false,
};

describe("appointment location resolution", () => {
  it("uses one practice-wide advisory lock namespace", async () => {
    const { db, execute } = locationDb();

    expect(appointmentSchedulingLockKey(PRACTICE_ID)).toBe(
      `appointment-scheduling:${PRACTICE_ID}`,
    );
    await takeAppointmentSchedulingLock(db as never, PRACTICE_ID);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain(
      `appointment-scheduling:${PRACTICE_ID}`,
    );
  });

  it("requires at least one active clinic location", async () => {
    const { db } = locationDb();
    await expect(
      resolveAppointmentLocation(db as never, { practiceId: PRACTICE_ID }),
    ).resolves.toEqual({
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "Add an active clinic location before scheduling appointments.",
    });
  });

  it("auto-selects the sole active location without adding booking friction", async () => {
    const { db } = locationDb({ locations: [locationA] });
    await expect(
      resolveAppointmentLocation(db as never, { practiceId: PRACTICE_ID }),
    ).resolves.toEqual({ ok: true, locationId: LOCATION_A });
  });

  it("fails closed when a multi-location clinic has no location signal", async () => {
    const { db } = locationDb({ locations: [locationA, locationB] });
    await expect(
      resolveAppointmentLocation(db as never, { practiceId: PRACTICE_ID }),
    ).resolves.toMatchObject({
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "Choose a clinic location before scheduling this appointment.",
    });
  });

  it("accepts an explicit active location and rejects an unknown one", async () => {
    const { db } = locationDb({ locations: [locationA, locationB] });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        locationId: LOCATION_B,
      }),
    ).resolves.toEqual({ ok: true, locationId: LOCATION_B });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        locationId: "retired-location",
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("uses the room location and rejects room/location mismatches", async () => {
    const { db } = locationDb({
      locations: [locationA, locationB],
      room: { id: ROOM_ID, locationId: LOCATION_A },
    });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        roomId: ROOM_ID,
      }),
    ).resolves.toEqual({ ok: true, locationId: LOCATION_A });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        roomId: ROOM_ID,
        locationId: LOCATION_B,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "Choose a room at the appointment's clinic location.",
    });
  });

  it("uses an active provider home location when no room or location is selected", async () => {
    const { db } = locationDb({
      locations: [locationA, locationB],
      doctor: { locationId: LOCATION_B },
    });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        doctorId: DOCTOR_ID,
      }),
    ).resolves.toEqual({ ok: true, locationId: LOCATION_B });
  });

  it("rejects a missing room or provider instead of guessing", async () => {
    const { db } = locationDb({ locations: [locationA, locationB] });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        roomId: ROOM_ID,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      message: "Room not found",
    });
    await expect(
      resolveAppointmentLocation(db as never, {
        practiceId: PRACTICE_ID,
        doctorId: DOCTOR_ID,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "NOT_FOUND",
      message: "Doctor not found",
    });
  });
});
