import { NextResponse } from "next/server";
import { eq, and, isNull, gte, lte, inArray } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointments,
  patients,
  clients,
  users,
  practices,
  rooms,
  communications,
} from "@openpims/db";
import { sendAppointmentReminder } from "@/lib/email";
import { sendAppointmentReminderSms } from "@/lib/sms";
import { isQuietHours, pickReminderChannel } from "@/lib/messaging/reminders";
import { alertOps } from "@/lib/alerts";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { cronAuthError } from "@/lib/cron-auth";

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Cross-tenant sweep across all practices → system context (RLS bypass).
    // Joins the client's contact prefs/consent, the practice (name/phone/tz for
    // the message + quiet hours), and the room's location (for its own number).
    const upcomingAppointments = await withSystem(db, (tx) =>
      tx
        .select({
          id: appointments.id,
          startTime: appointments.startTime,
          endTime: appointments.endTime,
          practiceId: appointments.practiceId,
          patientName: patients.name,
          clientId: appointments.clientId,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          preferredContactMethod: clients.preferredContactMethod,
          smsConsent: clients.smsConsent,
          doctorName: users.name,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
          locationId: rooms.locationId,
        })
        .from(appointments)
        .leftJoin(patients, eq(appointments.patientId, patients.id))
        .leftJoin(clients, eq(appointments.clientId, clients.id))
        .leftJoin(users, eq(appointments.doctorId, users.id))
        .leftJoin(practices, eq(appointments.practiceId, practices.id))
        .leftJoin(rooms, eq(appointments.roomId, rooms.id))
        .where(
          and(
            isNull(appointments.deletedAt),
            gte(appointments.startTime, now),
            lte(appointments.startTime, in24h),
            inArray(appointments.status, ["scheduled", "confirmed"]),
          ),
        )
        .orderBy(appointments.startTime),
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0; // SMS-preferred but deferred by quiet hours (no email fallback)

    for (const appt of upcomingAppointments) {
      if (!appt.clientId) {
        failed++;
        continue;
      }

      const startDate = new Date(appt.startTime);
      const appointmentDate = startDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const appointmentTime = startDate.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });

      // Email reminder + communications log (the existing path, reused as the
      // fallback whenever SMS isn't chosen or a send is blocked).
      const emailReminder = async (): Promise<boolean> => {
        if (!appt.clientEmail) return false;
        await sendAppointmentReminder({
          to: appt.clientEmail,
          clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
          patientName: appt.patientName ?? "Unknown",
          appointmentDate,
          appointmentTime,
          practiceName: appt.practiceName ?? "",
        });
        await withTenant(db, appt.practiceId, (tx) =>
          tx.insert(communications).values({
            practiceId: appt.practiceId,
            clientId: appt.clientId!,
            channel: "email",
            direction: "outbound",
            subject: "Appointment Reminder",
            content: `Automated appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
            status: "sent",
          }),
        );
        return true;
      };

      try {
        const channel = pickReminderChannel({
          preferredContactMethod: appt.preferredContactMethod,
          phone: appt.clientPhone,
          smsConsent: appt.smsConsent ?? false,
          hasEmail: Boolean(appt.clientEmail),
          quietHours: isQuietHours(now, appt.practiceTimezone),
        });

        if (channel === "sms") {
          const result = await sendAppointmentReminderSms({
            to: appt.clientPhone!,
            patientName: appt.patientName ?? "Unknown",
            appointmentDate,
            appointmentTime,
            practiceName: appt.practiceName ?? "",
            practicePhone: appt.practicePhone ?? undefined,
            practiceId: appt.practiceId,
            locationId: appt.locationId ?? undefined,
          });
          if (result.success) {
            await withTenant(db, appt.practiceId, (tx) =>
              tx.insert(communications).values({
                practiceId: appt.practiceId,
                clientId: appt.clientId!,
                channel: "sms",
                direction: "outbound",
                subject: "Appointment Reminder",
                content: `Automated SMS appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
                status: "sent",
              }),
            );
            sent++;
          } else if (await emailReminder()) {
            // SMS blocked (e.g. opted out) — fall back to email.
            sent++;
          } else {
            failed++;
          }
        } else if (channel === "email") {
          await emailReminder();
          sent++;
        } else if (channel === "skip") {
          skipped++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error(
          `Failed to send reminder for appointment ${appt.id}:`,
          error,
        );
        failed++;
      }
    }

    console.log(
      `Cron reminders completed: ${sent} sent, ${failed} failed, ${skipped} deferred (quiet hours) out of ${upcomingAppointments.length} total`,
    );

    if (failed > 0) {
      void alertOps(
        "Appointment reminders had failures",
        `${failed} of ${upcomingAppointments.length} reminders failed to send (${sent} sent, ${skipped} deferred).`,
      );
    }

    return NextResponse.json({ sent, failed, skipped });
  } catch (error) {
    void alertOps(
      "Reminder cron job crashed",
      error instanceof Error ? error.message : String(error),
    );
    console.error("Cron reminder job failed:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
