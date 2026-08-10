import { NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  not,
  sql,
} from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import {
  appointments,
  appointmentTypes,
  clients,
  patients,
  rooms,
  users,
} from "@openpims/db";
import { authenticateApiKey } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { appointmentCreatedWebhookPayload } from "@/lib/appointment-webhooks";
import { recordActivationAfterAppointmentCreated } from "@/lib/funnel-events-server";
import {
  withErrorHandling,
  apiError,
  validationError,
} from "@/lib/compat/shared/errors";
import { parsePagination, paginated } from "@/lib/compat/shared/pagination";
import { isUuid } from "@/lib/compat/shared/validation";
import { readJsonRequestBody } from "@/lib/request-json";
import {
  appointmentStatusValues,
  type AppointmentStatus,
} from "@/lib/scheduling/appointment-status";
import {
  type AppointmentCreate,
  AppointmentCreateSchema,
  fromApiAppointmentCreate,
  toApiAppointment,
} from "@/lib/compat/openvpm";
import {
  conflictMessage,
  detectConflicts,
  type ExistingBooking,
} from "@/lib/scheduling/conflicts";
import { assertActivePractice } from "@/lib/compat/shared/active-practice";
import { isValidClinicalDateInput } from "@/lib/records/date-input";
import {
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "@/lib/scheduling/location";

export const dynamic = "force-dynamic";

const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function parseStrictIsoAppointmentDate(value: string): Date | null {
  const trimmed = value.trim();
  if (isValidClinicalDateInput(trimmed)) {
    return new Date(`${trimmed}T00:00:00.000Z`);
  }

  const match = ISO_DATE_TIME_RE.exec(trimmed);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = "00", , zone] = match;
  if (!isValidClinicalDateInput(`${year}-${month}-${day}`)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return null;
  }

  if (zone !== "Z") {
    const [, offsetHour, offsetMinute] =
      /^([+-]\d{2}):(\d{2})$/.exec(zone) ?? [];
    if (
      !offsetHour ||
      !offsetMinute ||
      Number(offsetHour.slice(1)) > 23 ||
      Number(offsetMinute) > 59
    ) {
      return null;
    }
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseAppointmentDateParam(
  searchParams: URLSearchParams,
  name: string,
  bound: "start" | "end"
): { ok: true; date?: Date } | { ok: false; response: NextResponse } {
  const raw = searchParams.get(name);
  if (!raw) return { ok: true };
  const date = parseStrictIsoAppointmentDate(raw);
  if (!date) {
    return {
      ok: false,
      response: apiError(
        `${name} must be a valid ISO date or timezone-qualified timestamp`,
        400
      ),
    };
  }
  const trimmed = raw.trim();
  if (bound === "end" && isValidClinicalDateInput(trimmed)) {
    return { ok: true, date: new Date(`${trimmed}T23:59:59.999Z`) };
  }
  return { ok: true, date };
}

function parseAppointmentStatusParam(
  searchParams: URLSearchParams
):
  | { ok: true; status?: AppointmentStatus }
  | { ok: false; response: NextResponse } {
  const raw = searchParams.get("status");
  if (!raw) return { ok: true };
  if (!appointmentStatusValues.includes(raw as AppointmentStatus)) {
    return {
      ok: false,
      response: apiError(
        `status must be one of: ${appointmentStatusValues.join(", ")}`,
        400
      ),
    };
  }
  return { ok: true, status: raw as AppointmentStatus };
}

async function validateAppointmentTargets(
  tx: Database,
  practiceId: string,
  input: AppointmentCreate
): Promise<
  | { ok: true; clientId: string | null }
  | { ok: false; response: NextResponse }
> {
  let patientClientId: string | undefined;
  if (input.patient_id) {
    const [patient] = await tx
      .select({ id: patients.id, clientId: patients.clientId })
      .from(patients)
      .where(
        and(
          eq(patients.id, input.patient_id),
          eq(patients.practiceId, practiceId),
          isNull(patients.deletedAt)
        )
      )
      .limit(1);

    if (!patient) {
      return { ok: false, response: apiError("Patient not found", 404) };
    }
    patientClientId = patient.clientId;
  }

  if (input.client_id && patientClientId && input.client_id !== patientClientId) {
    return { ok: false, response: apiError("Patient not found", 404) };
  }

  const clientId = input.client_id ?? patientClientId;
  if (clientId) {
    const [client] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.practiceId, practiceId),
          isNull(clients.deletedAt)
        )
      )
      .limit(1);
    if (!client) {
      return { ok: false, response: apiError("Client not found", 404) };
    }
  }

  if (input.type_id) {
    const [type] = await tx
      .select({ id: appointmentTypes.id })
      .from(appointmentTypes)
      .where(
        and(
          eq(appointmentTypes.id, input.type_id),
          eq(appointmentTypes.practiceId, practiceId),
          isNull(appointmentTypes.deletedAt)
        )
      )
      .limit(1);
    if (!type) {
      return {
        ok: false,
        response: apiError("Appointment type not found", 404),
      };
    }
  }

  if (input.doctor_id) {
    const [doctor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, input.doctor_id),
          eq(users.practiceId, practiceId),
          eq(users.isVeterinarian, true),
          isNull(users.deletedAt)
        )
      )
      .limit(1);
    if (!doctor) {
      return { ok: false, response: apiError("Doctor not found", 404) };
    }
  }

  if (input.room_id) {
    const [room] = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(
          eq(rooms.id, input.room_id),
          eq(rooms.practiceId, practiceId),
          isNull(rooms.deletedAt)
        )
      )
      .limit(1);
    if (!room) {
      return { ok: false, response: apiError("Room not found", 404) };
    }
  }

  return { ok: true, clientId: clientId ?? null };
}

async function fetchOverlappingAppointments(
  tx: Database,
  practiceId: string,
  startTime: Date,
  endTime: Date
): Promise<ExistingBooking[]> {
  return tx
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      doctorId: appointments.doctorId,
      roomId: appointments.roomId,
      locationId: appointments.locationId,
      status: appointments.status,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.practiceId, practiceId),
        isNull(appointments.deletedAt),
        not(inArray(appointments.status, ["cancelled", "no_show"])),
        lt(appointments.startTime, endTime),
        gt(appointments.endTime, startTime)
      )
    );
}

// GET /api/v1/appointments — list appointments for the authenticated practice.
export async function GET(req: Request) {
  const auth = await authenticateApiKey(req, "appointments:read");
  if (!auth.ok) return auth.response;

  return withErrorHandling(async () => {
    const { searchParams } = new URL(req.url);
    const { limit, offset } = parsePagination(searchParams);
    const clientId = searchParams.get("client_id");
    const patientId = searchParams.get("patient_id");
    const locationId = searchParams.get("location_id");

    if (clientId && !isUuid(clientId)) {
      return apiError("client_id must be a valid UUID", 400);
    }
    if (patientId && !isUuid(patientId)) {
      return apiError("patient_id must be a valid UUID", 400);
    }
    if (locationId && !isUuid(locationId)) {
      return apiError("location_id must be a valid UUID", 400);
    }

    const from = parseAppointmentDateParam(searchParams, "from", "start");
    if (!from.ok) return from.response;
    const to = parseAppointmentDateParam(searchParams, "to", "end");
    if (!to.ok) return to.response;
    if (from.date && to.date && from.date > to.date) {
      return apiError("from must be before or equal to to", 400);
    }
    const status = parseAppointmentStatusParam(searchParams);
    if (!status.ok) return status.response;

    return withTenant(db, auth.ctx.practiceId, async (tx) => {
      const activePractice = await assertActivePractice(tx, auth.ctx.practiceId);
      if (!activePractice.ok) return activePractice.response;

      const conditions = [
        eq(appointments.practiceId, auth.ctx.practiceId),
        isNull(appointments.deletedAt),
      ];
      if (clientId) conditions.push(eq(appointments.clientId, clientId));
      if (patientId) conditions.push(eq(appointments.patientId, patientId));
      if (locationId) conditions.push(eq(appointments.locationId, locationId));
      if (status.status) {
        conditions.push(eq(appointments.status, status.status));
      }
      if (from.date) conditions.push(gte(appointments.startTime, from.date));
      if (to.date) conditions.push(lte(appointments.startTime, to.date));
      const where = and(...conditions);

      const [rows, countResult] = await Promise.all([
        tx
          .select()
          .from(appointments)
          .where(where)
          .orderBy(desc(appointments.startTime))
          .limit(limit)
          .offset(offset),
        tx
          .select({ count: sql<number>`count(*)` })
          .from(appointments)
          .where(where),
      ]);

      const total = Number(countResult[0]?.count ?? 0);
      return NextResponse.json(
        paginated(rows.map(toApiAppointment), { limit, offset }, total)
      );
    });
  });
}

// POST /api/v1/appointments — create an appointment for the authenticated practice.
export async function POST(req: Request) {
  const auth = await authenticateApiKey(req, "appointments:write");
  if (!auth.ok) return auth.response;

  return withErrorHandling(async () => {
    const body = await readJsonRequestBody(req);
    if (!body.ok) {
      if (body.reason === "too_large") {
        return apiError("Request body too large", 413);
      }
      return apiError("Request body must be valid JSON", 400);
    }

    const parsed = AppointmentCreateSchema.safeParse(body.data);
    if (!parsed.success) return validationError(parsed.error);

    const result = await withTenant(db, auth.ctx.practiceId, async (tx) => {
      const activePractice = await assertActivePractice(tx, auth.ctx.practiceId);
      if (!activePractice.ok) {
        return { ok: false as const, response: activePractice.response };
      }

      await takeAppointmentSchedulingLock(tx, auth.ctx.practiceId);

      const targets = await validateAppointmentTargets(
        tx,
        auth.ctx.practiceId,
        parsed.data
      );
      if (!targets.ok) {
        return { ok: false as const, response: targets.response };
      }
      const location = await resolveAppointmentLocation(tx, {
        practiceId: auth.ctx.practiceId,
        locationId: parsed.data.location_id,
        doctorId: parsed.data.doctor_id,
        roomId: parsed.data.room_id,
      });
      if (!location.ok) {
        return {
          ok: false as const,
          response: apiError(
            location.message,
            location.code === "NOT_FOUND" ? 404 : 409,
          ),
        };
      }

      const startTime = new Date(parsed.data.start_time);
      const endTime = new Date(parsed.data.end_time);
      const existing = await fetchOverlappingAppointments(
        tx,
        auth.ctx.practiceId,
        startTime,
        endTime
      );
      const message = conflictMessage(
        detectConflicts(
          {
            startTime,
            endTime,
            doctorId: parsed.data.doctor_id,
            roomId: parsed.data.room_id,
            locationId: location.locationId,
          },
          existing
        )
      );
      if (message) {
        return { ok: false as const, response: apiError(message, 409) };
      }

      const [row] = await tx
        .insert(appointments)
        .values({
          ...fromApiAppointmentCreate(parsed.data),
          clientId: targets.clientId,
          locationId: location.locationId,
          practiceId: auth.ctx.practiceId,
        })
        .returning();
      return { ok: true as const, row: row! };
    });
    if (!result.ok) return result.response;

    await recordActivationAfterAppointmentCreated(
      db,
      auth.ctx.practiceId,
      "api.v1.appointments.POST"
    );

    const apiAppointment = toApiAppointment(result.row);

    await dispatchWebhookEvent(
      auth.ctx.practiceId,
      "appointment.created",
      appointmentCreatedWebhookPayload(result.row, "api")
    );

    return NextResponse.json({ data: apiAppointment }, { status: 201 });
  });
}
