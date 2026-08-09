import { z } from "zod";
import {
  eq,
  and,
  isNull,
  gte,
  lte,
  lt,
  inArray,
  sql,
} from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import type { Database } from "@openpims/db/client";
import {
  appointments,
  patients,
  clients,
  users,
  communications,
  invoices,
  invoiceAdjustments,
  vaccinationRecords,
  practices,
  locationMessaging,
  locations,
  emailSuppressions,
} from "@openpims/db";
import {
  sendAppointmentReminder,
  sendInvoiceEmail,
  sendVaccinationReminder,
} from "@/lib/email";
import {
  sendAppointmentReminderSms,
  sendVaccinationReminderSms,
} from "@/lib/sms";
import {
  isQuietHours,
  pickReminderChannel,
} from "@/lib/messaging/reminders";
import { formatCurrency } from "@/lib/locale/format";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import {
  getVaccinationRecallPreview,
  sendVaccinationRecallReminders,
} from "../vaccination-recalls";
import { assertVisitInvoiceReadyForFinancialAction } from "../visit-billing-integrity";
import {
  centsToMoney,
  invoiceBalanceCents,
  moneyToCents,
} from "@/lib/billing/invoice-balance";

const DEFAULT_PRACTICE_NAME = "your clinic";

function validVaccinationRecordPredicate(practiceId: string) {
  return sql`not exists (
    select 1
    from clinical_record_corrections as vaccination_correction
    where vaccination_correction.practice_id = ${practiceId}
      and vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}
  )`;
}

function latestValidVaccinationRecordPredicate(practiceId: string) {
  return sql`not exists (
    select 1
    from vaccination_records as newer_vaccination
    where newer_vaccination.practice_id = ${practiceId}
      and newer_vaccination.patient_id = ${vaccinationRecords.patientId}
      and newer_vaccination.deleted_at is null
      and lower(btrim(newer_vaccination.vaccine_name)) = lower(btrim(${vaccinationRecords.vaccineName}))
      and not exists (
        select 1
        from clinical_record_corrections as newer_correction
        where newer_correction.practice_id = ${practiceId}
          and newer_correction.vaccination_record_id = newer_vaccination.id
      )
      and (
        newer_vaccination.administered_at > ${vaccinationRecords.administeredAt}
        or (
          newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
          and newer_vaccination.created_at > ${vaccinationRecords.createdAt}
        )
        or (
          newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
          and newer_vaccination.created_at = ${vaccinationRecords.createdAt}
          and newer_vaccination.id::text > ${vaccinationRecords.id}::text
        )
      )
  )`;
}

function formatDate(d: Date | string, timeZone?: string | null): string {
  const date = new Date(d);
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone?.trim() || "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  try {
    return date.toLocaleDateString("en-US", options);
  } catch {
    return date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  }
}

function formatTime(d: Date | string, timeZone?: string | null): string {
  const date = new Date(d);
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone?.trim() || "UTC",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return date.toLocaleTimeString("en-US", options);
  } catch {
    return date.toLocaleTimeString("en-US", { ...options, timeZone: "UTC" });
  }
}

export const REMINDER_BATCH_MAX_TARGETS = 100;

type NotificationsDb = Pick<Database, "select">;

function practiceDisplayName(name?: string | null): string {
  return name?.trim() || DEFAULT_PRACTICE_NAME;
}

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: {
  db: NotificationsDb;
  practiceId: string;
}) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function practiceNotificationSettings(ctx: {
  db: NotificationsDb;
  practiceId: string;
}): Promise<{
  name: string;
  phone: string | null;
  timezone: string | null;
  currency: string;
  country: string;
}> {
  const [practice] = await ctx.db
    .select({
      name: practices.name,
      phone: practices.phone,
      timezone: practices.timezone,
      currency: practices.currency,
      country: practices.country,
    })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }

  return {
    name: practiceDisplayName(practice.name),
    phone: practice.phone ?? null,
    timezone: practice.timezone ?? null,
    currency: practice.currency ?? "usd",
    country: practice.country ?? "US",
  };
}

async function practiceDateInput(ctx: {
  db: NotificationsDb;
  practiceId: string;
}): Promise<string> {
  const practice = await practiceNotificationSettings(ctx);
  return formatDateInputForTimeZone(new Date(), practice.timezone);
}

async function activeReminderSmsSender(ctx: {
  db: NotificationsDb;
  practiceId: string;
}): Promise<{ locationId: string } | null> {
  const [smsSender] = await ctx.db
    .select({ locationId: locationMessaging.locationId })
    .from(locationMessaging)
    .innerJoin(
      locations,
      and(
        eq(locations.id, locationMessaging.locationId),
        eq(locations.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locations.deletedAt)
      )
    )
    .where(
      and(
        eq(locationMessaging.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locationMessaging.deletedAt),
        eq(locations.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locations.deletedAt),
        eq(locationMessaging.enabled, true),
        eq(locationMessaging.registrationStatus, "active"),
        hasNonBlankMessagingSender()
      )
    )
    .limit(1);
  return smsSender ?? null;
}

export const notificationsRouter = createRouter({
  sendAppointmentReminder: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ appointmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [appt] = await ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          status: appointments.status,
          patientName: patients.name,
          clientId: appointments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          preferredContactMethod: clients.preferredContactMethod,
          smsConsent: clients.smsConsent,
          emailSuppressionReason: emailSuppressions.reason,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt)
          )
        )
        .leftJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);

      if (!appt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
      }
      if (appt.status !== "confirmed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Confirm the appointment before sending a reminder.",
        });
      }

      // Manual send: respect the client's preferred channel + SMS consent.
      // Quiet hours don't apply — this is a deliberate staff action.
      const logReminder = (
        channel: "sms" | "email",
        providerMessageId?: string
      ) =>
        ctx.db.insert(communications).values({
          practiceId: ctx.practiceId,
          clientId: appt.clientId!,
          channel,
          direction: "outbound",
          subject: "Appointment Reminder",
          content: `Appointment reminder sent for ${appt.patientName} on ${formatDate(
            appt.startTime,
            appt.practiceTimezone
          )}`,
          status: "sent",
          providerMessageId,
        });

      const sendEmail = async () => {
        const clientEmail = normalizeEmailSuppressionAddress(appt.clientEmail);
        if (!clientEmail) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Client does not have an email address on file",
          });
        }
        if (appt.emailSuppressionReason) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: emailSuppressionSendBlockMessage(
              appt.emailSuppressionReason
            ),
          });
        }
        const result = await sendAppointmentReminder({
          to: clientEmail,
          clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
          patientName: appt.patientName ?? "Unknown",
          appointmentDate: formatDate(appt.startTime, appt.practiceTimezone),
          appointmentTime: formatTime(appt.startTime, appt.practiceTimezone),
          practiceName: practiceDisplayName(appt.practiceName),
          practicePhone: appt.practicePhone ?? undefined,
        });
        if (!result.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: result.error ?? "Could not send email reminder",
          });
        }
        await logReminder("email", result.id);
      };

      const channel = pickReminderChannel({
        preferredContactMethod: appt.preferredContactMethod,
        phone: appt.clientPhone,
        smsConsent: appt.smsConsent ?? false,
        hasEmail: Boolean(normalizeEmailSuppressionAddress(appt.clientEmail)),
        quietHours: isQuietHours(new Date(), appt.practiceTimezone),
      });

      if (channel === "none") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Client has no email and no SMS-consented phone number on file",
        });
      }

      if (channel === "skip") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "SMS reminders cannot be sent during quiet hours (9 PM–8 AM local time). Try again after 8 AM.",
        });
      }

      if (channel === "sms") {
        const smsSender = await activeReminderSmsSender(ctx);
        const result = smsSender
          ? await sendAppointmentReminderSms({
              to: appt.clientPhone!,
              patientName: appt.patientName ?? "Unknown",
              appointmentDate: formatDate(appt.startTime, appt.practiceTimezone),
              appointmentTime: formatTime(appt.startTime, appt.practiceTimezone),
              practiceName: practiceDisplayName(appt.practiceName),
              practicePhone: appt.practicePhone ?? undefined,
              practiceId: ctx.practiceId,
              locationId: smsSender.locationId,
            })
          : {
              success: false,
              error: "Set up an active texting number before sending SMS reminders",
            };
        if (result.success) {
          await logReminder("sms", result.sid);
          return { success: true, channel: "sms" as const };
        }
        // SMS blocked (e.g. opted out) — fall back to email if we can.
        if (normalizeEmailSuppressionAddress(appt.clientEmail)) {
          await sendEmail();
          return { success: true, channel: "email" as const };
        }
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.error ?? "Could not send SMS reminder",
        });
      }

      await sendEmail();
      return { success: true, channel: "email" as const };
    }),

  sendInvoiceEmail: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ invoiceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          total: invoices.total,
          paidAmount: invoices.paidAmount,
          dueDate: invoices.dueDate,
          status: invoices.status,
          isEstimate: invoices.isEstimate,
          appointmentId: invoices.appointmentId,
          clientId: invoices.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          emailSuppressionReason: emailSuppressions.reason,
        })
        .from(invoices)
        .leftJoin(
          clients,
          and(
            eq(invoices.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt)
          )
        )
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
            isNull(invoices.deletedAt)
          )
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }
      if (invoice.isEstimate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Convert the estimate before emailing an invoice.",
        });
      }
      if (
        invoice.status !== "sent" &&
        invoice.status !== "overdue"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Only sent or overdue invoices can be emailed. Use the receipt for paid invoices.",
        });
      }
      await assertVisitInvoiceReadyForFinancialAction(
        ctx,
        invoice.appointmentId
      );
      const clientEmail = normalizeEmailSuppressionAddress(invoice.clientEmail);
      if (!clientEmail) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Client does not have an email address on file" });
      }
      if (invoice.emailSuppressionReason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: emailSuppressionSendBlockMessage(
            invoice.emailSuppressionReason
          ),
        });
      }

      const adjustmentRows = await ctx.db
        .select({ amount: invoiceAdjustments.amount })
        .from(invoiceAdjustments)
        .where(
          and(
            eq(invoiceAdjustments.invoiceId, invoice.id),
            sql`exists (
              select 1
              from ${invoices}
              where ${invoices.id} = ${invoiceAdjustments.invoiceId}
                and ${invoices.practiceId} = ${ctx.practiceId}
                and ${invoices.clientId} = ${invoice.clientId}
                and ${invoices.deletedAt} is null
            )`,
            isNull(invoiceAdjustments.deletedAt)
          )
        );
      const adjustedCents = adjustmentRows.reduce(
        (sum, row) => sum + moneyToCents(row.amount),
        0
      );
      const amountDue = centsToMoney(
        invoiceBalanceCents(invoice, adjustedCents)
      );

      // Format the live balance in the practice's region currency.
      const practice = await practiceNotificationSettings(ctx);
      const totalFormatted = formatCurrency(
        amountDue,
        practice.currency,
        practice.country
      );

      const emailResult = await sendInvoiceEmail({
        to: clientEmail,
        clientName: `${invoice.clientFirstName} ${invoice.clientLastName}`,
        invoiceTotal: totalFormatted,
        dueDate: invoice.dueDate
          ? formatClinicalDate(invoice.dueDate, practice.timezone, invoice.dueDate)
          : undefined,
        practiceName: practice.name,
        practicePhone: practice.phone ?? undefined,
      });
      if (!emailResult.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: emailResult.error ?? "Could not send invoice email",
        });
      }

      await ctx.db.insert(communications).values({
        practiceId: ctx.practiceId,
        clientId: invoice.clientId,
        channel: "email",
        direction: "outbound",
        subject: "Invoice",
        content: `Invoice sent — amount due: ${totalFormatted}`,
        status: "sent",
        providerMessageId: emailResult.id,
      });

      return { success: true };
    }),

  getUpcomingReminders: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    return ctx.db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        status: appointments.status,
        patientName: patients.name,
        clientId: appointments.clientId,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        clientEmail: clients.email,
        doctorName: users.name,
      })
      .from(appointments)
      .leftJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.clientId, appointments.clientId),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt)
        )
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, now),
          lte(appointments.startTime, in24h),
          eq(appointments.status, "confirmed")
        )
      )
      .orderBy(appointments.startTime);
  }),

  sendBulkReminders: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        appointmentIds: z
          .array(z.string().uuid())
          .max(
            REMINDER_BATCH_MAX_TARGETS,
            `Bulk reminders can target at most ${REMINDER_BATCH_MAX_TARGETS} appointments.`
          ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      if (input.appointmentIds.length === 0) return { sent: 0, failed: 0 };
      const appointmentIds = [...new Set(input.appointmentIds)];

      const appts = await ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          patientName: patients.name,
          clientId: appointments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          preferredContactMethod: clients.preferredContactMethod,
          smsConsent: clients.smsConsent,
          emailSuppressionReason: emailSuppressions.reason,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt)
          )
        )
        .leftJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt)
          )
        )
        .where(
          and(
            inArray(appointments.id, appointmentIds),
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
            isNull(appointments.deletedAt),
            eq(appointments.status, "confirmed")
          )
        );

      let sent = 0;
      let failed = appointmentIds.length - appts.length;
      let smsSenderPromise: Promise<{ locationId: string } | null> | null = null;
      const getSmsSender = () => {
        smsSenderPromise ??= activeReminderSmsSender(ctx);
        return smsSenderPromise;
      };

      for (const appt of appts) {
        const appointmentDate = formatDate(
          appt.startTime,
          appt.practiceTimezone
        );
        const appointmentTime = formatTime(
          appt.startTime,
          appt.practiceTimezone
        );

        const logReminder = (
          channel: "sms" | "email",
          providerMessageId?: string
        ) =>
          ctx.db.insert(communications).values({
            practiceId: ctx.practiceId,
            clientId: appt.clientId!,
            channel,
            direction: "outbound",
            subject: "Appointment Reminder",
            content: `Reminder sent for ${appt.patientName} on ${appointmentDate}`,
            status: "sent",
            providerMessageId,
          });

        const sendEmail = async (): Promise<boolean> => {
          const clientEmail = normalizeEmailSuppressionAddress(appt.clientEmail);
          if (!clientEmail) return false;
          if (appt.emailSuppressionReason) return false;
          try {
            const result = await sendAppointmentReminder({
              to: clientEmail,
              clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
              patientName: appt.patientName ?? "Unknown",
              appointmentDate,
              appointmentTime,
              practiceName: practiceDisplayName(appt.practiceName),
              practicePhone: appt.practicePhone ?? undefined,
            });
            if (!result.success) return false;
            await logReminder("email", result.id);
            return true;
          } catch {
            return false;
          }
        };

        const channel = pickReminderChannel({
          preferredContactMethod: appt.preferredContactMethod,
          phone: appt.clientPhone,
          smsConsent: appt.smsConsent ?? false,
          hasEmail: Boolean(normalizeEmailSuppressionAddress(appt.clientEmail)),
          quietHours: isQuietHours(new Date(), appt.practiceTimezone),
        });

        if (channel === "sms") {
          const smsSender = await getSmsSender();
          let result: { success: boolean; sid?: string; error?: string };
          if (smsSender) {
            try {
              result = await sendAppointmentReminderSms({
                to: appt.clientPhone!,
                patientName: appt.patientName ?? "Unknown",
                appointmentDate,
                appointmentTime,
                practiceName: practiceDisplayName(appt.practiceName),
                practicePhone: appt.practicePhone ?? undefined,
                practiceId: ctx.practiceId,
                locationId: smsSender.locationId,
              });
            } catch (error) {
              result = {
                success: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "Could not send SMS reminder",
              };
            }
          } else {
            result = {
              success: false,
              error:
                "Set up an active texting number before sending SMS reminders",
            };
          }
          if (result.success) {
            await logReminder("sms", result.sid);
            sent++;
            continue;
          }

          if (await sendEmail()) {
            sent++;
            continue;
          }

          failed++;
          continue;
        }

        if (channel === "email") {
          if (await sendEmail()) {
            sent++;
          } else {
            failed++;
          }
          continue;
        }

        failed++;
      }

      return { sent, failed };
  }),

  getOverdueVaccinations: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const today = await practiceDateInput(ctx);

    const rows = await ctx.db
      .select({
        patientId: patients.id,
        patientName: patients.name,
        clientId: clients.id,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        clientEmail: clients.email,
        vaccineName: vaccinationRecords.vaccineName,
        nextDueDate: vaccinationRecords.nextDueDate,
      })
      .from(vaccinationRecords)
      .innerJoin(
        patients,
        and(
          eq(vaccinationRecords.patientId, patients.id),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .innerJoin(
        clients,
        and(
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(vaccinationRecords.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(vaccinationRecords.deletedAt),
          validVaccinationRecordPredicate(ctx.practiceId),
          latestValidVaccinationRecordPredicate(ctx.practiceId),
          eq(patients.practiceId, ctx.practiceId),
          isNull(patients.deletedAt),
          eq(clients.practiceId, ctx.practiceId),
          isNull(clients.deletedAt),
          lt(vaccinationRecords.nextDueDate, today)
        )
      )
      .orderBy(patients.name);

    const grouped = new Map<string, {
      patientId: string;
      patientName: string;
      clientId: string;
      clientFirstName: string;
      clientLastName: string;
      clientEmail: string | null;
      overdueVaccines: { vaccineName: string; nextDueDate: string | null }[];
    }>();

    for (const row of rows) {
      const existing = grouped.get(row.patientId);
      if (existing) {
        existing.overdueVaccines.push({ vaccineName: row.vaccineName, nextDueDate: row.nextDueDate });
      } else {
        grouped.set(row.patientId, {
          patientId: row.patientId,
          patientName: row.patientName,
          clientId: row.clientId,
          clientFirstName: row.clientFirstName,
          clientLastName: row.clientLastName,
          clientEmail: row.clientEmail,
          overdueVaccines: [{ vaccineName: row.vaccineName, nextDueDate: row.nextDueDate }],
        });
      }
    }

    return Array.from(grouped.values());
  }),

  getVaccinationRecallPreview: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .query(async ({ ctx }) => {
      await assertActivePractice(ctx);
      const preview = await getVaccinationRecallPreview(ctx);
      if (!preview) throw practiceNotFound();
      return preview;
    }),

  sendVaccinationReminders: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(
      z.object({
        patientIds: z
          .array(z.string().uuid())
          .max(
            REMINDER_BATCH_MAX_TARGETS,
            `Vaccination reminders can target at most ${REMINDER_BATCH_MAX_TARGETS} patients.`
          ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const result = await sendVaccinationRecallReminders(
        ctx,
        input.patientIds
      );
      if (!result) throw practiceNotFound();
      return result;
    }),
});
