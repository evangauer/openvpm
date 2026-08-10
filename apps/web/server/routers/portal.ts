import { z } from "zod";
import { eq, and, isNull, desc, sql, ne } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure } from "../trpc";
import {
  clients,
  patients,
  patientWeights,
  patientAllergies,
  vaccinationRecords,
  prescriptions,
  appointments,
  appointmentTypes,
  invoiceAdjustments,
  invoices,
  communications,
  practices,
  locations,
} from "@openpims/db";
import { users } from "@openpims/db";
import { rateLimit } from "@/lib/rate-limit";
import {
  appointmentCreatedWebhookPayload,
  dispatchAppointmentWebhookAfterCommit,
} from "@/lib/appointment-webhooks";
import { recordActivationAfterAppointmentCreated } from "@/lib/funnel-events-server";
import {
  assertSlotWithinPortalBookingHours,
  buildRequestedSlot,
  filterFutureOpenSlots,
  PORTAL_BOOKING_MAX_DURATION_MINUTES,
  PORTAL_BOOKING_MIN_DURATION_MINUTES,
  PORTAL_BOOKING_REASON_MAX_LENGTH,
  portalBookingWindow,
} from "@/lib/portal/booking";
import { findOpenSlots } from "@/lib/scheduling/availability";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { getChargeableStripeConnectAccountId } from "@/lib/billing/payment-accounts";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";
import {
  PORTAL_ACCESS_TOKEN_MAX_LENGTH,
  portalRateLimitKey,
} from "@/lib/portal/tokens";
import {
  centsToMoney,
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";
import { COMMUNICATION_CONTENT_MAX_LENGTH } from "@/lib/communications/policy";
import { latestAssignedToForClient } from "@/lib/communications/assignment";
import { stripeConfigured } from "@/lib/stripe-config";
import { not, inArray, lt, gt } from "drizzle-orm";
import { gte, or } from "drizzle-orm";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import {
  listActiveAppointmentLocations,
  resolveAppointmentLocation,
  takeAppointmentSchedulingLock,
} from "@/lib/scheduling/location";

const portalBookingDateInput = clinicalDateInput("Booking date");
const portalBookingTimeInput = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "Booking time must be in 24-hour HH:MM format.",
  });
const portalTokenInput = z
  .string()
  .trim()
  .min(1)
  .max(PORTAL_ACCESS_TOKEN_MAX_LENGTH);
const portalMessageContentInput = z
  .string()
  .trim()
  .min(1, "Message content is required")
  .max(
    COMMUNICATION_CONTENT_MAX_LENGTH,
    `Message content must be at most ${COMMUNICATION_CONTENT_MAX_LENGTH} characters.`
  );
const PORTAL_READ_RATE_LIMIT = {
  limit: 120,
  windowMs: 15 * 60 * 1000,
  message:
    "Too many portal requests. Please try again later or call the clinic.",
};
const PORTAL_READ_IP_RATE_LIMIT = {
  limit: 300,
  windowMs: 15 * 60 * 1000,
  message:
    "Too many portal requests. Please try again later or call the clinic.",
};
const PORTAL_SLOTS_IP_RATE_LIMIT = {
  limit: 120,
  windowMs: 15 * 60 * 1000,
  message:
    "Too many availability requests. Please try again later or call the clinic.",
};
const PORTAL_BOOK_IP_RATE_LIMIT = {
  limit: 20,
  windowMs: 60 * 60 * 1000,
  message: "Too many requests. Please try again later or call the clinic.",
};
const PORTAL_MESSAGE_IP_RATE_LIMIT = {
  limit: 30,
  windowMs: 60 * 60 * 1000,
  message:
    "Too many portal messages. Please try again later or call the clinic.",
};
const PORTAL_MESSAGE_TOKEN_RATE_LIMIT = {
  limit: 10,
  windowMs: 60 * 60 * 1000,
  message:
    "Too many portal messages. Please try again later or call the clinic.",
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function invalidPortalLink(): TRPCError {
  return new TRPCError({
    code: "NOT_FOUND",
    message: "Invalid portal link",
  });
}

async function assertPortalRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
  message: string;
}) {
  try {
    const { success } = await rateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: input.windowMs,
    });
    if (success) return;
  } catch (err) {
    console.error("[portal] rate limit failed:", err);
  }

  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: input.message,
  });
}

async function assertPortalReadRateLimit(token: string) {
  await assertPortalRateLimit({
    key: portalRateLimitKey("portal-read", token),
    ...PORTAL_READ_RATE_LIMIT,
  });
}

async function assertPortalIpRateLimit(
  ip: string | null | undefined,
  input: {
    keyPrefix: string;
    limit: number;
    windowMs: number;
    message: string;
  }
) {
  const clientIp = ip || "unknown";
  await assertPortalRateLimit({
    key: `${input.keyPrefix}:ip:${clientIp}`,
    limit: input.limit,
    windowMs: input.windowMs,
    message: input.message,
  });
}

async function getClientByToken(db: any, token: string) {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.accessToken, token), isNull(clients.deletedAt)))
    .limit(1);

  if (!client) {
    throw invalidPortalLink();
  }

  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(client.practiceId))
    .limit(1);

  if (!practice) {
    throw invalidPortalLink();
  }

  return client;
}

async function practiceTimeZone(
  db: any,
  practiceId: string
): Promise<string | null> {
  const [practice] = await db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);
  if (!practice) {
    throw invalidPortalLink();
  }
  return practice.timezone ?? null;
}

async function practicePortalProfile(db: any, practiceId: string) {
  const [practice] = await db
    .select({
      name: practices.name,
      address: practices.address,
      phone: practices.phone,
      email: practices.email,
      timezone: practices.timezone,
    })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    throw invalidPortalLink();
  }

  return {
    name: practice.name?.trim() || "Veterinary Practice",
    address: practice.address ?? null,
    phone: practice.phone ?? null,
    email: practice.email ?? null,
    timezone: practice.timezone ?? null,
  };
}

function formatPortalSlotTime(date: Date, timeZone?: string | null): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date);
      const hour = parts.find((part) => part.type === "hour")?.value;
      const minute = parts.find((part) => part.type === "minute")?.value;
      if (hour && minute) return `${hour}:${minute}`;
    } catch {
      // Fall back to the runtime's local time if a saved timezone is invalid.
    }
  }

  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

function formatPortalRequestDateTime(
  date: string,
  time: string,
  timeZone?: string | null
): string {
  return timeZone ? `${date} ${time} (${timeZone})` : `${date} ${time}`;
}

async function assertPortalWriteAccess(
  db: any,
  practiceId: string,
  action: "booking" | "messaging" = "booking"
) {
  const [practice] = await db
    .select({
      tier: practices.subscriptionTier,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
    })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);
  if (!practice) {
    throw invalidPortalLink();
  }
  if (!billingEnforced()) return;
  if (
    !hasHostedFullAccess(
      practice.tier,
      practice.billingStatus,
      practice.trialEndsAt
    )
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        action === "messaging"
          ? "Portal messaging is unavailable until this practice's Cloud subscription is active."
          : "Online booking is unavailable until this practice's Cloud subscription is active.",
    });
  }
}

export const portalRouter = createRouter({
  getClient: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);
      const timezone = await practiceTimeZone(ctx.db, client.practiceId);
      const appointmentLocations = await listActiveAppointmentLocations(
        ctx.db,
        client.practiceId,
      );

      const clientPatients = await ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          dob: patients.dob,
          color: patients.color,
          sex: patients.sex,
          photoUrl: patients.photoUrl,
          status: patients.status,
        })
        .from(patients)
        .where(
          and(
            eq(patients.clientId, client.id),
            eq(patients.practiceId, client.practiceId),
            isNull(patients.deletedAt),
            eq(patients.status, "active")
          )
        );

      return {
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        timezone,
        locations: appointmentLocations,
        patients: clientPatients,
      };
    }),

  getPetDetail: publicProcedure
    .input(
      z.object({
        token: portalTokenInput,
        patientId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);
      const practice = await practicePortalProfile(ctx.db, client.practiceId);
      const practiceToday = formatDateInputForTimeZone(
        new Date(),
        practice.timezone
      );

      const [patient] = await ctx.db
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.clientId, client.id),
            eq(patients.practiceId, client.practiceId),
            eq(patients.status, "active"),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!patient) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Pet not found",
        });
      }

      const [weights, allergies, vaccinations, activeRx] = await Promise.all([
        ctx.db
          .select({
            id: patientWeights.id,
            weightKg: patientWeights.weightKg,
            recordedAt: patientWeights.recordedAt,
          })
          .from(patientWeights)
          .innerJoin(
            patients,
            and(
              eq(patientWeights.patientId, patients.id),
              eq(patients.id, input.patientId),
              eq(patients.clientId, client.id),
              eq(patients.practiceId, client.practiceId),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .where(
            and(
              eq(patientWeights.patientId, input.patientId),
              isNull(patientWeights.deletedAt)
            )
          )
          .orderBy(desc(patientWeights.recordedAt)),

        ctx.db
          .select({
            id: patientAllergies.id,
            allergen: patientAllergies.allergen,
            reaction: patientAllergies.reaction,
            severity: patientAllergies.severity,
          })
          .from(patientAllergies)
          .innerJoin(
            patients,
            and(
              eq(patientAllergies.patientId, patients.id),
              eq(patients.id, input.patientId),
              eq(patients.clientId, client.id),
              eq(patients.practiceId, client.practiceId),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .where(
            and(
              eq(patientAllergies.patientId, input.patientId),
              isNull(patientAllergies.deletedAt)
            )
          ),

        ctx.db
          .select({
            id: vaccinationRecords.id,
            vaccineName: vaccinationRecords.vaccineName,
            lotNumber: vaccinationRecords.lotNumber,
            manufacturer: vaccinationRecords.manufacturer,
            administeredAt: vaccinationRecords.administeredAt,
            nextDueDate: vaccinationRecords.nextDueDate,
          })
          .from(vaccinationRecords)
          .innerJoin(
            patients,
            and(
              eq(vaccinationRecords.patientId, patients.id),
              eq(patients.id, input.patientId),
              eq(patients.clientId, client.id),
              eq(patients.practiceId, client.practiceId),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .where(
            and(
              eq(vaccinationRecords.patientId, input.patientId),
              eq(vaccinationRecords.practiceId, client.practiceId),
              isNull(vaccinationRecords.deletedAt),
              sql`not exists (
                select 1
                from clinical_record_corrections as vaccination_correction
                where vaccination_correction.practice_id = ${client.practiceId}
                  and vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}
              )`
            )
          )
          .orderBy(desc(vaccinationRecords.administeredAt)),

        ctx.db
          .select({
            id: prescriptions.id,
            medicationName: prescriptions.medicationName,
            dosage: prescriptions.dosage,
            frequency: prescriptions.frequency,
            startDate: prescriptions.startDate,
            endDate: prescriptions.endDate,
            instructions: prescriptions.instructions,
            status: prescriptions.status,
            refillsRemaining: prescriptions.refillsRemaining,
          })
          .from(prescriptions)
          .innerJoin(
            patients,
            and(
              eq(prescriptions.patientId, patients.id),
              eq(patients.id, input.patientId),
              eq(patients.clientId, client.id),
              eq(patients.practiceId, client.practiceId),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .where(
            and(
              eq(prescriptions.patientId, input.patientId),
              eq(prescriptions.practiceId, client.practiceId),
              eq(prescriptions.status, "active"),
              or(
                isNull(prescriptions.endDate),
                gte(prescriptions.endDate, practiceToday)
              ),
              isNull(prescriptions.deletedAt)
            )
          ),
      ]);

      return {
        ...patient,
        clientName: `${client.firstName} ${client.lastName}`,
        timezone: practice.timezone,
        practice,
        weights,
        allergies,
        vaccinations,
        prescriptions: activeRx,
      };
    }),

  getVaccinationCertificateData: publicProcedure
    .input(
      z.object({
        token: portalTokenInput,
        patientId: z.string().uuid(),
        vaccinationRecordId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);

      const [practice, records] = await Promise.all([
        practicePortalProfile(ctx.db, client.practiceId),
        ctx.db
          .select({
            patientName: patients.name,
            species: patients.species,
            breed: patients.breed,
            sex: patients.sex,
            dob: patients.dob,
            color: patients.color,
            vaccinationRecordId: vaccinationRecords.id,
            vaccineName: vaccinationRecords.vaccineName,
            lotNumber: vaccinationRecords.lotNumber,
            manufacturer: vaccinationRecords.manufacturer,
            administeredAt: vaccinationRecords.administeredAt,
            nextDueDate: vaccinationRecords.nextDueDate,
          })
          .from(vaccinationRecords)
          .innerJoin(
            patients,
            and(
              eq(vaccinationRecords.patientId, patients.id),
              eq(patients.practiceId, client.practiceId),
              eq(patients.clientId, client.id),
              eq(patients.status, "active"),
              isNull(patients.deletedAt)
            )
          )
          .where(
            and(
              eq(vaccinationRecords.id, input.vaccinationRecordId),
              eq(vaccinationRecords.patientId, input.patientId),
              eq(vaccinationRecords.practiceId, client.practiceId),
              isNull(vaccinationRecords.deletedAt),
              sql`not exists (
                select 1
                from clinical_record_corrections as vaccination_correction
                where vaccination_correction.practice_id = ${client.practiceId}
                  and vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}
              )`
            )
          )
          .limit(1),
      ]);
      const record = records[0];
      if (!record) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Vaccination certificate is not available",
        });
      }

      return {
        practice,
        clientName: `${client.firstName} ${client.lastName}`.trim(),
        patient: {
          name: record.patientName,
          species: record.species,
          breed: record.breed,
          sex: record.sex,
          dob: record.dob,
          color: record.color,
        },
        vaccination: {
          id: record.vaccinationRecordId,
          vaccineName: record.vaccineName,
          lotNumber: record.lotNumber,
          manufacturer: record.manufacturer,
          administeredAt: record.administeredAt,
          nextDueDate: record.nextDueDate,
        },
      };
    }),

  getAppointments: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);
      const timezone = await practiceTimeZone(ctx.db, client.practiceId);

      const rows = await ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          status: appointments.status,
          notes: appointments.notes,
          patientName: patients.name,
          patientSpecies: patients.species,
          doctorName: users.name,
          typeName: appointmentTypes.name,
          locationName: locations.name,
          locationId: appointments.locationId,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, client.id),
            eq(patients.practiceId, client.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, client.practiceId)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointments.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, client.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .leftJoin(
          locations,
          and(
            eq(appointments.locationId, locations.id),
            eq(locations.practiceId, client.practiceId),
          ),
        )
        .where(
          and(
            eq(appointments.clientId, client.id),
            eq(appointments.practiceId, client.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .orderBy(desc(appointments.startTime));

      return rows.map((row) => ({
        ...row,
        timezone,
      }));
    }),

  getMessages: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);
      const timezone = await practiceTimeZone(ctx.db, client.practiceId);

      const items = await ctx.db
        .select({
          id: communications.id,
          direction: communications.direction,
          subject: communications.subject,
          content: communications.content,
          status: communications.status,
          readAt: communications.readAt,
          createdAt: communications.createdAt,
        })
        .from(communications)
        .where(
          and(
            eq(communications.clientId, client.id),
            eq(communications.practiceId, client.practiceId),
            eq(communications.channel, "portal"),
            isNull(communications.deletedAt)
          )
        )
        .orderBy(desc(communications.createdAt));

      return {
        timezone,
        items,
      };
    }),

  createMessage: publicProcedure
    .input(
      z.object({
        token: portalTokenInput,
        content: portalMessageContentInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-message",
        ...PORTAL_MESSAGE_IP_RATE_LIMIT,
      });
      await assertPortalRateLimit({
        key: portalRateLimitKey("portal-message", input.token),
        ...PORTAL_MESSAGE_TOKEN_RATE_LIMIT,
      });

      const client = await getClientByToken(ctx.db, input.token);
      await assertPortalWriteAccess(ctx.db, client.practiceId, "messaging");

      const [message] = await ctx.db
        .insert(communications)
        .values({
          practiceId: client.practiceId,
          clientId: client.id,
          channel: "portal",
          direction: "inbound",
          subject: `Portal message from ${client.firstName} ${client.lastName}`,
          content: input.content,
          status: "pending",
          assignedTo: latestAssignedToForClient(client.practiceId, client.id),
        })
        .returning({
          id: communications.id,
          direction: communications.direction,
          subject: communications.subject,
          content: communications.content,
          status: communications.status,
          createdAt: communications.createdAt,
        });

      if (!message) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not send portal message",
        });
      }

      return {
        success: true,
        message,
      };
    }),

  markMessagesRead: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .mutation(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);

      const client = await getClientByToken(ctx.db, input.token);
      const updated = await ctx.db
        .update(communications)
        .set({ status: "read", readAt: new Date() })
        .where(
          and(
            eq(communications.clientId, client.id),
            eq(communications.practiceId, client.practiceId),
            eq(communications.channel, "portal"),
            eq(communications.direction, "outbound"),
            isNull(communications.readAt),
            ne(communications.status, "read"),
            isNull(communications.deletedAt)
          )
        )
        .returning({ id: communications.id });

      return {
        success: true,
        updated: updated.length,
      };
    }),

  getInvoices: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);

      // Practice currency so the portal renders amounts in the right currency.
      const [practice] = await ctx.db
        .select({
          currency: practices.currency,
          country: practices.country,
          timezone: practices.timezone,
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(activePracticeWhere(client.practiceId))
        .limit(1);
      if (!practice) {
        throw invalidPortalLink();
      }
      const currency = practice.currency ?? "usd";
      const country = practice.country ?? "US";
      const timezone = practice.timezone ?? null;
      const hostedBillingEnforced = billingEnforced();
      // On hosted, the portal Pay button additionally requires the practice's
      // Stripe Connect account — client money goes to the clinic, never to
      // the platform account. Mirrors the /api/portal/checkout gate.
      const onlinePaymentsEnabled =
        stripeConfigured() &&
        (!hostedBillingEnforced ||
          (hasHostedFullAccess(
            practice.tier,
            practice.billingStatus,
            practice.trialEndsAt,
            new Date(),
            hostedBillingEnforced
          ) &&
            (await getChargeableStripeConnectAccountId(
              ctx.db,
              client.practiceId
            )) !== null));

      const rows = await ctx.db
        .select({
          id: invoices.id,
          status: invoices.status,
          subtotal: invoices.subtotal,
          tax: invoices.tax,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          adjustedAmount: sql<string>`coalesce((
            select sum(${invoiceAdjustments.amount})
            from ${invoiceAdjustments}
            where ${invoiceAdjustments.invoiceId} = ${invoices.id}
              and exists (
                select 1
                from ${invoices}
                where ${invoices.id} = ${invoiceAdjustments.invoiceId}
                  and ${invoices.clientId} = ${client.id}
                  and ${invoices.practiceId} = ${client.practiceId}
                  and ${invoices.deletedAt} is null
              )
              and ${invoiceAdjustments.deletedAt} is null
          ), 0)`,
          dueDate: invoices.dueDate,
          createdAt: invoices.createdAt,
          isEstimate: invoices.isEstimate,
          patientName: patients.name,
        })
        .from(invoices)
        .leftJoin(
          patients,
          and(
            eq(invoices.patientId, patients.id),
            eq(patients.clientId, client.id),
            eq(patients.practiceId, client.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .where(
          and(
            eq(invoices.clientId, client.id),
            eq(invoices.practiceId, client.practiceId),
            ne(invoices.status, "draft"),
            isNull(invoices.deletedAt)
          )
        )
        .orderBy(desc(invoices.createdAt));

      return rows.map((r) => {
        const adjustedCents = moneyToCents(r.adjustedAmount);
        return {
          ...r,
          adjustedAmount: centsToMoney(adjustedCents),
          balanceDue: centsToMoney(invoiceBalanceCents(r, adjustedCents)),
          currency,
          country,
          timezone,
          onlinePaymentsEnabled,
        };
      });
    }),

  /** Appointment types a client can choose from when booking. */
  getAppointmentTypes: publicProcedure
    .input(z.object({ token: portalTokenInput }))
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-read",
        ...PORTAL_READ_IP_RATE_LIMIT,
      });
      await assertPortalReadRateLimit(input.token);
      const client = await getClientByToken(ctx.db, input.token);
      return ctx.db
        .select({
          id: appointmentTypes.id,
          name: appointmentTypes.name,
          durationMinutes: appointmentTypes.durationMinutes,
        })
        .from(appointmentTypes)
        .where(
          and(
            eq(appointmentTypes.practiceId, client.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .orderBy(appointmentTypes.name);
    }),

  /** Suggested open times on a date for the booking form (practice-wide). */
  availableSlots: publicProcedure
    .input(
      z.object({
        token: portalTokenInput,
        date: portalBookingDateInput,
        durationMinutes: z
          .number()
          .int()
          .min(PORTAL_BOOKING_MIN_DURATION_MINUTES)
          .max(PORTAL_BOOKING_MAX_DURATION_MINUTES)
          .default(30),
        locationId: z.string().uuid().optional()
      })
    )
    .query(async ({ ctx, input }) => {
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-slots",
        ...PORTAL_SLOTS_IP_RATE_LIMIT,
      });
      await assertPortalRateLimit({
        key: portalRateLimitKey("portal-slots", input.token),
        limit: 60,
        windowMs: 15 * 60 * 1000,
        message:
          "Too many availability requests. Please try again later or call the clinic.",
      });

      const client = await getClientByToken(ctx.db, input.token);
      const timezone = await practiceTimeZone(ctx.db, client.practiceId);
      const { dayStart, dayEnd } = portalBookingWindow(input.date, timezone);
      const location = await resolveAppointmentLocation(ctx.db, {
        practiceId: client.practiceId,
        locationId: input.locationId,
      });
      if (!location.ok) {
        throw new TRPCError({ code: location.code, message: location.message });
      }

      const busy = await ctx.db
        .select({
          startTime: appointments.startTime,
          endTime: appointments.endTime,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, client.practiceId),
            eq(appointments.locationId, location.locationId),
            isNull(appointments.deletedAt),
            not(inArray(appointments.status, ["cancelled", "no_show"])),
            lt(appointments.startTime, dayEnd),
            gt(appointments.endTime, dayStart)
          )
        );

      return filterFutureOpenSlots(
        findOpenSlots({
          dayStart,
          dayEnd,
          slotMinutes: input.durationMinutes,
          busy,
        })
      ).map((s) => ({
        // 24h HH:MM in the practice timezone, matching the booking form input.
        time: formatPortalSlotTime(s.start, timezone),
        iso: s.start.toISOString(),
      }));
    }),

  requestAppointment: publicProcedure
    .input(
      z.object({
        token: portalTokenInput,
        patientId: z.string().uuid(),
        typeId: z.string().uuid(),
        locationId: z.string().uuid().optional(),
        preferredDate: portalBookingDateInput,
        preferredTime: portalBookingTimeInput,
        reason: z.string().trim().min(1).max(PORTAL_BOOKING_REASON_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Throttle public booking per portal link to deter abuse.
      await assertPortalIpRateLimit(ctx.ip, {
        keyPrefix: "portal-book",
        ...PORTAL_BOOK_IP_RATE_LIMIT,
      });
      await assertPortalRateLimit({
        key: portalRateLimitKey("portal-book", input.token),
        limit: 5,
        windowMs: 60 * 60 * 1000,
        message: "Too many requests. Please try again later or call the clinic.",
      });

      const client = await getClientByToken(ctx.db, input.token);
      await assertPortalWriteAccess(ctx.db, client.practiceId, "booking");
      const timezone = await practiceTimeZone(ctx.db, client.practiceId);

      // Verify the patient belongs to this client.
      const [patient] = await ctx.db
        .select({ id: patients.id, name: patients.name })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.clientId, client.id),
            eq(patients.practiceId, client.practiceId),
            eq(patients.status, "active"),
            isNull(patients.deletedAt)
          )
        )
        .limit(1);

      if (!patient) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pet not found" });
      }

      // Serialize portal and public requests for this practice before taking
      // the type row lock. The public procedure transaction holds both locks
      // through the conflict check and appointment insert.
      await takeAppointmentSchedulingLock(ctx.db, client.practiceId);
      const location = await resolveAppointmentLocation(ctx.db, {
        practiceId: client.practiceId,
        locationId: input.locationId,
      });
      if (!location.ok) {
        throw new TRPCError({ code: location.code, message: location.message });
      }
      const activeLocations = await listActiveAppointmentLocations(
        ctx.db,
        client.practiceId
      );
      const selectedLocation = activeLocations.find(
        (candidate) => candidate.id === location.locationId
      );
      if (!selectedLocation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
      }

      // Every request must reference a verified active type in this practice.
      const [type] = await ctx.db
        .select({
          id: appointmentTypes.id,
          durationMinutes: appointmentTypes.durationMinutes,
        })
        .from(appointmentTypes)
        .where(
          and(
            eq(appointmentTypes.id, input.typeId),
            eq(appointmentTypes.practiceId, client.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .for("share");
      if (!type) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment type not found",
        });
      }
      const typeId = type.id;
      const durationMinutes = type.durationMinutes;

      let slot;
      try {
        slot = buildRequestedSlot({
          preferredDate: input.preferredDate,
          preferredTime: input.preferredTime,
          durationMinutes,
          timeZone: timezone,
        });
        assertSlotWithinPortalBookingHours(
          slot,
          input.preferredDate,
          timezone
        );
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: e instanceof Error ? e.message : "Invalid date or time",
        });
      }

      const [conflict] = await ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, client.practiceId),
            eq(appointments.locationId, location.locationId),
            isNull(appointments.deletedAt),
            not(inArray(appointments.status, ["cancelled", "no_show"])),
            lt(appointments.startTime, slot.endTime),
            gt(appointments.endTime, slot.startTime)
          )
        )
        .limit(1);

      if (conflict) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "That time is no longer available. Please choose another time.",
        });
      }

      // Create the appointment as "scheduled" — staff confirm/adjust on the
      // calendar. Notes flag it as a portal request and capture the reason.
      const [appt] = await ctx.db
        .insert(appointments)
        .values({
          practiceId: client.practiceId,
          clientId: client.id,
          patientId: patient.id,
          typeId,
          locationId: location.locationId,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: "scheduled",
          notes: `[Portal request] ${input.reason}`,
        })
        .returning();
      await recordActivationAfterAppointmentCreated(
        ctx.db,
        client.practiceId,
        "portal.requestAppointment"
      );

      // Mirror into the communications inbox so front desk sees it there too.
      await ctx.db.insert(communications).values({
        practiceId: client.practiceId,
        clientId: client.id,
        channel: "portal",
        direction: "inbound",
        subject: `Appointment request for ${patient.name}`,
        content: [
          `Pet: ${patient.name}`,
          `Requested: ${formatPortalRequestDateTime(
            input.preferredDate,
            input.preferredTime,
            timezone
          )}`,
          `Location: ${selectedLocation.name}`,
          `Reason: ${input.reason}`,
        ].join("\n"),
        status: "pending",
        assignedTo: latestAssignedToForClient(client.practiceId, client.id),
      });

      await dispatchAppointmentWebhookAfterCommit(
        ctx,
        client.practiceId,
        "appointment.created",
        appointmentCreatedWebhookPayload(appt!, "portal")
      );

      return {
        success: true,
        appointmentId: appt!.id,
        message:
          "Your appointment request has been sent! The clinic will confirm your appointment.",
      };
    }),
});
