import { z } from "zod";
import { eq, and, isNull, gte, lte, lt, gt, sql, desc, not, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import type { Database } from "@openpims/db/client";
import {
  appointments,
  appointmentTypes,
  patients,
  clients,
  practices,
  users,
  rooms,
  recurringSeries,
  visitCloseouts,
  communications,
} from "@openpims/db";
import {
  detectConflicts,
  conflictMessage,
  hasConflict,
  type ExistingBooking,
} from "@/lib/scheduling/conflicts";
import { findOpenSlots } from "@/lib/scheduling/availability";
import {
  dateInputDayUtcRange,
  formatDateInputForTimeZone,
  dateInputTimeUtcInstant,
} from "@/lib/date-input";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { appointmentCreatedWebhookPayload } from "@/lib/appointment-webhooks";
import {
  clinicalDateInput,
  isValidClinicalDateInput,
} from "@/lib/records/clinical-inputs";
import {
  APPOINTMENT_DURATION_MAX_MINUTES,
  APPOINTMENT_DURATION_MIN_MINUTES,
  APPOINTMENT_NOTES_MAX_LENGTH,
  APPOINTMENT_RECURRENCE_INTERVAL_MAX,
  APPOINTMENT_RECURRENCE_INTERVAL_MIN,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MAX,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MIN,
  isAppointmentDateTimeRangeValid,
} from "@/lib/scheduling/appointment-policy";
import {
  appointmentStatusValues,
  canTransitionAppointmentStatus,
} from "@/lib/scheduling/appointment-status";
import { generateCalendarFeedToken } from "@/lib/calendar/tokens";
import { appBaseUrl } from "@/lib/app-url";
import { recordActivationAfterAppointmentCreated } from "@/lib/funnel-events-server";
import { CLOSEOUT_BYPASS_MESSAGE } from "@/lib/encounters/closeout-policy";

type AppointmentsContext = {
  db: Database;
  practiceId: string;
};

const appointmentDateTimeInput = z.string().datetime({ offset: true });
const appointmentNotesInput = z
  .string()
  .trim()
  .max(
    APPOINTMENT_NOTES_MAX_LENGTH,
    `Appointment notes must be at most ${APPOINTMENT_NOTES_MAX_LENGTH} characters.`
  )
  .optional()
  .transform((value) => value || undefined);
const appointmentStatusInput = z.enum(appointmentStatusValues);
const confirmationContactMethodInput = z.enum(["phone", "email"]);
const appointmentRangeInput = z.string().refine(
  (value) =>
    isValidClinicalDateInput(value) ||
    appointmentDateTimeInput.safeParse(value).success,
  "Date range values must be valid YYYY-MM-DD dates or ISO datetimes with offsets."
);

const listAppointmentsInput = z
  .object({
    startDate: appointmentRangeInput,
    endDate: appointmentRangeInput,
    doctorId: z.string().uuid().optional(),
  })
  .superRefine((input, ctx) => {
    if (appointmentRangeEnd(input.endDate) < appointmentRangeStart(input.startDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after start date.",
      });
    }
  });

const createAppointmentInput = z
  .object({
    startTime: appointmentDateTimeInput,
    endTime: appointmentDateTimeInput,
    typeId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    clientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    notes: appointmentNotesInput,
  })
  .superRefine((input, ctx) => {
    if (!isAppointmentDateTimeRangeValid(input.startTime, input.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Appointment duration must be between ${APPOINTMENT_DURATION_MIN_MINUTES} and ${APPOINTMENT_DURATION_MAX_MINUTES} minutes.`,
      });
    }
  });

const rescheduleAppointmentInput = z
  .object({
    id: z.string().uuid(),
    startTime: appointmentDateTimeInput,
    endTime: appointmentDateTimeInput,
    doctorId: z.string().uuid().nullable().optional(),
    roomId: z.string().uuid().nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (!isAppointmentDateTimeRangeValid(input.startTime, input.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Appointment duration must be between ${APPOINTMENT_DURATION_MIN_MINUTES} and ${APPOINTMENT_DURATION_MAX_MINUTES} minutes.`,
      });
    }
  });

const availableSlotsInput = z
  .object({
    date: clinicalDateInput("Date"),
    durationMinutes: z
      .number()
      .int()
      .min(APPOINTMENT_DURATION_MIN_MINUTES)
      .max(APPOINTMENT_DURATION_MAX_MINUTES)
      .default(30),
    stepMinutes: z.number().int().min(5).max(240).optional(),
    doctorId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    dayStartHour: z.number().int().min(0).max(23).default(8),
    dayEndHour: z.number().int().min(1).max(24).default(18),
  })
  .superRefine((input, ctx) => {
    if (input.dayEndHour <= input.dayStartHour) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dayEndHour"],
        message: "Day end hour must be after day start hour.",
      });
    }
  });

const createRecurringInput = z
  .object({
    patientId: z.string().uuid(),
    clientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    typeId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    startTime: appointmentDateTimeInput,
    endTime: appointmentDateTimeInput,
    frequency: z.enum(["weekly", "monthly", "annual"]),
    interval: z
      .number()
      .int()
      .min(APPOINTMENT_RECURRENCE_INTERVAL_MIN)
      .max(APPOINTMENT_RECURRENCE_INTERVAL_MAX),
    occurrences: z
      .number()
      .int()
      .min(APPOINTMENT_RECURRENCE_OCCURRENCES_MIN)
      .max(APPOINTMENT_RECURRENCE_OCCURRENCES_MAX),
    notes: appointmentNotesInput,
  })
  .superRefine((input, ctx) => {
    if (!isAppointmentDateTimeRangeValid(input.startTime, input.endTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Appointment duration must be between ${APPOINTMENT_DURATION_MIN_MINUTES} and ${APPOINTMENT_DURATION_MAX_MINUTES} minutes.`,
      });
    }
  });

function appointmentRangeStart(
  value: string,
  timeZone?: string | null
): Date {
  if (!isValidClinicalDateInput(value)) return new Date(value);
  if (timeZone) return dateInputDayUtcRange(value, timeZone).start;
  return new Date(`${value}T00:00:00.000Z`);
}

function appointmentRangeEnd(
  value: string,
  timeZone?: string | null
): Date {
  if (!isValidClinicalDateInput(value)) return new Date(value);
  if (timeZone) {
    const { end } = dateInputDayUtcRange(value, timeZone);
    return new Date(end.getTime() - 1);
  }
  return new Date(`${value}T23:59:59.999Z`);
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function appointmentConfirmationDedupeKey(input: {
  practiceId: string;
  appointmentId: string;
  scheduledStateUpdatedAt: Date;
}): string {
  return `appointment-confirmation:v1:${input.practiceId}:${input.appointmentId}:${input.scheduledStateUpdatedAt.getTime()}`;
}

async function assertActivePractice(ctx: AppointmentsContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
}

async function practiceTimeZone(
  ctx: AppointmentsContext
): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }

  return practice.timezone ?? null;
}

async function appointmentListRange(
  ctx: AppointmentsContext,
  input: z.infer<typeof listAppointmentsInput>
): Promise<{ start: Date; end: Date }> {
  const hasDateOnlyRange =
    isValidClinicalDateInput(input.startDate) ||
    isValidClinicalDateInput(input.endDate);
  const timezone = hasDateOnlyRange ? await practiceTimeZone(ctx) : null;

  return {
    start: appointmentRangeStart(input.startDate, timezone),
    end: appointmentRangeEnd(input.endDate, timezone),
  };
}

async function assertClientBelongsToPractice(
  ctx: AppointmentsContext,
  clientId: string
) {
  const [client] = await ctx.db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);

  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }

  return client;
}

async function assertPatientBelongsToPractice(
  ctx: AppointmentsContext,
  patientId: string
) {
  const [patient] = await ctx.db
    .select({ id: patients.id, clientId: patients.clientId })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }

  return patient;
}

async function assertAppointmentTypeBelongsToPractice(
  ctx: AppointmentsContext,
  typeId: string
) {
  const [type] = await ctx.db
    .select({ id: appointmentTypes.id })
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.id, typeId),
        eq(appointmentTypes.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(appointmentTypes.deletedAt)
      )
    )
    .limit(1);

  if (!type) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Appointment type not found",
    });
  }

  return type;
}

async function assertDoctorBelongsToPractice(
  ctx: AppointmentsContext,
  doctorId: string
) {
  const [doctor] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, doctorId),
        eq(users.practiceId, ctx.practiceId),
        eq(users.role, "veterinarian"),
        activePracticePredicate(ctx.practiceId),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!doctor) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Doctor not found" });
  }

  return doctor;
}

async function assertRoomBelongsToPractice(
  ctx: AppointmentsContext,
  roomId: string
) {
  const [room] = await ctx.db
    .select({ id: rooms.id })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(rooms.deletedAt)
      )
    )
    .limit(1);

  if (!room) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
  }

  return room;
}

async function assertAppointmentTargets(
  ctx: AppointmentsContext,
  input: {
    patientId?: string;
    clientId?: string;
    typeId?: string;
    doctorId?: string | null;
    roomId?: string | null;
  }
): Promise<{ clientId?: string }> {
  let patientClientId: string | undefined;
  if (input.patientId) {
    const patient = await assertPatientBelongsToPractice(ctx, input.patientId);
    patientClientId = patient.clientId;
  }

  const clientId = input.clientId ?? patientClientId;
  if (input.clientId && patientClientId && input.clientId !== patientClientId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }
  if (clientId) {
    await assertClientBelongsToPractice(ctx, clientId);
  }
  if (input.typeId) {
    await assertAppointmentTypeBelongsToPractice(ctx, input.typeId);
  }
  if (input.doctorId) {
    await assertDoctorBelongsToPractice(ctx, input.doctorId);
  }
  if (input.roomId) {
    await assertRoomBelongsToPractice(ctx, input.roomId);
  }

  return { clientId };
}

/** Fetch blocking appointments overlapping [start, end) for conflict checks. */
async function fetchOverlapping(
  db: Database,
  practiceId: string,
  start: Date,
  end: Date,
  excludeId?: string
): Promise<ExistingBooking[]> {
  const rows = await db
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      doctorId: appointments.doctorId,
      roomId: appointments.roomId,
      status: appointments.status,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(appointments.deletedAt),
        not(inArray(appointments.status, ["cancelled", "no_show"])),
        // Strict time overlap pre-filter; detectConflicts re-checks precisely.
        lt(appointments.startTime, end),
        gt(appointments.endTime, start)
      )
    );
  return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
}

export const appointmentsRouter = createRouter({
  list: protectedProcedure
    .input(listAppointmentsInput)
    .query(async ({ ctx, input }) => {
      const range = await appointmentListRange(ctx, input);
      const conditions = [
        eq(appointments.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(appointments.deletedAt),
        gte(appointments.startTime, range.start),
        lte(appointments.startTime, range.end),
      ];

      if (input.doctorId) {
        conditions.push(eq(appointments.doctorId, input.doctorId));
      }

      return ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          status: appointments.status,
          notes: appointments.notes,
          recurringSeriesId: appointments.recurringSeriesId,
          patientName: patients.name,
          patientSpecies: patients.species,
          patientId: appointments.patientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          clientId: appointments.clientId,
          doctorName: users.name,
          doctorId: appointments.doctorId,
          typeName: appointmentTypes.name,
          typeColor: appointmentTypes.color,
          typeDuration: appointmentTypes.durationMinutes,
          typeRequiresDoctor: appointmentTypes.requiresDoctor,
          roomName: rooms.name,
          roomId: appointments.roomId,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointments.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, ctx.practiceId),
            isNull(rooms.deletedAt)
          )
        )
        .where(and(...conditions))
        .orderBy(appointments.startTime);
    }),

  /** A patient's visit history (newest first) for the patient chart. */
  listByPatient: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          status: appointments.status,
          notes: appointments.notes,
          doctorName: users.name,
          typeName: appointmentTypes.name,
          typeColor: appointmentTypes.color,
        })
        .from(appointments)
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointments.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .where(
          and(
            eq(appointments.patientId, input.patientId),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .orderBy(desc(appointments.startTime))
        .limit(input.limit);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [appt] = await ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          status: appointments.status,
          notes: appointments.notes,
          recurringSeriesId: appointments.recurringSeriesId,
          patientName: patients.name,
          patientSpecies: patients.species,
          patientId: appointments.patientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientId: appointments.clientId,
          doctorName: users.name,
          doctorId: appointments.doctorId,
          typeName: appointmentTypes.name,
          typeColor: appointmentTypes.color,
          typeRequiresDoctor: appointmentTypes.requiresDoctor,
          roomName: rooms.name,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointments.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, ctx.practiceId),
            isNull(rooms.deletedAt)
          )
        )
        .where(
          and(
            eq(appointments.id, input.id),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);

      if (!appt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }
      return appt;
    }),

  create: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(createAppointmentInput)
    .mutation(async ({ ctx, input }) => {
      const startTime = new Date(input.startTime);
      const endTime = new Date(input.endTime);
      if (endTime <= startTime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End time must be after start time.",
        });
      }

      const targets = await assertAppointmentTargets(ctx, input);
      if (
        !input.patientId &&
        !input.clientId &&
        !input.typeId &&
        !input.doctorId &&
        !input.roomId
      ) {
        await assertActivePractice(ctx);
      }

      // Conflict check across both the doctor and the room.
      if (input.doctorId || input.roomId) {
        const existing = await fetchOverlapping(
          ctx.db,
          ctx.practiceId,
          startTime,
          endTime
        );
        const result = detectConflicts(
          { startTime, endTime, doctorId: input.doctorId, roomId: input.roomId },
          existing
        );
        const message = conflictMessage(result);
        if (message) throw new TRPCError({ code: "CONFLICT", message });
      }

      const [appt] = await ctx.db
        .insert(appointments)
        .values({
          ...input,
          clientId: targets.clientId,
          startTime,
          endTime,
          practiceId: ctx.practiceId,
        })
        .returning();
      await recordActivationAfterAppointmentCreated(
        ctx.db,
        ctx.practiceId,
        "appointments.create"
      );
      await dispatchWebhookEvent(
        ctx.practiceId,
        "appointment.created",
        appointmentCreatedWebhookPayload(appt!, "dashboard")
      );
      return appt!;
    }),

  updateStatus: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: appointmentStatusInput,
        confirmationContactMethod: confirmationContactMethodInput.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { current, appt } = await ctx.db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            doctorId: appointments.doctorId,
            clientId: appointments.clientId,
            startTime: appointments.startTime,
            updatedAt: appointments.updatedAt,
            typeRequiresDoctor: appointmentTypes.requiresDoctor,
          })
          .from(appointments)
          .leftJoin(
            appointmentTypes,
            and(
              eq(appointments.typeId, appointmentTypes.id),
              eq(appointmentTypes.practiceId, ctx.practiceId),
              isNull(appointmentTypes.deletedAt)
            )
          )
          .where(
            and(
              eq(appointments.id, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt)
            )
          )
          // PostgreSQL cannot lock the nullable side of the appointment type
          // LEFT JOIN. Lock only the appointment row that owns the status
          // transition; the type row is read solely for policy metadata.
          .for("update", { of: appointments });

        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Appointment not found",
          });
        }
        if (input.status === "checked_out") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: CLOSEOUT_BYPASS_MESSAGE,
          });
        }
        if (!canTransitionAppointmentStatus(current.status, input.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot change appointment status from ${current.status} to ${input.status}.`,
          });
        }
        if (
          (input.status === "confirmed" || input.status === "checked_in") &&
          current.typeRequiresDoctor === 1 &&
          !current.doctorId
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              input.status === "confirmed"
                ? "Assign a doctor before confirming this appointment."
                : "Assign a doctor before checking in this appointment.",
          });
        }
        const isNewConfirmation =
          current.status !== "confirmed" && input.status === "confirmed";
        let confirmationRecord:
          | {
              clientId: string;
              channel: "phone" | "email";
              content: string;
              dedupeKey: string;
            }
          | undefined;
        if (isNewConfirmation) {
          if (!input.confirmationContactMethod) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Contact the client and record phone or email confirmation before confirming this appointment.",
            });
          }
          if (!current.clientId) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "Assign an active client before confirming this appointment.",
            });
          }
          const [client] = await tx
            .select({
              id: clients.id,
              email: clients.email,
              phone: clients.phone,
            })
            .from(clients)
            .where(
              and(
                eq(clients.id, current.clientId),
                eq(clients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(clients.deletedAt)
              )
            )
            .limit(1);
          if (!client) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Client not found",
            });
          }
          const contactAddress =
            input.confirmationContactMethod === "phone"
              ? client.phone?.trim()
              : client.email?.trim();
          if (!contactAddress) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                input.confirmationContactMethod === "phone"
                  ? "Add a client phone number or record email confirmation instead."
                  : "Add a client email address or record phone confirmation instead.",
            });
          }
          confirmationRecord = {
            clientId: client.id,
            channel: input.confirmationContactMethod,
            content: `Staff recorded that the client agreed by ${input.confirmationContactMethod} to the appointment scheduled for ${current.startTime.toISOString()}.`,
            dedupeKey: appointmentConfirmationDedupeKey({
              practiceId: ctx.practiceId,
              appointmentId: current.id,
              scheduledStateUpdatedAt: current.updatedAt,
            }),
          };
        }

        const [closeout] = await tx
          .select({ id: visitCloseouts.id, status: visitCloseouts.status })
          .from(visitCloseouts)
          .where(
            and(
              eq(visitCloseouts.appointmentId, input.id),
              eq(visitCloseouts.practiceId, ctx.practiceId),
              isNull(visitCloseouts.deletedAt)
            )
          )
          .limit(1);
        if (
          closeout?.status === "clinical_finalized" ||
          closeout?.status === "completed"
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Clinical handoff is finalized. Complete the visit through closeout instead of changing its status.",
          });
        }

        if (confirmationRecord) {
          await tx.insert(communications).values({
            practiceId: ctx.practiceId,
            clientId: confirmationRecord.clientId,
            channel: confirmationRecord.channel,
            direction: "outbound",
            subject: "Appointment confirmation recorded",
            content: confirmationRecord.content,
            status: "sent",
            assignedTo: ctx.user.id,
            dedupeKey: confirmationRecord.dedupeKey,
          });
        }

        const [appt] = await tx
          .update(appointments)
          .set({ status: input.status })
          .where(
            and(
              eq(appointments.id, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              eq(appointments.status, current.status),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt)
            )
          )
          .returning();
        if (!appt) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Appointment status changed; try again.",
          });
        }
        if (
          closeout?.status === "draft" &&
          (input.status === "cancelled" || input.status === "no_show")
        ) {
          const now = new Date();
          await tx
            .update(visitCloseouts)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(visitCloseouts.id, closeout.id),
                eq(visitCloseouts.practiceId, ctx.practiceId),
                eq(visitCloseouts.status, "draft"),
                isNull(visitCloseouts.deletedAt)
              )
            );
        }
        return { current, appt };
      });
      if (appt.status === "checked_in") {
        await dispatchWebhookEvent(ctx.practiceId, "appointment.checked_in", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      if (appt.status === "cancelled") {
        await dispatchWebhookEvent(ctx.practiceId, "appointment.cancelled", {
          id: appt.id,
          appointmentId: appt.id,
          startTime: appt.startTime,
          endTime: appt.endTime,
          status: appt.status,
          previousStatus: current.status,
          patientId: appt.patientId,
          clientId: appt.clientId,
          doctorId: appt.doctorId,
          typeId: appt.typeId,
          source: "dashboard",
        });
      }
      return appt;
    }),

  cancelRecurringSeries: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(z.object({ seriesId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      const result = await ctx.db.transaction(async (tx) => {
        const [series] = await tx
          .update(recurringSeries)
          .set({ deletedAt: now })
          .where(
            and(
              eq(recurringSeries.id, input.seriesId),
              eq(recurringSeries.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(recurringSeries.deletedAt)
            )
          )
          .returning({ id: recurringSeries.id });

        if (!series) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Recurring series not found",
          });
        }

        const cancelled = await tx
          .update(appointments)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(appointments.recurringSeriesId, input.seriesId),
              isNull(appointments.deletedAt),
              gte(appointments.startTime, now),
              inArray(appointments.status, ["scheduled", "confirmed"])
            )
          )
          .returning({
            id: appointments.id,
            startTime: appointments.startTime,
            endTime: appointments.endTime,
            status: appointments.status,
            patientId: appointments.patientId,
            clientId: appointments.clientId,
            doctorId: appointments.doctorId,
            typeId: appointments.typeId,
            recurringSeriesId: appointments.recurringSeriesId,
          });

        return { seriesId: series.id, cancelled };
      });

      await Promise.all(
        result.cancelled.map((appt) =>
          dispatchWebhookEvent(ctx.practiceId, "appointment.cancelled", {
            id: appt.id,
            appointmentId: appt.id,
            startTime: appt.startTime,
            endTime: appt.endTime,
            status: appt.status,
            patientId: appt.patientId,
            clientId: appt.clientId,
            doctorId: appt.doctorId,
            typeId: appt.typeId,
            recurringSeriesId: appt.recurringSeriesId,
            source: "recurring_series",
          })
        )
      );

      return {
        seriesId: result.seriesId,
        cancelledCount: result.cancelled.length,
      };
    }),

  reschedule: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(rescheduleAppointmentInput)
    .mutation(async ({ ctx, input }) => {
      const startTime = new Date(input.startTime);
      const endTime = new Date(input.endTime);
      if (endTime <= startTime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End time must be after start time.",
        });
      }

      const [current] = await ctx.db
        .select({
          id: appointments.id,
          status: appointments.status,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          patientId: appointments.patientId,
          clientId: appointments.clientId,
          doctorId: appointments.doctorId,
          roomId: appointments.roomId,
          typeId: appointments.typeId,
          typeRequiresDoctor: appointmentTypes.requiresDoctor,
        })
        .from(appointments)
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointments.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .where(
          and(
            eq(appointments.id, input.id),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);
      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }
      if (current.status !== "scheduled" && current.status !== "confirmed") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only scheduled or confirmed appointments can be rescheduled.",
        });
      }

      // Fall back to the appointment's existing doctor/room when not changing them.
      const doctorId =
        input.doctorId === undefined ? current.doctorId : input.doctorId;
      const roomId = input.roomId === undefined ? current.roomId : input.roomId;
      const timeChanged =
        current.startTime.getTime() !== startTime.getTime() ||
        current.endTime.getTime() !== endTime.getTime();
      const confirmationRequired =
        current.status === "confirmed" && timeChanged;
      await assertAppointmentTargets(ctx, {
        doctorId: input.doctorId,
        roomId: input.roomId,
      });
      if (
        current.status === "confirmed" &&
        !confirmationRequired &&
        current.typeRequiresDoctor === 1 &&
        !doctorId
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Assign a doctor before saving a confirmed appointment.",
        });
      }

      if (doctorId || roomId) {
        const existing = await fetchOverlapping(
          ctx.db,
          ctx.practiceId,
          startTime,
          endTime,
          input.id // exclude the appointment being moved
        );
        const result = detectConflicts(
          { startTime, endTime, doctorId, roomId, excludeId: input.id },
          existing
        );
        const message = conflictMessage(result);
        if (message) throw new TRPCError({ code: "CONFLICT", message });
      }

      const [updated] = await ctx.db
        .update(appointments)
        .set({
          startTime,
          endTime,
          doctorId: doctorId ?? null,
          roomId: roomId ?? null,
          status: confirmationRequired ? "scheduled" : current.status,
        })
        .where(
          and(
            eq(appointments.id, input.id),
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.status, current.status),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Appointment changed while rescheduling. Refresh and try again.",
        });
      }
      await dispatchWebhookEvent(ctx.practiceId, "appointment.rescheduled", {
        id: updated.id,
        appointmentId: updated.id,
        previousStartTime: current.startTime,
        previousEndTime: current.endTime,
        startTime: updated.startTime,
        endTime: updated.endTime,
        status: updated.status,
        patientId: updated.patientId,
        clientId: updated.clientId,
        doctorId: updated.doctorId,
        roomId: updated.roomId,
        typeId: updated.typeId,
        source: "dashboard",
      });
      return { ...updated, confirmationRequired };
    }),

  /** Open slots on a given date for a doctor and/or room. */
  availableSlots: protectedProcedure
    .input(availableSlotsInput)
    .query(async ({ ctx, input }) => {
      const timezone = await practiceTimeZone(ctx);
      const dayStart = dateInputTimeUtcInstant(
        input.date,
        { hour: input.dayStartHour },
        timezone
      );
      const dayEnd = dateInputTimeUtcInstant(
        input.date,
        { hour: input.dayEndHour },
        timezone
      );

      await assertAppointmentTargets(ctx, {
        doctorId: input.doctorId,
        roomId: input.roomId,
      });

      const existing = await fetchOverlapping(ctx.db, ctx.practiceId, dayStart, dayEnd);
      // Only the chosen doctor/room blocks availability; if neither given, any
      // booking on the day blocks (treat the schedule as a single resource).
      const busy = existing.filter((b) => {
        if (input.doctorId && b.doctorId === input.doctorId) return true;
        if (input.roomId && b.roomId === input.roomId) return true;
        return !input.doctorId && !input.roomId;
      });

      return findOpenSlots({
        dayStart,
        dayEnd,
        slotMinutes: input.durationMinutes,
        stepMinutes: input.stepMinutes,
        busy,
      });
    }),

  listTypes: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(appointmentTypes)
      .where(
        and(
          eq(appointmentTypes.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointmentTypes.deletedAt)
        )
      );
  }),

  listDoctors: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: users.id,
        name: users.name,
      })
      .from(users)
      .where(
        and(
          eq(users.practiceId, ctx.practiceId),
          eq(users.role, "veterinarian"),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt)
        )
      );
  }),

  listRooms: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(rooms.deletedAt)
        )
      );
  }),

  calendarSettings: protectedProcedure.query(async ({ ctx }) => ({
    timezone: await practiceTimeZone(ctx),
  })),

  createRecurring: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(createRecurringInput)
    .mutation(async ({ ctx, input }) => {
      // Calculate the duration of a single appointment
      const firstStart = new Date(input.startTime);
      const firstEnd = new Date(input.endTime);
      const durationMs = firstEnd.getTime() - firstStart.getTime();

      if (durationMs <= 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End time must be after start time.",
        });
      }

      const result = await ctx.db.transaction(async (tx) => {
        const txCtx = { ...ctx, db: tx as unknown as Database };
        const targets = await assertAppointmentTargets(txCtx, input);
        const timezone = await practiceTimeZone(txCtx);

        // Create the recurring series record and its appointments atomically so
        // a failed occurrence insert cannot leave a partial series behind.
        const lastOccurrenceDate = computeOccurrenceDate(
          firstStart,
          input.frequency,
          input.interval,
          input.occurrences - 1,
          timezone
        );

        const [series] = await tx
          .insert(recurringSeries)
          .values({
            practiceId: ctx.practiceId,
            frequency: input.frequency,
            interval: input.interval,
            endDate: formatDateInputForTimeZone(
              lastOccurrenceDate,
              resolveRecurrenceTimeZone(timezone)
            ),
          })
          .returning();

        let created = 0;
        let skipped = 0;

        for (let i = 0; i < input.occurrences; i++) {
          const occStart = computeOccurrenceDate(
            firstStart,
            input.frequency,
            input.interval,
            i,
            timezone
          );
          const occEnd = new Date(occStart.getTime() + durationMs);

          // Skip an occurrence that conflicts on either the doctor or the room.
          if (input.doctorId || input.roomId) {
            const existing = await fetchOverlapping(
              txCtx.db,
              ctx.practiceId,
              occStart,
              occEnd
            );
            const result = detectConflicts(
              {
                startTime: occStart,
                endTime: occEnd,
                doctorId: input.doctorId,
                roomId: input.roomId,
              },
              existing
            );
            if (hasConflict(result)) {
              skipped++;
              continue;
            }
          }

          await tx.insert(appointments).values({
            practiceId: ctx.practiceId,
            patientId: input.patientId,
            clientId: targets.clientId,
            doctorId: input.doctorId,
            typeId: input.typeId,
            roomId: input.roomId,
            startTime: occStart,
            endTime: occEnd,
            notes: input.notes,
            recurringSeriesId: series!.id,
          });

          created++;
        }

        return { seriesId: series!.id, created, skipped };
      });
      if (result.created > 0) {
        await recordActivationAfterAppointmentCreated(
          ctx.db,
          ctx.practiceId,
          "appointments.createRecurring"
        );
      }
      return result;
    }),

  // ── ICS calendar feed ─────────────────────────────────────
  // A practice-wide read-only "subscribe by URL" feed (Google, Apple,
  // Outlook). One shared clinic calendar: same trust boundary as the
  // whiteboard, so any staff member may read or turn on the URL. The token
  // is a capability; rotation (admin-only) invalidates the old URL.

  /** Current feed URL, or null when the feed has not been turned on. */
  calendarFeed: protectedProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ token: practices.calendarFeedToken })
      .from(practices)
      .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
      .limit(1);
    if (!practice) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
    }
    return { url: calendarFeedUrl(practice.token) };
  }),

  /**
   * Turn the feed on. Idempotent under concurrency: COALESCE keeps the
   * first token ever written, so double-clicks and racing staff both get
   * the same URL back. (Viewers are blocked by the global mutation guard.)
   */
  enableCalendarFeed: protectedProcedure.mutation(async ({ ctx }) => {
    const candidate = generateCalendarFeedToken();
    const [updated] = await ctx.db
      .update(practices)
      .set({
        calendarFeedToken: sql`coalesce(${practices.calendarFeedToken}, ${candidate})`,
      })
      .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
      .returning({ token: practices.calendarFeedToken });
    if (!updated?.token) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
    }
    return { url: calendarFeedUrl(updated.token)! };
  }),

  /** Replace the token. The old URL stops working for the whole clinic. */
  rotateCalendarFeed: protectedProcedure
    .use(requireRole("admin"))
    .mutation(async ({ ctx }) => {
      const [updated] = await ctx.db
        .update(practices)
        .set({ calendarFeedToken: generateCalendarFeedToken() })
        .where(
          and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt))
        )
        .returning({ token: practices.calendarFeedToken });
      if (!updated?.token) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Practice not found",
        });
      }
      return { url: calendarFeedUrl(updated.token)! };
    }),
});

function calendarFeedUrl(token: string | null): string | null {
  return token ? `${appBaseUrl()}/api/calendar/${token}.ics` : null;
}

/** Compute the start date/time for the Nth occurrence (0-based). */
function computeOccurrenceDate(
  baseDate: Date,
  frequency: "weekly" | "monthly" | "annual",
  interval: number,
  n: number,
  timeZone?: string | null
): Date {
  const resolvedTimeZone = resolveRecurrenceTimeZone(timeZone);
  const base = recurrenceBaseParts(baseDate, resolvedTimeZone);
  const occurrenceDate = recurrenceDateInput(
    base.dateInput,
    frequency,
    interval,
    n
  );

  return dateInputTimeUtcInstant(
    occurrenceDate,
    {
      hour: base.hour,
      minute: base.minute,
      second: base.second,
    },
    resolvedTimeZone
  );
}

function resolveRecurrenceTimeZone(timeZone?: string | null): string {
  const resolved = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format(
      new Date(0)
    );
    return resolved;
  } catch {
    return "UTC";
  }
}

function recurrenceBaseParts(
  date: Date,
  timeZone: string
): { dateInput: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const second = Number(value("second"));

  if (!year || !month || !day || [hour, minute, second].some(Number.isNaN)) {
    const fallback = new Date(date);
    return {
      dateInput: formatDateInputForTimeZone(fallback, "UTC"),
      hour: fallback.getUTCHours(),
      minute: fallback.getUTCMinutes(),
      second: fallback.getUTCSeconds(),
    };
  }

  return {
    dateInput: `${year}-${month}-${day}`,
    hour,
    minute,
    second,
  };
}

function recurrenceDateInput(
  baseDateInput: string,
  frequency: "weekly" | "monthly" | "annual",
  interval: number,
  n: number
): string {
  const [year, month, day] = baseDateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const d = new Date(Date.UTC(year, month - 1, day));
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7 * interval * n);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + interval * n);
      break;
    case "annual":
      d.setUTCFullYear(d.getUTCFullYear() + interval * n);
      break;
  }
  return formatDateInputForTimeZone(d, "UTC");
}
