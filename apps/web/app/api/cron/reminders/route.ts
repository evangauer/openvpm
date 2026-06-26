import { NextResponse } from "next/server";
import { eq, and, isNull, gte, lte, inArray } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointments,
  patients,
  clients,
  users,
  communications,
} from "@openpims/db";
import { sendAppointmentReminder } from "@/lib/email";
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
        doctorName: users.name,
      })
      .from(appointments)
      .leftJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(clients, eq(appointments.clientId, clients.id))
      .leftJoin(users, eq(appointments.doctorId, users.id))
      .where(
        and(
          isNull(appointments.deletedAt),
          gte(appointments.startTime, now),
          lte(appointments.startTime, in24h),
          inArray(appointments.status, ["scheduled", "confirmed"]),
        ),
      )
      .orderBy(appointments.startTime)
    );

    let sent = 0;
    let failed = 0;

    for (const appt of upcomingAppointments) {
      if (!appt.clientEmail || !appt.clientId) {
        failed++;
        continue;
      }

      try {
        const startDate = new Date(appt.startTime);
        await sendAppointmentReminder({
          to: appt.clientEmail,
          clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
          patientName: appt.patientName ?? "Unknown",
          appointmentDate: startDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          }),
          appointmentTime: startDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          }),
          practiceName: "",
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
          })
        );

        sent++;
      } catch (error) {
        console.error(
          `Failed to send reminder for appointment ${appt.id}:`,
          error,
        );
        failed++;
      }
    }

    console.log(
      `Cron reminders completed: ${sent} sent, ${failed} failed out of ${upcomingAppointments.length} total`,
    );

    if (failed > 0) {
      void alertOps(
        "Appointment reminders had failures",
        `${failed} of ${upcomingAppointments.length} reminders failed to send (${sent} sent).`,
      );
    }

    return NextResponse.json({ sent, failed });
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
