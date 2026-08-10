import { NextResponse } from "next/server";
import { eq, and, isNull, gte, lte, or, sql } from "drizzle-orm";
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
import {
  appointmentReminderDedupeKey,
  appointmentReminderSmsIdempotencyKey,
  claimAppointmentReminderCommunication,
} from "@/lib/messaging/appointment-reminder";

type ReminderChannel = "sms" | "email";

function formatAppointmentReminderDateTime(
  startTime: Date,
  timeZone?: string | null,
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

async function claimReminderCommunication(opts: {
  practiceId: string;
  appointmentId: string;
  clientId: string;
  channel: ReminderChannel;
  patientName: string | null;
  startTime: Date;
  dedupeKey: string;
}): Promise<string | null> {
  return withTenant(db, opts.practiceId, (tx) =>
    claimAppointmentReminderCommunication(tx, {
      practiceId: opts.practiceId,
      appointmentId: opts.appointmentId,
      clientId: opts.clientId,
      channel: opts.channel,
      patientName: opts.patientName,
      startTime: opts.startTime,
    }),
  );
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
      .where(
        and(
          eq(communications.id, opts.communicationId),
          eq(communications.practiceId, opts.practiceId),
          or(
            eq(communications.status, "pending"),
            and(
              eq(communications.status, "sent"),
              opts.providerMessageId
                ? eq(communications.providerMessageId, opts.providerMessageId)
                : undefined,
            ),
          ),
          isNull(communications.deletedAt),
        ),
      ),
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
          locationId: sql<string | null>`coalesce(${appointments.locationId}, ${rooms.locationId})`,
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
            isNull(patients.deletedAt),
          ),
        )
        .leftJoin(
          clients,
          and(
            eq(appointments.clientId, clients.id),
            eq(clients.practiceId, appointments.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .leftJoin(
          emailSuppressions,
          and(
            eq(emailSuppressions.practiceId, appointments.practiceId),
            sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
            isNull(emailSuppressions.deletedAt),
          ),
        )
        .leftJoin(
          users,
          and(
            eq(appointments.doctorId, users.id),
            eq(users.practiceId, appointments.practiceId),
            isNull(users.deletedAt),
          ),
        )
        .innerJoin(
          practices,
          and(
            eq(appointments.practiceId, practices.id),
            isNull(practices.deletedAt),
          ),
        )
        .leftJoin(
          rooms,
          and(
            eq(appointments.roomId, rooms.id),
            eq(rooms.practiceId, appointments.practiceId),
            isNull(rooms.deletedAt),
          ),
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
            eq(appointments.status, "confirmed"),
          ),
        )
        .orderBy(appointments.startTime),
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
      preferredLocationId?: string,
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
                isNull(locations.deletedAt),
              ),
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
                hasNonBlankMessagingSender(),
              ),
            )
            .limit(2),
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
        communicationId: string,
      ): Promise<boolean> => {
        const clientEmail = normalizeEmailSuppressionAddress(appt.clientEmail);
        if (!clientEmail) return false;
        if (appt.emailSuppressionReason) {
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId,
            channel: "email",
            content: `Automated appointment reminder blocked for ${appt.patientName} on ${appt.startTime.toISOString()}: ${emailSuppressionSendBlockMessage(
              appt.emailSuppressionReason,
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
      let preservePendingSmsOutcome = false;
      let smsAttemptId: string | undefined;
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
          appointmentId: appt.id,
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
            appt.locationId ?? undefined,
          );
          let result:
            | Awaited<ReturnType<typeof sendAppointmentReminderSms>>
            | {
                success: false;
                outcome: "definite_failure" | "outcome_unknown";
                replayed: false;
                error: string;
              };
          if (senderLocationId) {
            preservePendingSmsOutcome = true;
            try {
              result = await sendAppointmentReminderSms({
                to: appt.clientPhone!,
                patientName: appt.patientName ?? "Unknown",
                appointmentDate,
                appointmentTime,
                practiceName: appt.practiceName ?? "",
                practicePhone: appt.practicePhone ?? undefined,
                practiceId: appt.practiceId,
                locationId: senderLocationId,
                clientId: appt.clientId,
                communicationId,
                source: "appointment_reminder",
                sourceId: dedupeKey,
                idempotencyKey: appointmentReminderSmsIdempotencyKey(appt),
              });
              smsAttemptId = result.attemptId;
            } catch (error) {
              result = {
                success: false,
                outcome: "outcome_unknown",
                replayed: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "SMS dispatch ended without a known outcome",
              };
            }
          } else {
            result = {
              success: false,
              outcome: "definite_failure",
              replayed: false,
              error:
                "Set up an active texting number before sending SMS reminders",
            };
          }
          if (result.success) {
            await recordReminderOutcome({
              practiceId: appt.practiceId,
              communicationId,
              channel: "sms",
              content: `Automated SMS appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
              status: "sent",
              providerMessageId: result.sid,
            });
            preservePendingSmsOutcome = false;
            sent++;
          } else if (result.outcome === "outcome_unknown") {
            // Keep the communication pending and its dedupe claim intact. A
            // later provider event/operator reconciliation projects the result.
            failed++;
          } else {
            preservePendingSmsOutcome = false;
            if (await emailReminder(communicationId)) {
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
        if (claimedCommunicationId && preservePendingSmsOutcome) {
          await alertOps(
            "Accepted or ambiguous SMS reminder projection failed",
            `practice=${appt.practiceId} communication=${claimedCommunicationId} attempt=${smsAttemptId ?? "unknown"} source=appointment_reminder`,
          ).catch(() => undefined);
        } else if (claimedCommunicationId) {
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
          error,
        );
        failed++;
      }
    }

    const eligible = upcomingAppointments.length - suppressed;
    console.log(
      `Cron reminders completed: ${sent} sent, ${failed} failed, ${skipped} deferred (quiet hours), ${deduped} deduped, ${suppressed} suppressed (${suppressedDemo} demo, ${suppressedReservedAddress} reserved address) out of ${upcomingAppointments.length} total`,
    );

    if (failed > 0) {
      void alertOps(
        "Appointment reminders had failures",
        `${failed} of ${eligible} eligible reminders failed to send (${sent} sent, ${skipped} deferred, ${deduped} deduped, ${suppressed} suppressed).`,
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
      { status: 500 },
    );
  }
}
