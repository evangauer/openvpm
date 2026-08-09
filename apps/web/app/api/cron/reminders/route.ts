import { NextResponse } from "next/server";
import { eq, and, isNull, gte, lte, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointments,
  patients,
  clients,
  users,
  practices,
  rooms,
  communications,
  locationMessaging,
  locations,
  emailSuppressions,
} from "@openpims/db";
import { sendAppointmentReminder } from "@/lib/email";
import { sendAppointmentReminderSms } from "@/lib/sms";
import { isQuietHours, pickReminderChannel } from "@/lib/messaging/reminders";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import { alertOps } from "@/lib/alerts";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { automatedAppointmentReminderSuppressionReason } from "@/lib/automated-reminder-policy";

type ReminderChannel = "sms" | "email";
const REMINDER_PENDING_RECLAIM_MS = 30 * 60 * 1000;

function formatAppointmentReminderDateTime(
  startTime: Date,
  timeZone?: string | null
): { appointmentDate: string; appointmentTime: string } {
  const normalizedTimeZone = timeZone?.trim();
  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };

  if (normalizedTimeZone) {
    try {
      return {
        appointmentDate: startTime.toLocaleDateString("en-US", {
          ...dateOptions,
          timeZone: normalizedTimeZone,
        }),
        appointmentTime: startTime.toLocaleTimeString("en-US", {
          ...timeOptions,
          timeZone: normalizedTimeZone,
        }),
      };
    } catch {
      // Fall back to the runtime locale if a saved timezone is invalid.
    }
  }

  return {
    appointmentDate: startTime.toLocaleDateString("en-US", dateOptions),
    appointmentTime: startTime.toLocaleTimeString("en-US", timeOptions),
  };
}

function appointmentReminderDedupeKey(appt: {
  id: string;
  startTime: Date | string;
}): string {
  return `reminder:appointment:${appt.id}:${new Date(appt.startTime).toISOString()}`;
}

async function claimReminderCommunication(opts: {
  practiceId: string;
  clientId: string;
  channel: ReminderChannel;
  patientName: string | null;
  startTime: Date;
  dedupeKey: string;
}): Promise<string | null> {
  const claimed = await insertReminderCommunicationClaim(opts);
  if (claimed) return claimed;

  const [existing] = await withTenant(db, opts.practiceId, (tx) =>
    tx
      .select({
        id: communications.id,
        status: communications.status,
        createdAt: communications.createdAt,
      })
      .from(communications)
      .where(
        and(
          eq(communications.practiceId, opts.practiceId),
          eq(communications.dedupeKey, opts.dedupeKey),
          isNull(communications.deletedAt)
        )
      )
      .limit(1)
  );

  if (!existing) return null;
  if (existing.status !== "failed" && existing.status !== "pending") {
    return null;
  }

  const staleBefore = new Date(Date.now() - REMINDER_PENDING_RECLAIM_MS);
  const canReclaim =
    existing.status === "failed" ||
    new Date(existing.createdAt).getTime() <= staleBefore.getTime();
  if (!canReclaim) return null;

  const [deleted] = await withTenant(db, opts.practiceId, (tx) =>
    tx
      .delete(communications)
      .where(
        and(
          eq(communications.practiceId, opts.practiceId),
          eq(communications.dedupeKey, opts.dedupeKey),
          existing.status === "failed"
            ? eq(communications.status, "failed")
            : and(
                eq(communications.status, "pending"),
                lte(communications.createdAt, staleBefore)
              ),
          isNull(communications.deletedAt)
        )
      )
      .returning({ id: communications.id })
  );
  if (!deleted) return null;

  return insertReminderCommunicationClaim(opts);
}

async function insertReminderCommunicationClaim(opts: {
  practiceId: string;
  clientId: string;
  channel: ReminderChannel;
  patientName: string | null;
  startTime: Date;
  dedupeKey: string;
}): Promise<string | null> {
  const [row] = await withTenant(db, opts.practiceId, (tx) =>
    tx
      .insert(communications)
      .values({
        practiceId: opts.practiceId,
        clientId: opts.clientId,
        channel: opts.channel,
        direction: "outbound",
        subject: "Appointment Reminder",
        content: `Automated appointment reminder pending for ${opts.patientName ?? "Unknown"} on ${opts.startTime.toISOString()}`,
        status: "pending",
        dedupeKey: opts.dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning({ id: communications.id })
  );
  return row?.id ?? null;
}

async function recordReminderOutcome(opts: {
  practiceId: string;
  communicationId: string;
  channel: ReminderChannel;
  status: "sent" | "failed";
  content: string;
  providerMessageId?: string;
}): Promise<void> {
  await withTenant(db, opts.practiceId, (tx) =>
    tx
      .update(communications)
      .set({
        channel: opts.channel,
        status: opts.status,
        content: opts.content,
        providerMessageId: opts.providerMessageId,
      })
      .where(eq(communications.id, opts.communicationId))
  );
}

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
          emailSuppressionReason: emailSuppressions.reason,
          doctorName: users.name,
          practiceName: practices.name,
          practicePhone: practices.phone,
          practiceTimezone: practices.timezone,
          locationId: rooms.locationId,
          isSeededDemoClient: sql<boolean>`
            coalesce(${practices.settings} -> 'demoData' -> 'clientIds', '[]'::jsonb)
              @> to_jsonb(${appointments.clientId}::text)
          `,
          isSeededDemoAppointment: sql<boolean>`
            coalesce(${practices.settings} -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
              @> to_jsonb(${appointments.id}::text)
          `,
        })
        .from(appointments)
        .leftJoin(
          patients,
          and(
            eq(appointments.patientId, patients.id),
            eq(patients.clientId, appointments.clientId),
            eq(patients.practiceId, appointments.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, appointments.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, appointments.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt)
          )
        )
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, appointments.practiceId),
            isNull(users.deletedAt)
          )
        )
        .innerJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            isNull(practices.deletedAt)
          )
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, appointments.practiceId),
            isNull(rooms.deletedAt)
          )
        )
        .where(
          and(
            isNull(appointments.deletedAt),
            eq(patients.practiceId, appointments.practiceId),
            isNull(patients.deletedAt),
            eq(clients.practiceId, appointments.practiceId),
            isNull(clients.deletedAt),
            gte(appointments.startTime, now),
            lte(appointments.startTime, in24h),
            eq(appointments.status, "confirmed")
          )
        )
        .orderBy(appointments.startTime)
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0; // SMS-preferred but deferred by quiet hours (no email fallback)
    let deduped = 0;
    let suppressed = 0; // Seeded demo rows or reserved fixture addresses.
    let suppressedDemo = 0;
    let suppressedReservedAddress = 0;
    const senderLocationCache = new Map<string, string | null>();

    const activeSenderLocation = async (
      practiceId: string,
      preferredLocationId?: string
    ): Promise<string | null> => {
      const cacheKey = `${practiceId}:${preferredLocationId ?? "*"}`;
      if (senderLocationCache.has(cacheKey)) {
        return senderLocationCache.get(cacheKey) ?? null;
      }

      const findSender = async (locationId: string): Promise<string | null> => {
        const senders = await withSystem(db, (tx) =>
          tx
            .select({ locationId: locationMessaging.locationId })
            .from(locationMessaging)
            .innerJoin(
              locations,
              and(
                eq(locations.id, locationMessaging.locationId),
                eq(locations.practiceId, practiceId),
                isNull(locations.deletedAt)
              )
            )
            .where(
              and(
                eq(locationMessaging.locationId, locationId),
                eq(locationMessaging.practiceId, practiceId),
                isNull(locationMessaging.deletedAt),
                eq(locations.practiceId, practiceId),
                isNull(locations.deletedAt),
                eq(locationMessaging.enabled, true),
                eq(locationMessaging.registrationStatus, "active"),
                hasNonBlankMessagingSender()
              )
            )
            .limit(2)
        );
        return senders.length === 1 ? senders[0]!.locationId : null;
      };

      // Appointment reminders are tied to the appointment room's exact clinic
      // location. Missing/ambiguous location data must never choose a random
      // practice sender.
      const locationId = preferredLocationId
        ? await findSender(preferredLocationId)
        : null;
      senderLocationCache.set(cacheKey, locationId);
      return locationId;
    };

    for (const appt of upcomingAppointments) {
      const suppressionReason =
        automatedAppointmentReminderSuppressionReason(appt);
      if (suppressionReason) {
        suppressed++;
        if (suppressionReason === "seeded_demo_data") {
          suppressedDemo++;
        } else {
          suppressedReservedAddress++;
        }
        continue;
      }

      if (!appt.clientId) {
        failed++;
        continue;
      }

      const startDate = new Date(appt.startTime);
      const { appointmentDate, appointmentTime } =
        formatAppointmentReminderDateTime(startDate, appt.practiceTimezone);

      // Email reminder + communications log (the existing path, reused as the
      // fallback whenever SMS isn't chosen or a send is blocked).
      const emailReminder = async (
        communicationId: string
      ): Promise<boolean> => {
        const clientEmail = normalizeEmailSuppressionAddress(appt.clientEmail);
        if (!clientEmail) return false;
        if (appt.emailSuppressionReason) {
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId,
            channel: "email",
            content: `Automated appointment reminder blocked for ${appt.patientName} on ${appt.startTime.toISOString()}: ${emailSuppressionSendBlockMessage(
              appt.emailSuppressionReason
            )}`,
            status: "failed",
          });
          return false;
        }
        let success = false;
        let providerMessageId: string | undefined;
        try {
          const result = await sendAppointmentReminder({
            to: clientEmail,
            clientName: `${appt.clientFirstName} ${appt.clientLastName}`,
            patientName: appt.patientName ?? "Unknown",
            appointmentDate,
            appointmentTime,
            practiceName: appt.practiceName ?? "",
          });
          success = result.success;
          providerMessageId = result.id;
        } catch {
          success = false;
        }
        if (success) {
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId,
            channel: "email",
            content: `Automated appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
            status: "sent",
            providerMessageId,
          });
          return true;
        }

        await recordReminderOutcome({
          practiceId: appt.practiceId,
          communicationId,
          channel: "email",
          content: `Automated appointment reminder failed for ${appt.patientName} on ${appt.startTime.toISOString()}`,
          status: "failed",
        });
        return false;
      };

      let claimedCommunicationId: string | null = null;
      let claimedChannel: ReminderChannel = "email";
      try {
        const channel = pickReminderChannel({
          preferredContactMethod: appt.preferredContactMethod,
          phone: appt.clientPhone,
          smsConsent: appt.smsConsent ?? false,
          hasEmail: Boolean(normalizeEmailSuppressionAddress(appt.clientEmail)),
          quietHours: isQuietHours(now, appt.practiceTimezone),
          // This sweep runs hourly, so preserve an SMS preference and retry
          // after quiet hours instead of silently changing the channel.
          deferQuietHoursSms: true,
        });

        if (channel === "skip") {
          skipped++;
          continue;
        }

        if (channel === "none") {
          failed++;
          continue;
        }

        const dedupeKey = appointmentReminderDedupeKey(appt);
        const initialChannel: ReminderChannel =
          channel === "sms" ? "sms" : "email";
        claimedChannel = initialChannel;
        const communicationId = await claimReminderCommunication({
          practiceId: appt.practiceId,
          clientId: appt.clientId,
          channel: initialChannel,
          patientName: appt.patientName,
          startTime: startDate,
          dedupeKey,
        });
        if (!communicationId) {
          deduped++;
          continue;
        }
        claimedCommunicationId = communicationId;

        if (channel === "sms") {
          const senderLocationId = await activeSenderLocation(
            appt.practiceId,
            appt.locationId ?? undefined
          );
          const result = senderLocationId
            ? await sendAppointmentReminderSms({
                to: appt.clientPhone!,
                patientName: appt.patientName ?? "Unknown",
                appointmentDate,
                appointmentTime,
                practiceName: appt.practiceName ?? "",
                practicePhone: appt.practicePhone ?? undefined,
                practiceId: appt.practiceId,
                locationId: senderLocationId,
                clientId: appt.clientId,
              })
            : {
                success: false,
                error:
                  "Set up an active texting number before sending SMS reminders",
              };
          if (result.success) {
            await recordReminderOutcome({
              practiceId: appt.practiceId,
              communicationId,
              channel: "sms",
              content: `Automated SMS appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
              status: "sent",
              providerMessageId: result.sid,
            });
            sent++;
          } else if (await emailReminder(communicationId)) {
            // SMS blocked (e.g. opted out) — fall back to email.
            sent++;
          } else {
            await recordReminderOutcome({
              practiceId: appt.practiceId,
              communicationId,
              channel: "sms",
              content: `Automated SMS appointment reminder failed for ${appt.patientName} on ${appt.startTime.toISOString()}: ${result.error ?? "unknown error"}`,
              status: "failed",
            });
            failed++;
          }
        } else if (channel === "email") {
          if (await emailReminder(communicationId)) {
            sent++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      } catch (error) {
        if (claimedCommunicationId) {
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId: claimedCommunicationId,
            channel: claimedChannel,
            content: `Automated appointment reminder failed for ${appt.patientName} on ${appt.startTime.toISOString()}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
            status: "failed",
          }).catch(() => undefined);
        }
        console.error(
          `Failed to send reminder for appointment ${appt.id}:`,
          error
        );
        failed++;
      }
    }

    const eligible = upcomingAppointments.length - suppressed;
    console.log(
      `Cron reminders completed: ${sent} sent, ${failed} failed, ${skipped} deferred (quiet hours), ${deduped} deduped, ${suppressed} suppressed (${suppressedDemo} demo, ${suppressedReservedAddress} reserved address) out of ${upcomingAppointments.length} total`
    );

    if (failed > 0) {
      void alertOps(
        "Appointment reminders had failures",
        `${failed} of ${eligible} eligible reminders failed to send (${sent} sent, ${skipped} deferred, ${deduped} deduped, ${suppressed} suppressed).`
      );
    }

    await reportCronHeartbeat({
      job: "reminders",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${failed} failed, ${skipped} deferred, ${deduped} deduped, ${suppressed} suppressed`,
      metrics: {
        total: upcomingAppointments.length,
        eligible,
        sent,
        failed,
        skipped,
        deduped,
        suppressed,
        suppressedDemo,
        suppressedReservedAddress,
      },
    });

    return NextResponse.json({ sent, failed, skipped, deduped, suppressed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Reminder cron job crashed", message);
    console.error("Cron reminder job failed:", error);
    await reportCronHeartbeat({
      job: "reminders",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
