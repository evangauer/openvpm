import { z } from "zod";
import { eq, and, isNull, gte, lte, lt, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  appointments,
  patients,
  clients,
  users,
  communications,
  invoices,
  vaccinationRecords,
  practices,
} from "@openpims/db";
import {
  sendAppointmentReminder,
  sendInvoiceEmail,
  sendVaccinationReminder,
} from "@/lib/email";
import { sendAppointmentReminderSms } from "@/lib/sms";
import { pickReminderChannel } from "@/lib/messaging/reminders";
import { formatCurrency } from "@/lib/locale/format";

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export const notificationsRouter = createRouter({
  sendAppointmentReminder: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(z.object({ appointmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [appt] = await ctx.db
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
          practiceName: practices.name,
          practicePhone: practices.phone,
        })
        .from(appointments)
        .leftJoin(patients, eq(appointments.patientId, patients.id))
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .leftJoin(practices, eq(appointments.practiceId, practices.id))
        .where(
          and(
            eq(appointments.id, input.appointmentId),
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        )
        .limit(1);

      if (!appt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Appointment not found" });
      }

      // Manual send: respect the client's preferred channel + SMS consent.
      // Quiet hours don't apply — this is a deliberate staff action.
      const logReminder = (channel: "sms" | "email") =>
        ctx.db.insert(communications).values({
          practiceId: ctx.practiceId,
          clientId: appt.clientId!,
          channel,
          direction: "outbound",
          subject: "Appointment Reminder",
          content: `Appointment reminder sent for ${appt.patientName} on ${formatDate(appt.startTime)}`,
          status: "sent",
        });

      const sendEmail = async () => {
        await sendAppointmentReminder({
          to: appt.clientEmail!,
          clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
          patientName: appt.patientName ?? "Unknown",
          appointmentDate: formatDate(appt.startTime),
          appointmentTime: formatTime(appt.startTime),
          practiceName: appt.practiceName ?? "",
        });
        await logReminder("email");
      };

      const channel = pickReminderChannel({
        preferredContactMethod: appt.preferredContactMethod,
        phone: appt.clientPhone,
        smsConsent: appt.smsConsent ?? false,
        hasEmail: Boolean(appt.clientEmail),
        quietHours: false,
      });

      if (channel === "none") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Client has no email and no SMS-consented phone number on file",
        });
      }

      if (channel === "sms") {
        const result = await sendAppointmentReminderSms({
          to: appt.clientPhone!,
          patientName: appt.patientName ?? "Unknown",
          appointmentDate: formatDate(appt.startTime),
          appointmentTime: formatTime(appt.startTime),
          practiceName: appt.practiceName ?? "",
          practicePhone: appt.practicePhone ?? undefined,
          practiceId: ctx.practiceId,
        });
        if (result.success) {
          await logReminder("sms");
          return { success: true, channel: "sms" as const };
        }
        // SMS blocked (e.g. opted out) — fall back to email if we can.
        if (appt.clientEmail) {
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
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          total: invoices.total,
          dueDate: invoices.dueDate,
          clientId: invoices.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
        })
        .from(invoices)
        .leftJoin(clients, eq(invoices.clientId, clients.id))
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            isNull(invoices.deletedAt)
          )
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
      }
      if (!invoice.clientEmail) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Client does not have an email address on file" });
      }

      // Format the total in the practice's region currency.
      const [practice] = await ctx.db
        .select({ currency: practices.currency, country: practices.country })
        .from(practices)
        .where(eq(practices.id, ctx.practiceId))
        .limit(1);
      const totalFormatted = formatCurrency(
        invoice.total ?? 0,
        practice?.currency ?? "usd",
        practice?.country ?? "US"
      );

      await sendInvoiceEmail({
        to: invoice.clientEmail,
        clientName: `${invoice.clientFirstName} ${invoice.clientLastName}`,
        invoiceTotal: totalFormatted,
        dueDate: invoice.dueDate ?? undefined,
        practiceName: "",
      });

      await ctx.db.insert(communications).values({
        practiceId: ctx.practiceId,
        clientId: invoice.clientId,
        channel: "email",
        direction: "outbound",
        subject: "Invoice",
        content: `Invoice sent — total: ${totalFormatted}`,
        status: "sent",
      });

      return { success: true };
    }),

  getUpcomingReminders: protectedProcedure.query(async ({ ctx }) => {
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
      .leftJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(clients, eq(appointments.clientId, clients.id))
      .leftJoin(users, eq(appointments.doctorId, users.id))
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, now),
          lte(appointments.startTime, in24h),
          inArray(appointments.status, ["scheduled", "confirmed"])
        )
      )
      .orderBy(appointments.startTime);
  }),

  sendBulkReminders: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ appointmentIds: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.appointmentIds.length === 0) return { sent: 0, failed: 0 };

      const appts = await ctx.db
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          patientName: patients.name,
          clientId: appointments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
        })
        .from(appointments)
        .leftJoin(patients, eq(appointments.patientId, patients.id))
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .where(
          and(
            inArray(appointments.id, input.appointmentIds),
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt)
          )
        );

      let sent = 0;
      let failed = 0;

      for (const appt of appts) {
        if (!appt.clientEmail) { failed++; continue; }
        try {
          await sendAppointmentReminder({
            to: appt.clientEmail,
            clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
            patientName: appt.patientName ?? "Unknown",
            appointmentDate: formatDate(appt.startTime),
            appointmentTime: formatTime(appt.startTime),
            practiceName: "",
          });
          await ctx.db.insert(communications).values({
            practiceId: ctx.practiceId,
            clientId: appt.clientId!,
            channel: "email",
            direction: "outbound",
            subject: "Appointment Reminder",
            content: `Reminder sent for ${appt.patientName} on ${formatDate(appt.startTime)}`,
            status: "sent",
          });
          sent++;
        } catch {
          failed++;
        }
      }

      return { sent, failed };
    }),

  getOverdueVaccinations: protectedProcedure.query(async ({ ctx }) => {
    const today = new Date().toISOString().split("T")[0]!;

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
      .innerJoin(patients, eq(vaccinationRecords.patientId, patients.id))
      .innerJoin(clients, eq(patients.clientId, clients.id))
      .where(
        and(
          eq(vaccinationRecords.practiceId, ctx.practiceId),
          isNull(vaccinationRecords.deletedAt),
          isNull(patients.deletedAt),
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

  sendVaccinationReminders: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ patientIds: z.array(z.string().uuid()) }))
    .mutation(async ({ ctx, input }) => {
      if (input.patientIds.length === 0) return { sent: 0, failed: 0 };

      const today = new Date().toISOString().split("T")[0]!;

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
        .innerJoin(patients, eq(vaccinationRecords.patientId, patients.id))
        .innerJoin(clients, eq(patients.clientId, clients.id))
        .where(
          and(
            eq(vaccinationRecords.practiceId, ctx.practiceId),
            isNull(vaccinationRecords.deletedAt),
            isNull(patients.deletedAt),
            inArray(patients.id, input.patientIds),
            lt(vaccinationRecords.nextDueDate, today)
          )
        );

      const grouped = new Map<string, {
        patientName: string;
        clientId: string;
        clientName: string;
        clientEmail: string | null;
        vaccines: { vaccineName: string; nextDueDate: string | null }[];
      }>();

      for (const row of rows) {
        const existing = grouped.get(row.patientId);
        if (existing) {
          existing.vaccines.push({ vaccineName: row.vaccineName, nextDueDate: row.nextDueDate });
        } else {
          grouped.set(row.patientId, {
            patientName: row.patientName,
            clientId: row.clientId,
            clientName: `${row.clientFirstName} ${row.clientLastName}`,
            clientEmail: row.clientEmail,
            vaccines: [{ vaccineName: row.vaccineName, nextDueDate: row.nextDueDate }],
          });
        }
      }

      let sent = 0;
      let failed = 0;

      for (const [, data] of grouped) {
        if (!data.clientEmail) { failed++; continue; }
        try {
          // Send one email per overdue vaccine (the email template handles a single vaccine)
          for (const vax of data.vaccines) {
            await sendVaccinationReminder({
              to: data.clientEmail,
              clientName: data.clientName,
              patientName: data.patientName,
              vaccineName: vax.vaccineName,
              dueDate: vax.nextDueDate ?? "overdue",
              practiceName: "",
            });
          }
          await ctx.db.insert(communications).values({
            practiceId: ctx.practiceId,
            clientId: data.clientId,
            channel: "email",
            direction: "outbound",
            subject: "Vaccination Reminder",
            content: `Vaccination reminder sent for ${data.patientName}: ${data.vaccines.map((v) => v.vaccineName).join(", ")}`,
            status: "sent",
          });
          sent++;
        } catch {
          failed++;
        }
      }

      return { sent, failed };
    }),
});
