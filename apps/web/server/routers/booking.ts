import { z } from "zod";
import { eq, and, isNull, sql, not, inArray, lt, gt, asc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure, protectedProcedure, requireRole } from "../trpc";
import {
  bookingPages,
  practices,
  appointmentTypes,
  appointments,
  clients,
  patients,
  communications,
} from "@openpims/db";
import { rateLimit } from "@/lib/rate-limit";
import { dateInputTimeUtcInstant } from "@/lib/date-input";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { appointmentCreatedWebhookPayload } from "@/lib/appointment-webhooks";
import { recordActivationAfterAppointmentCreated } from "@/lib/funnel-events-server";
import { findOpenSlots } from "@/lib/scheduling/availability";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import { generatePortalAccessToken } from "@/lib/portal/tokens";
import { latestAssignedToForClient } from "@/lib/communications/assignment";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";
import {
  bookingPageConfigInput,
  bookingWindowForDate,
  isDateWithinBookingWindow,
  isValidBookingSlug,
  minimumBookableInstant,
  parseBookingPageConfig,
  suggestBookingSlug,
  BOOKING_REASON_MAX_LENGTH,
  BOOKING_SLUG_MAX_LENGTH,
} from "@/lib/booking/page-config";

const bookingSlugInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(BOOKING_SLUG_MAX_LENGTH);
const bookingDateInput = clinicalDateInput("Appointment request date");
const bookingTimeInput = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
  message: "Appointment request time must be in 24-hour HH:MM format.",
});

const PAGE_READ_IP_RATE_LIMIT = { limit: 300, windowMs: 15 * 60 * 1000 };
const SLOTS_IP_RATE_LIMIT = { limit: 120, windowMs: 15 * 60 * 1000 };
const SLOTS_SLUG_RATE_LIMIT = { limit: 600, windowMs: 15 * 60 * 1000 };
const BOOK_IP_RATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };
const BOOK_SLUG_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
const RATE_LIMIT_MESSAGE =
  "Too many requests. Please try again later or call the clinic.";

async function assertBookingRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  try {
    const { success } = await rateLimit(input);
    if (success) return;
  } catch (err) {
    console.error("[booking] rate limit failed:", err);
  }
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: RATE_LIMIT_MESSAGE,
  });
}

async function assertBookingIpRateLimit(
  ip: string | null | undefined,
  keyPrefix: string,
  limits: { limit: number; windowMs: number }
) {
  await assertBookingRateLimit({
    key: `${keyPrefix}:ip:${ip || "unknown"}`,
    ...limits,
  });
}

function pageNotFound(): TRPCError {
  return new TRPCError({
    code: "NOT_FOUND",
    message: "This appointment request page is not available.",
  });
}

function bookingSlugConflict(): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: "That link is already taken. Please choose another.",
  });
}

function isPostgresUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Slugs are globally unique, so a tenant-scoped connection cannot answer this
 * question under RLS. The caller must supply the narrowly scoped system
 * context used only by the authenticated checkSlug query.
 */
async function bookingSlugTakenByAnotherPractice(
  database: any,
  slug: string,
  practiceId: string
): Promise<boolean> {
  const [page] = await database
    .select({ practiceId: bookingPages.practiceId })
    .from(bookingPages)
    .where(eq(bookingPages.slug, slug))
    .limit(1);
  return Boolean(page && page.practiceId !== practiceId);
}

/** Resolve a slug to its live page + owning practice, or 404. */
async function getLivePage(db: any, slug: string) {
  const [row] = await db
    .select({
      page: bookingPages,
      practice: {
        id: practices.id,
        name: practices.name,
        logoUrl: practices.logoUrl,
        address: practices.address,
        phone: practices.phone,
        timezone: practices.timezone,
        subscriptionTier: practices.subscriptionTier,
        billingStatus: practices.billingStatus,
        trialEndsAt: practices.trialEndsAt,
      },
    })
    .from(bookingPages)
    .innerJoin(practices, eq(practices.id, bookingPages.practiceId))
    .where(
      and(
        eq(bookingPages.slug, slug),
        eq(bookingPages.published, true),
        isNull(bookingPages.deletedAt),
        isNull(practices.deletedAt)
      )
    )
    .limit(1);

  if (!row) throw pageNotFound();
  return {
    page: row.page,
    practice: row.practice,
    config: parseBookingPageConfig(row.page.config),
  };
}

/** Public booking is a hosted feature: paused/lapsed practices don't take bookings. */
function assertBookingBillingAccess(practice: {
  subscriptionTier: string;
  billingStatus: string;
  trialEndsAt: Date | null;
}) {
  if (!billingEnforced()) return;
  if (
    !hasHostedFullAccess(
      practice.subscriptionTier,
      practice.billingStatus,
      practice.trialEndsAt
    )
  ) {
    throw pageNotFound();
  }
}

async function bookableTypesForPage(
  db: any,
  practiceId: string,
  bookableTypeIds: string[]
): Promise<Array<{ id: string; name: string; durationMinutes: number }>> {
  if (bookableTypeIds.length === 0) return [];
  const rows = await db
    .select({
      id: appointmentTypes.id,
      name: appointmentTypes.name,
      durationMinutes: appointmentTypes.durationMinutes,
    })
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.practiceId, practiceId),
        isNull(appointmentTypes.deletedAt)
      )
    )
    .orderBy(asc(appointmentTypes.name));

  const allowed = new Set(bookableTypeIds);
  return rows.filter((t: { id: string }) => allowed.has(t.id));
}

/**
 * Lock the exact active type used by a request until the surrounding
 * transaction commits. This prevents an appointment type from being archived
 * after validation but before the appointment row is created.
 */
async function lockBookableTypeForRequest(
  db: any,
  practiceId: string,
  bookableTypeIds: string[],
  requestedTypeId: string
): Promise<{ id: string; durationMinutes: number } | null> {
  if (!bookableTypeIds.includes(requestedTypeId)) return null;
  const [type] = await db
    .select({
      id: appointmentTypes.id,
      durationMinutes: appointmentTypes.durationMinutes,
    })
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.id, requestedTypeId),
        eq(appointmentTypes.practiceId, practiceId),
        isNull(appointmentTypes.deletedAt)
      )
    )
    .for("share");
  return type ?? null;
}

async function lockActiveSelectedTypeIds(
  db: any,
  practiceId: string,
  selectedTypeIds: string[]
): Promise<string[]> {
  if (selectedTypeIds.length === 0) return [];
  const rows = await db
    .select({ id: appointmentTypes.id })
    .from(appointmentTypes)
    .where(
      and(
        eq(appointmentTypes.practiceId, practiceId),
        inArray(appointmentTypes.id, selectedTypeIds),
        isNull(appointmentTypes.deletedAt)
      )
    )
    .for("share");
  const active = new Set(rows.map((row: { id: string }) => row.id));
  return [...new Set(selectedTypeIds)].filter((id) => active.has(id));
}

const contactInput = z.object({
  firstName: z.string().trim().min(1).max(128),
  lastName: z.string().trim().min(1).max(128),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: z.string().trim().max(32).optional(),
});

const petInput = z.object({
  name: z.string().trim().min(1).max(128),
  species: z.enum([
    "canine",
    "feline",
    "avian",
    "rabbit",
    "reptile",
    "equine",
    "other",
  ]),
});

export const bookingRouter = createRouter({
  // ---------------------------------------------------------------------
  // Public (no auth): everything below is reachable from /book/[slug].
  // ---------------------------------------------------------------------

  getPage: publicProcedure
    .input(z.object({ slug: bookingSlugInput }))
    .query(async ({ ctx, input }) => {
      await assertBookingIpRateLimit(ctx.ip, "booking-page", PAGE_READ_IP_RATE_LIMIT);
      const { practice, config } = await getLivePage(ctx.db, input.slug);
      assertBookingBillingAccess(practice);
      const types = await bookableTypesForPage(
        ctx.db,
        practice.id,
        config.bookableTypeIds
      );
      if (types.length === 0) throw pageNotFound();

      return {
        practice: {
          name: practice.name,
          logoUrl: practice.logoUrl,
          address: practice.address,
          phone: practice.phone,
          timezone: practice.timezone,
        },
        welcomeText: config.welcomeText,
        accentColor: config.accentColor,
        allowNewClients: config.allowNewClients,
        hours: config.hours,
        leadTimeMinutes: config.leadTimeMinutes,
        bookingWindowDays: config.bookingWindowDays,
        types,
      };
    }),

  availableSlots: publicProcedure
    .input(
      z.object({
        slug: bookingSlugInput,
        date: bookingDateInput,
        typeId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertBookingIpRateLimit(ctx.ip, "booking-slots", SLOTS_IP_RATE_LIMIT);
      await assertBookingRateLimit({
        key: `booking-slots:slug:${input.slug}`,
        ...SLOTS_SLUG_RATE_LIMIT,
      });

      const { practice, config } = await getLivePage(ctx.db, input.slug);
      assertBookingBillingAccess(practice);

      if (!isDateWithinBookingWindow(config, input.date)) return [];
      const window = bookingWindowForDate(config, input.date, practice.timezone);
      if (!window) return [];

      const types = await bookableTypesForPage(
        ctx.db,
        practice.id,
        config.bookableTypeIds
      );
      const type = types.find((candidate) => candidate.id === input.typeId);
      if (!type) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment type not found",
        });
      }
      const durationMinutes = type.durationMinutes;

      const busy = await ctx.db
        .select({
          startTime: appointments.startTime,
          endTime: appointments.endTime,
        })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, practice.id),
            isNull(appointments.deletedAt),
            not(inArray(appointments.status, ["cancelled", "no_show"])),
            lt(appointments.startTime, window.dayEnd),
            gt(appointments.endTime, window.dayStart)
          )
        );

      const earliest = minimumBookableInstant(config);
      return findOpenSlots({
        dayStart: window.dayStart,
        dayEnd: window.dayEnd,
        slotMinutes: durationMinutes,
        busy,
      })
        .filter((s) => s.start.getTime() >= earliest.getTime())
        .map((s) => ({
          time: s.start.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: practice.timezone || undefined,
          }),
          iso: s.start.toISOString(),
        }));
    }),

  book: publicProcedure
    .input(
      z.object({
        slug: bookingSlugInput,
        typeId: z.string().uuid(),
        date: bookingDateInput,
        time: bookingTimeInput,
        contact: contactInput,
        pet: petInput,
        reason: z.string().trim().min(1).max(BOOKING_REASON_MAX_LENGTH),
        /** Honeypot — humans never fill this; bots do. */
        website: z.string().max(255).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Silently accept honeypot submissions without creating anything, so
      // bots can't tell they were caught.
      if (input.website && input.website.trim().length > 0) {
        return {
          success: true as const,
          requiresConfirmation: true,
          message:
            "Your appointment request has been sent! The clinic will confirm your appointment.",
        };
      }

      await assertBookingIpRateLimit(ctx.ip, "booking-book", BOOK_IP_RATE_LIMIT);
      await assertBookingRateLimit({
        key: `booking-book:slug:${input.slug}`,
        ...BOOK_SLUG_RATE_LIMIT,
      });

      const { practice, config } = await getLivePage(ctx.db, input.slug);
      assertBookingBillingAccess(practice);

      // Public and portal requests for one practice share a transaction lock,
      // so neither path can pass the conflict check concurrently. Take it
      // before the type row lock to keep request lock ordering consistent.
      await ctx.db.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`public-booking:${practice.id}`}::text))`
      );

      // Resolve and hold the type through appointment creation; only types
      // explicitly offered on this page count.
      const type = await lockBookableTypeForRequest(
        ctx.db,
        practice.id,
        config.bookableTypeIds,
        input.typeId
      );
      if (!type) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment type not found",
        });
      }
      const typeId = type.id;
      const durationMinutes = type.durationMinutes;

      // The requested slot must sit inside the page's hours, lead time, and
      // booking window for that calendar date.
      if (!isDateWithinBookingWindow(config, input.date)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That date is outside the online appointment request window.",
        });
      }
      const window = bookingWindowForDate(config, input.date, practice.timezone);
      if (!window) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Online appointment requests are not available on that day.",
        });
      }
      const [hour, minute] = input.time.split(":").map(Number);
      const slotStart = dateInputTimeUtcInstant(
        input.date,
        { hour: hour!, minute: minute! },
        practice.timezone
      );
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);

      if (slotStart < window.dayStart || slotEnd > window.dayEnd) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Please choose a time within the clinic's request hours.",
        });
      }
      if (slotStart.getTime() < minimumBookableInstant(config).getTime()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That time is too soon. Please choose a later time.",
        });
      }

      const [conflict] = await ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, practice.id),
            isNull(appointments.deletedAt),
            not(inArray(appointments.status, ["cancelled", "no_show"])),
            lt(appointments.startTime, slotEnd),
            gt(appointments.endTime, slotStart)
          )
        )
        .limit(1);
      if (conflict) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That time is no longer available. Please choose another time.",
        });
      }

      // Find the client by email within this practice, or create one when
      // the page allows new clients.
      const [existingClient] = await ctx.db
        .select({ id: clients.id })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, practice.id),
            isNull(clients.deletedAt),
            sql`lower(${clients.email}) = ${input.contact.email}`
          )
        )
        .limit(1);

      let clientId: string;
      let isNewClient = false;
      if (existingClient) {
        clientId = existingClient.id;
      } else {
        if (!config.allowNewClients) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Online appointment requests are limited to existing clients. Please call the clinic to get set up.",
          });
        }
        const [created] = await ctx.db
          .insert(clients)
          .values({
            practiceId: practice.id,
            firstName: input.contact.firstName,
            lastName: input.contact.lastName,
            email: input.contact.email,
            phone: input.contact.phone || null,
            preferredContactMethod: "email",
            accessToken: generatePortalAccessToken(),
          })
          .returning({ id: clients.id });
        clientId = created!.id;
        isNewClient = true;
      }

      // Reuse the client's pet when the name matches; otherwise add it.
      const [existingPatient] = await ctx.db
        .select({ id: patients.id, name: patients.name })
        .from(patients)
        .where(
          and(
            eq(patients.practiceId, practice.id),
            eq(patients.clientId, clientId),
            eq(patients.status, "active"),
            isNull(patients.deletedAt),
            sql`lower(${patients.name}) = ${input.pet.name.toLowerCase()}`
          )
        )
        .limit(1);

      let patientId: string;
      let petName: string;
      if (existingPatient) {
        patientId = existingPatient.id;
        petName = existingPatient.name;
      } else {
        const [created] = await ctx.db
          .insert(patients)
          .values({
            practiceId: practice.id,
            clientId,
            name: input.pet.name,
            species: input.pet.species,
          })
          .returning({ id: patients.id, name: patients.name });
        patientId = created!.id;
        petName = created!.name;
      }

      const [appt] = await ctx.db
        .insert(appointments)
        .values({
          practiceId: practice.id,
          clientId,
          patientId,
          typeId,
          startTime: slotStart,
          endTime: slotEnd,
          // Public booking is deliberately request-only. Keep this invariant
          // independent of legacy booking-page config stored in jsonb.
          status: "scheduled",
          notes: `[Online request] ${input.reason}`,
        })
        .returning();
      await recordActivationAfterAppointmentCreated(
        ctx.db,
        practice.id,
        "booking.book"
      );

      // Surface the request in the communications inbox so the front desk
      // sees it alongside portal requests and messages.
      await ctx.db.insert(communications).values({
        practiceId: practice.id,
        clientId,
        channel: "portal",
        direction: "inbound",
        subject: `New appointment request for ${petName}`,
        content: [
          `Client: ${input.contact.firstName} ${input.contact.lastName}${isNewClient ? " (new client)" : ""}`,
          `Pet: ${petName}`,
          `Requested: ${input.date} ${input.time}`,
          `Reason: ${input.reason}`,
        ].join("\n"),
        status: "pending",
        assignedTo: latestAssignedToForClient(practice.id, clientId),
      });

      await dispatchWebhookEvent(
        practice.id,
        "appointment.created",
        appointmentCreatedWebhookPayload(appt!, "booking_page")
      );

      return {
        success: true as const,
        requiresConfirmation: true,
        message:
          "Your appointment request has been sent! The clinic will confirm your appointment.",
      };
    }),

  // ---------------------------------------------------------------------
  // Admin (Settings → Booking): manage this practice's page.
  // ---------------------------------------------------------------------

  getMyPage: protectedProcedure
    .use(requireRole("admin"))
    .query(async ({ ctx }) => {
      const [row] = await ctx.db
        .select()
        .from(bookingPages)
        .where(
          and(
            eq(bookingPages.practiceId, ctx.practiceId),
            isNull(bookingPages.deletedAt)
          )
        )
        .limit(1);

      const [practice] = await ctx.db
        .select({ name: practices.name })
        .from(practices)
        .where(eq(practices.id, ctx.practiceId))
        .limit(1);

      return {
        page: row
          ? {
              slug: row.slug,
              published: row.published,
              config: parseBookingPageConfig(row.config),
            }
          : null,
        suggestedSlug: suggestBookingSlug(practice?.name ?? ""),
      };
    }),

  // This query is authenticated by requireRole, while publicProcedure gives it
  // the system DB context needed to see a globally unique slug across RLS
  // tenants. It returns only a boolean and never writes in system context.
  checkSlug: publicProcedure
    .use(requireRole("admin"))
    .input(z.object({ slug: bookingSlugInput }))
    .query(async ({ ctx, input }) => {
      if (!isValidBookingSlug(input.slug)) {
        return { valid: false, available: false };
      }
      const taken = await bookingSlugTakenByAnotherPractice(
        ctx.db,
        input.slug,
        ctx.practiceId
      );
      return { valid: true, available: !taken };
    }),

  savePage: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        slug: bookingSlugInput,
        published: z.boolean(),
        config: bookingPageConfigInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!isValidBookingSlug(input.slug)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Links can use lowercase letters, numbers, and dashes (3 to 64 characters).",
        });
      }

      return ctx.db.transaction(async (tx) => {
        // Publication must be truthful. The shared locks are held until the
        // page write commits, so a selected type cannot be archived between
        // validation and publication.
        const activeSelectedTypeIds = await lockActiveSelectedTypeIds(
          tx,
          ctx.practiceId,
          input.config.bookableTypeIds
        );
        if (input.published && activeSelectedTypeIds.length === 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Select at least one active visit type before publishing the appointment request page.",
          });
        }
        const config = {
          ...input.config,
          bookableTypeIds: activeSelectedTypeIds,
        };

        const [existing] = await tx
          .select({ id: bookingPages.id })
          .from(bookingPages)
          .where(
            and(
              eq(bookingPages.practiceId, ctx.practiceId),
              isNull(bookingPages.deletedAt)
            )
          )
          .limit(1);

        if (existing) {
          try {
            const [updated] = await tx
              .update(bookingPages)
              .set({
                slug: input.slug,
                published: input.published,
                config,
              })
              .where(eq(bookingPages.id, existing.id))
              .returning({
                slug: bookingPages.slug,
                published: bookingPages.published,
              });
            return updated!;
          } catch (error) {
            if (isPostgresUniqueViolation(error)) throw bookingSlugConflict();
            throw error;
          }
        }

        try {
          const [created] = await tx
            .insert(bookingPages)
            .values({
              practiceId: ctx.practiceId,
              slug: input.slug,
              published: input.published,
              config,
            })
            .returning({
              slug: bookingPages.slug,
              published: bookingPages.published,
            });
          return created!;
        } catch (error) {
          if (isPostgresUniqueViolation(error)) throw bookingSlugConflict();
          throw error;
        }
      });
    }),
});
