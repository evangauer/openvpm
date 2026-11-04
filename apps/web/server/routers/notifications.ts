import { z } from "zod";
import { eq, and, isNull, gte, lte, lt, inArray, or, sql } from "drizzle-orm";
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
  rooms,
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
import { isQuietHours, pickReminderChannel } from "@/lib/messaging/reminders";
import { formatCurrency } from "@/lib/locale/format";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import {
  type AppointmentReminderClaim,
  appointmentReminderConflictMessage,
  appointmentReminderDedupeKey,
  appointmentReminderEmailFields,
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderMessageFields,
  appointmentReminderResultForClaim,
  appointmentReminderSmsIdempotencyKey,
  claimAppointmentReminderCommunication,
  emailReminderFailureReason,
  recordAppointmentReminderOutcome,
  sendClaimedAppointmentReminderEmail,
  reminderFailureReason,
  smsReminderFailureReason,
  switchAppointmentReminderClaimToEmail,
} from "@/lib/messaging/appointment-reminder";
import { withDurableSmsCommunication } from "@/lib/messaging/durable-sms-communication";
import { alertOps } from "@/lib/alerts";
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
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { assertOutboundEmailAllowed } from "@/lib/outbound-email-security";

const DEFAULT_PRACTICE_NAME = "your clinic";

function assertStaffOutboundEmailAllowed(
  ctx: {
    practiceId: string;
    ip?: string | null;
    user: {
      id: string;
      emailVerifiedAt?: Date | string | null;
      practiceCreatedAt?: Date | string | null;
    };
  },
  operation: "appointment_reminder" | "invoice" | "vaccination_recall",
) {
  return assertOutboundEmailAllowed({
    practiceId: ctx.practiceId,
    practiceCreatedAt: ctx.user.practiceCreatedAt,
    userId: ctx.user.id,
    userEmailVerifiedAt: ctx.user.emailVerifiedAt,
    ip: ctx.ip,
    operation,
  });
}

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

async function assertNotificationsEnabled(ctx: {
  db: NotificationsDb;
  practiceId: string;
}) {
  if (!(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: RECOVERY_HOLD_BLOCK_MESSAGE,
    });
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

async function activeReminderSmsSender(
  ctx: {
    db: NotificationsDb;
    practiceId: string;
  },
  locationId?: string,
): Promise<{ locationId: string } | null> {
  const smsSenders = await ctx.db
    .select({ locationId: locationMessaging.locationId })
    .from(locationMessaging)
    .innerJoin(
      locations,
      and(
        eq(locations.id, locationMessaging.locationId),
        eq(locations.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locations.deletedAt),
      ),
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
        ...(locationId ? [eq(locationMessaging.locationId, locationId)] : []),
        hasNonBlankMessagingSender(),
      ),
    )
    .limit(2);
  return smsSenders.length === 1 ? smsSenders[0]! : null;
}

/**
 * Send a reminder email fenced by its claim (see
 * sendClaimedAppointmentReminderEmail): a claim that was taken over never
 * sends, and a failure after the provider call is an unknown outcome.
 */
async function sendFencedReminderEmail(
  practiceId: string,
  claim: AppointmentReminderClaim,
  email: Parameters<typeof sendAppointmentReminder>[0],
  providerCall: { called: boolean } = { called: false },
): Promise<Awaited<ReturnType<typeof sendAppointmentReminder>> | "superseded"> {
  const sent = await sendClaimedAppointmentReminderEmail(
    (fn) => withDurableSmsCommunication(practiceId, fn),
    { practiceId, claim },
    () => {
      providerCall.called = true;
      return sendAppointmentReminder(email);
    },
  );
  return sent.status === "called" ? sent.result : "superseded";
}

export const notificationsRouter = createRouter({
  sendAppointmentReminder: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(z.object({ appointmentId: z.string().guid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertNotificationsEnabled(ctx);
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
          locationId: sql<string | null>`coalesce(${appointments.locationId}, ${rooms.locationId})`,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt),
          ),
        )
        .leftJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt),
          ),
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, ctx.practiceId),
            isNull(rooms.deletedAt),
          ),
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
            isNull(appointments.deletedAt),
          ),
        )
        .limit(1);

      if (!appt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment not found",
        });
      }
      if (appt.status !== "confirmed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Confirm the appointment before sending a reminder.",
        });
      }

      // Manual send: respect the client's preferred channel + SMS consent.
      // Quiet hours don't apply — this is a deliberate staff action.
      let reminderClaim: AppointmentReminderClaim | null = null;
      let failureChannel: "sms" | "email" = "email";
      // Shared with the hourly sweep so a resend under the same provider
      // idempotency key is byte-identical.
      const message = appointmentReminderMessageFields({
        startTime: appt.startTime,
        timeZone: appt.practiceTimezone,
        patientName: appt.patientName,
        practiceName: appt.practiceName,
        practicePhone: appt.practicePhone,
      });
      const reminderDate = message.appointmentDate;
      const logReminder = async (
        channel: "sms" | "email",
        requested: "sent" | "failed" | "unknown",
        detail: { providerMessageId?: string; reason?: string } = {},
      ) => {
        const result = appointmentReminderResultForClaim(
          reminderClaim!,
          requested,
        );
        const label =
          result === "sent"
            ? "sent"
            : result === "failed"
              ? "failed"
              : "delivery unknown";
        const project = (tx: Pick<Database, "update">) =>
          recordAppointmentReminderOutcome(tx, {
            practiceId: ctx.practiceId,
            claim: reminderClaim!,
            channel,
            result,
            source: "staff",
            content: `Appointment reminder ${label} for ${appt.patientName} on ${reminderDate}${result !== "sent" && detail.reason ? `: ${detail.reason}` : ""}`,
            providerMessageId: detail.providerMessageId,
          });
        try {
          return await withDurableSmsCommunication(ctx.practiceId, project);
        } catch (error) {
          await alertOps(
            "Appointment reminder projection failed",
            `practice=${ctx.practiceId} communication=${reminderClaim?.id ?? "unknown"} source=appointment_reminder status=${result}`,
          ).catch(() => undefined);
          throw error;
        }
      };

      let emailGatePassed = false;
      let emailAccepted = false;
      let emailOutcomeUnknown = false;
      let superseded = false;
      let smsFailureReason: string | null = null;
      const sendEmail = async () => {
        failureChannel = "email";
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
              appt.emailSuppressionReason,
            ),
          });
        }
        if (!emailGatePassed) {
          await assertStaffOutboundEmailAllowed(ctx, "appointment_reminder");
          emailGatePassed = true;
        }
        const result = await sendFencedReminderEmail(
          ctx.practiceId,
          reminderClaim!,
          {
            to: clientEmail,
            ...appointmentReminderEmailFields({
              startTime: appt.startTime,
              timeZone: appt.practiceTimezone,
              clientFirstName: appt.clientFirstName,
              clientLastName: appt.clientLastName,
              patientName: appt.patientName,
              practiceName: appt.practiceName,
              practicePhone: appt.practicePhone,
            }),
            idempotencyKey: appointmentReminderEmailIdempotencyKey(
              appt,
              reminderClaim!.attempt,
            ),
          },
        );
        if (result === "superseded") {
          superseded = true;
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "Another send took over this reminder. Check the client's timeline before sending again.",
          });
        }
        if (!result.success) {
          emailOutcomeUnknown = result.outcome === "outcome_unknown";
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: emailReminderFailureReason(result),
          });
        }
        // The provider accepted it: never let a projection error below turn
        // a delivered reminder into a "failed" one that invites a duplicate.
        emailAccepted = true;
        await logReminder("email", "sent", { providerMessageId: result.id });
      };

      let channel = pickReminderChannel({
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

      let smsSender: { locationId: string } | null = null;
      if (channel === "sms") {
        smsSender = appt.locationId
          ? await activeReminderSmsSender(ctx, appt.locationId)
          : null;
        if (!smsSender) {
          if (
            normalizeEmailSuppressionAddress(appt.clientEmail) &&
            !appt.emailSuppressionReason
          ) {
            channel = "email";
          } else {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Set up an active texting number before sending SMS reminders",
            });
          }
        }
      }
      if (channel === "email") {
        if (!normalizeEmailSuppressionAddress(appt.clientEmail)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Client does not have an email address on file",
          });
        }
        if (appt.emailSuppressionReason) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: emailSuppressionSendBlockMessage(
              appt.emailSuppressionReason,
            ),
          });
        }
        // Run the sender gate before claiming so a blocked send never leaves a
        // reminder row behind.
        await assertStaffOutboundEmailAllowed(ctx, "appointment_reminder");
        emailGatePassed = true;
      }

      const claimOptions = {
        practiceId: ctx.practiceId,
        appointmentId: appt.id,
        clientId: appt.clientId!,
        channel,
        patientName: appt.patientName,
        startTime: new Date(appt.startTime),
      };
      // The claim and every outcome commit on their own, outside the request
      // transaction: once a provider may have sent the reminder, a rolled-back
      // request must not erase the claim and invite a duplicate.
      reminderClaim = await withDurableSmsCommunication(ctx.practiceId, (tx) =>
        claimAppointmentReminderCommunication(tx, claimOptions),
      );
      if (!reminderClaim) {
        throw new TRPCError({
          code: "CONFLICT",
          message: await appointmentReminderConflictMessage(ctx.db, {
            practiceId: ctx.practiceId,
            appointmentId: appt.id,
            startTime: new Date(appt.startTime),
          }),
        });
      }

      // From here on the claim must end as sent, failed, or delivery unknown,
      // never a stray pending row: a pending row blocks every later reminder
      // for the visit. An SMS whose provider outcome is unknown stays pending
      // (marked unknown) until the provider result is reconciled.
      let preservePendingSmsOutcome = false;
      try {
        if (channel === "sms") {
          failureChannel = "sms";
          preservePendingSmsOutcome = true;
          const result = await sendAppointmentReminderSms({
            to: appt.clientPhone!,
            ...message,
            practiceId: ctx.practiceId,
            locationId: smsSender!.locationId,
            clientId: appt.clientId!,
            communicationId: reminderClaim.id,
            source: "appointment_reminder",
            sourceId: appointmentReminderDedupeKey(appt),
            idempotencyKey: appointmentReminderSmsIdempotencyKey(
              appt,
              reminderClaim.attempt,
            ),
            reminderClaimToken: reminderClaim.claimToken,
          });
          if (result.success) {
            await logReminder("sms", "sent", { providerMessageId: result.sid });
            preservePendingSmsOutcome = false;
            return { success: true, channel: "sms" as const };
          }
          const reason = smsReminderFailureReason(result);
          if (result.outcome === "outcome_unknown") {
            await logReminder("sms", "unknown", { reason }).catch(
              () => undefined,
            );
            throw new TRPCError({ code: "BAD_REQUEST", message: reason });
          }
          preservePendingSmsOutcome = false;
          smsFailureReason = reason;
          // SMS blocked (e.g. opted out) — fall back to email if we can.
          if (normalizeEmailSuppressionAddress(appt.clientEmail)) {
            failureChannel = "email";
            const switched = await withDurableSmsCommunication(
              ctx.practiceId,
              (tx) =>
                switchAppointmentReminderClaimToEmail(tx, {
                  practiceId: ctx.practiceId,
                  claim: reminderClaim!,
                }),
            );
            if (!switched) {
              superseded = true;
              throw new TRPCError({ code: "BAD_REQUEST", message: reason });
            }
            await sendEmail();
            return { success: true, channel: "email" as const };
          }
          throw new TRPCError({ code: "BAD_REQUEST", message: reason });
        }

        await sendEmail();
        return { success: true, channel: "email" as const };
      } catch (error) {
        if (!preservePendingSmsOutcome && !emailAccepted && !superseded) {
          const reason = reminderFailureReason(error);
          await logReminder(
            failureChannel,
            emailOutcomeUnknown ? "unknown" : "failed",
            {
              reason:
                smsFailureReason && failureChannel === "email"
                  ? `Text message: ${smsFailureReason} Email fallback: ${reason}`
                  : reason,
            },
          ).catch(() => undefined);
        }
        throw error;
      }
    }),

  sendInvoiceEmail: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ invoiceId: z.string().guid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertNotificationsEnabled(ctx);
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
            isNull(clients.deletedAt),
          ),
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt),
          ),
        )
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }
      if (invoice.isEstimate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Convert the estimate before emailing an invoice.",
        });
      }
      if (invoice.status !== "sent" && invoice.status !== "overdue") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Only sent or overdue invoices can be emailed. Use the receipt for paid invoices.",
        });
      }
      await assertVisitInvoiceReadyForFinancialAction(
        ctx,
        invoice.appointmentId,
      );
      const clientEmail = normalizeEmailSuppressionAddress(invoice.clientEmail);
      if (!clientEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Client does not have an email address on file",
        });
      }
      if (invoice.emailSuppressionReason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: emailSuppressionSendBlockMessage(
            invoice.emailSuppressionReason,
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
            isNull(invoiceAdjustments.deletedAt),
          ),
        );
      const adjustedCents = adjustmentRows.reduce(
        (sum, row) => sum + moneyToCents(row.amount),
        0,
      );
      const amountDue = centsToMoney(
        invoiceBalanceCents(invoice, adjustedCents),
      );

      // Format the live balance in the practice's region currency.
      const practice = await practiceNotificationSettings(ctx);
      const totalFormatted = formatCurrency(
        amountDue,
        practice.currency,
        practice.country,
      );

      await assertStaffOutboundEmailAllowed(ctx, "invoice");
      const emailResult = await sendInvoiceEmail({
        to: clientEmail,
        clientName: `${invoice.clientFirstName} ${invoice.clientLastName}`,
        invoiceTotal: totalFormatted,
        dueDate: invoice.dueDate
          ? formatClinicalDate(
              invoice.dueDate,
              practice.timezone,
              invoice.dueDate,
            )
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
          isNull(patients.deletedAt),
        ),
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt),
        ),
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
          eq(appointments.status, "confirmed"),
        ),
      )
      .orderBy(appointments.startTime);
  }),

  sendBulkReminders: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        appointmentIds: z
          .array(z.string().guid())
          .max(
            REMINDER_BATCH_MAX_TARGETS,
            `Bulk reminders can target at most ${REMINDER_BATCH_MAX_TARGETS} appointments.`,
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertNotificationsEnabled(ctx);
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
          locationId: sql<string | null>`coalesce(${appointments.locationId}, ${rooms.locationId})`,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, ctx.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt),
          ),
        )
        .leftJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            eq(practices.id, ctx.practiceId),
            isNull(practices.deletedAt),
          ),
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, ctx.practiceId),
            isNull(rooms.deletedAt),
          ),
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
            eq(appointments.status, "confirmed"),
          ),
        );

      let sent = 0;
      let failed = appointmentIds.length - appts.length;
      const smsSenderPromises = new Map<
        string,
        Promise<{ locationId: string } | null>
      >();
      const getSmsSender = (locationId: string | null) => {
        if (!locationId) return Promise.resolve(null);
        let promise = smsSenderPromises.get(locationId);
        if (!promise) {
          promise = activeReminderSmsSender(ctx, locationId);
          smsSenderPromises.set(locationId, promise);
        }
        return promise;
      };

      for (const appt of appts) {
        // Shared with the hourly sweep so a resend under the same provider
        // idempotency key is byte-identical.
        const message = appointmentReminderMessageFields({
          startTime: appt.startTime,
          timeZone: appt.practiceTimezone,
          patientName: appt.patientName,
          practiceName: appt.practiceName,
          practicePhone: appt.practicePhone,
        });
        const appointmentDate = message.appointmentDate;

        let reminderClaim: AppointmentReminderClaim | null = null;
        const logReminder = async (
          channel: "sms" | "email",
          requested: "sent" | "failed" | "unknown",
          detail: { providerMessageId?: string; reason?: string } = {},
        ) => {
          const result = appointmentReminderResultForClaim(
            reminderClaim!,
            requested,
          );
          const label =
            result === "sent"
              ? "sent"
              : result === "failed"
                ? "failed"
                : "delivery unknown";
          const project = (tx: Pick<Database, "update">) =>
            recordAppointmentReminderOutcome(tx, {
              practiceId: ctx.practiceId,
              claim: reminderClaim!,
              channel,
              result,
              source: "staff",
              content: `Reminder ${label} for ${appt.patientName} on ${appointmentDate}${result !== "sent" && detail.reason ? `: ${detail.reason}` : ""}`,
              providerMessageId: detail.providerMessageId,
            });
          try {
            return await withDurableSmsCommunication(ctx.practiceId, project);
          } catch (error) {
            await alertOps(
              "Appointment reminder projection failed",
              `practice=${ctx.practiceId} communication=${reminderClaim?.id ?? "unknown"} source=appointment_reminder status=${result}`,
            ).catch(() => undefined);
            throw error;
          }
        };

        type EmailAttempt =
          | { result: "sent" }
          | { result: "superseded" }
          | { result: "failed" | "unknown"; reason: string };
        const sendEmail = async (): Promise<EmailAttempt> => {
          const clientEmail = normalizeEmailSuppressionAddress(
            appt.clientEmail,
          );
          if (!clientEmail) {
            return {
              result: "failed",
              reason: "Client does not have an email address on file",
            };
          }
          if (appt.emailSuppressionReason) {
            return {
              result: "failed",
              reason: emailSuppressionSendBlockMessage(
                appt.emailSuppressionReason,
              ),
            };
          }
          let emailAccepted = false;
          const providerCall = { called: false };
          try {
            await assertStaffOutboundEmailAllowed(
              ctx,
              "appointment_reminder",
            );
            const result = await sendFencedReminderEmail(
              ctx.practiceId,
              reminderClaim!,
              {
                to: clientEmail,
                ...appointmentReminderEmailFields({
                  startTime: appt.startTime,
                  timeZone: appt.practiceTimezone,
                  clientFirstName: appt.clientFirstName,
                  clientLastName: appt.clientLastName,
                  patientName: appt.patientName,
                  practiceName: appt.practiceName,
                  practicePhone: appt.practicePhone,
                }),
                idempotencyKey: appointmentReminderEmailIdempotencyKey(
                  appt,
                  reminderClaim!.attempt,
                ),
              },
              providerCall,
            );
            if (result === "superseded") return { result: "superseded" };
            if (!result.success) {
              return {
                result:
                  result.outcome === "outcome_unknown" ? "unknown" : "failed",
                reason: emailReminderFailureReason(result),
              };
            }
            // The provider accepted it: a projection error below must not
            // turn a delivered reminder into a "failed" one.
            emailAccepted = true;
            await logReminder("email", "sent", {
              providerMessageId: result.id,
            });
            return { result: "sent" };
          } catch (error) {
            if (emailAccepted) {
              console.error(
                "[notifications] accepted reminder email projection failed:",
                error,
              );
              return { result: "sent" };
            }
            // Once the provider was called, an error is never proof that the
            // email did not go out.
            return {
              result: providerCall.called ? "unknown" : "failed",
              reason: reminderFailureReason(error),
            };
          }
        };

        let channel = pickReminderChannel({
          preferredContactMethod: appt.preferredContactMethod,
          phone: appt.clientPhone,
          smsConsent: appt.smsConsent ?? false,
          hasEmail: Boolean(normalizeEmailSuppressionAddress(appt.clientEmail)),
          quietHours: isQuietHours(new Date(), appt.practiceTimezone),
        });

        if (channel === "none" || channel === "skip") {
          failed++;
          continue;
        }
        let smsSender: { locationId: string } | null = null;
        if (channel === "sms") {
          smsSender = await getSmsSender(appt.locationId);
          if (!smsSender) {
            if (
              normalizeEmailSuppressionAddress(appt.clientEmail) &&
              !appt.emailSuppressionReason
            ) {
              channel = "email";
            } else {
              failed++;
              continue;
            }
          }
        }
        if (
          channel === "email" &&
          (!normalizeEmailSuppressionAddress(appt.clientEmail) ||
            appt.emailSuppressionReason)
        ) {
          failed++;
          continue;
        }
        const claimOptions = {
          practiceId: ctx.practiceId,
          appointmentId: appt.id,
          clientId: appt.clientId!,
          channel,
          patientName: appt.patientName,
          startTime: new Date(appt.startTime),
        };
        // Committed outside the request transaction (see sendAppointmentReminder).
        reminderClaim = await withDurableSmsCommunication(
          ctx.practiceId,
          (tx) => claimAppointmentReminderCommunication(tx, claimOptions),
        );
        if (!reminderClaim) {
          failed++;
          continue;
        }

        if (channel === "sms") {
          let result:
            | Awaited<ReturnType<typeof sendAppointmentReminderSms>>
            | {
                success: false;
                outcome: "outcome_unknown";
                replayed: false;
                error: string;
              };
          try {
            result = await sendAppointmentReminderSms({
              to: appt.clientPhone!,
              ...message,
              practiceId: ctx.practiceId,
              locationId: smsSender!.locationId,
              clientId: appt.clientId!,
              communicationId: reminderClaim.id,
              source: "appointment_reminder",
              sourceId: appointmentReminderDedupeKey(appt),
              idempotencyKey: appointmentReminderSmsIdempotencyKey(
                appt,
                reminderClaim.attempt,
              ),
              reminderClaimToken: reminderClaim.claimToken,
            });
          } catch (error) {
            result = {
              success: false,
              outcome: "outcome_unknown",
              replayed: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not send SMS reminder",
            };
          }
          if (result.success) {
            await logReminder("sms", "sent", { providerMessageId: result.sid });
            sent++;
            continue;
          }

          const smsReason = smsReminderFailureReason(result);
          if (result.outcome === "outcome_unknown") {
            // Keep the claim pending (marked unknown) until reconciled.
            await logReminder("sms", "unknown", { reason: smsReason }).catch(
              () => undefined,
            );
            failed++;
            continue;
          }

          // SMS blocked (e.g. opted out) — fall back to email if we can.
          if (!normalizeEmailSuppressionAddress(appt.clientEmail)) {
            await logReminder("sms", "failed", { reason: smsReason });
            failed++;
            continue;
          }
          const switched = await withDurableSmsCommunication(
            ctx.practiceId,
            (tx) =>
              switchAppointmentReminderClaimToEmail(tx, {
                practiceId: ctx.practiceId,
                claim: reminderClaim!,
              }),
          );
          const email: EmailAttempt = switched
            ? await sendEmail()
            : { result: "superseded" };
          if (email.result === "sent") {
            sent++;
            continue;
          }
          if (email.result === "superseded") {
            failed++;
            continue;
          }

          await logReminder("email", email.result, {
            reason: `Text message: ${smsReason} Email fallback: ${email.reason}`,
          });

          failed++;
          continue;
        }

        if (channel === "email") {
          const email = await sendEmail();
          if (email.result === "sent") {
            sent++;
          } else if (email.result === "superseded") {
            failed++;
          } else {
            await logReminder("email", email.result, { reason: email.reason });
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
          isNull(patients.deletedAt),
        ),
      )
      .innerJoin(
        clients,
        and(
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
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
          lt(vaccinationRecords.nextDueDate, today),
        ),
      )
      .orderBy(patients.name);

    const grouped = new Map<
      string,
      {
        patientId: string;
        patientName: string;
        clientId: string;
        clientFirstName: string;
        clientLastName: string;
        clientEmail: string | null;
        overdueVaccines: { vaccineName: string; nextDueDate: string | null }[];
      }
    >();

    for (const row of rows) {
      const existing = grouped.get(row.patientId);
      if (existing) {
        existing.overdueVaccines.push({
          vaccineName: row.vaccineName,
          nextDueDate: row.nextDueDate,
        });
      } else {
        grouped.set(row.patientId, {
          patientId: row.patientId,
          patientName: row.patientName,
          clientId: row.clientId,
          clientFirstName: row.clientFirstName,
          clientLastName: row.clientLastName,
          clientEmail: row.clientEmail,
          overdueVaccines: [
            { vaccineName: row.vaccineName, nextDueDate: row.nextDueDate },
          ],
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
          .array(z.string().guid())
          .max(
            REMINDER_BATCH_MAX_TARGETS,
            `Vaccination reminders can target at most ${REMINDER_BATCH_MAX_TARGETS} patients.`,
          ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      await assertNotificationsEnabled(ctx);
      const result = await sendVaccinationRecallReminders(
        {
          ...ctx,
          beforeEmail: () =>
            assertStaffOutboundEmailAllowed(ctx, "vaccination_recall"),
        },
        input.patientIds,
      );
      if (!result) throw practiceNotFound();
      return result;
    }),
});
