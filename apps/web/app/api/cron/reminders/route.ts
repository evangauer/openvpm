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
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderSmsIdempotencyKey,
  appointmentReminderDispatchEligible,
  currentAppointmentReminderEmailRecipient,
  claimAppointmentReminderCommunication,
  emailReminderFailureReason,
  recordAppointmentReminderOutcome,
  reminderFailureReason,
  smsReminderFailureReason,
  switchAppointmentReminderClaimToEmail,
} from "@/lib/messaging/appointment-reminder";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";

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
  now: Date;
}): Promise<
  | { status: "claimed"; communicationId: string; attempt: number }
  | { status: "deduped" }
  | { status: "ineligible" }
> {
  return withTenant(db, opts.practiceId, async (tx) => {
    const eligible = await appointmentReminderDispatchEligible(tx, {
      practiceId: opts.practiceId,
      appointmentId: opts.appointmentId,
      clientId: opts.clientId,
      startTime: opts.startTime,
      now: opts.now,
    });
    if (!eligible) return { status: "ineligible" };

    const claim = await claimAppointmentReminderCommunication(tx, {
      practiceId: opts.practiceId,
      appointmentId: opts.appointmentId,
      clientId: opts.clientId,
      channel: opts.channel,
      patientName: opts.patientName,
      startTime: opts.startTime,
      source: "automated",
    });
    return claim
      ? { status: "claimed", communicationId: claim.id, attempt: claim.attempt }
      : { status: "deduped" };
  });
}

async function recordReminderOutcome(opts: {
  practiceId: string;
  communicationId: string;
  channel: ReminderChannel;
  status: "sent" | "failed" | "unknown";
  content: string;
  providerMessageId?: string;
}): Promise<void> {
  await withTenant(db, opts.practiceId, (tx) =>
    recordAppointmentReminderOutcome(tx, {
      practiceId: opts.practiceId,
      communicationId: opts.communicationId,
      channel: opts.channel,
      result: opts.status,
      source: "automated",
      content: opts.content,
      providerMessageId: opts.providerMessageId,
    }),
  );
}

async function currentEmailRecipient(opts: {
  practiceId: string;
  appointmentId: string;
  clientId: string;
  startTime: Date;
}) {
  return withTenant(db, opts.practiceId, (tx) =>
    currentAppointmentReminderEmailRecipient(tx, {
      ...opts,
      now: new Date(),
    }),
  );
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const now = new Date();

    // Cross-tenant sweep across all practices → system context (RLS bypass).
    // Joins the client's contact prefs/consent, the practice (name/phone/tz for
    // the message + quiet hours), and the room's location (for its own number).
    // A clinic must explicitly enable automated reminders; the configured lead
    // time controls the upper edge of its rolling hourly window.
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
          locationId: sql<
            string | null
          >`coalesce(${appointments.locationId}, ${rooms.locationId})`,
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
            eq(practices.appointmentRemindersEnabled, true),
            eq(practices.recoveryHold, false),
            gte(appointments.startTime, now),
            lte(
              appointments.startTime,
              sql`${now.toISOString()}::timestamptz + (${practices.appointmentReminderLeadHours} * interval '1 hour')`,
            ),
            eq(appointments.status, "confirmed"),
          ),
        )
        .orderBy(appointments.startTime),
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0; // SMS-preferred but deferred by quiet hours (no email fallback)
    let deduped = 0;
    let ineligible = 0;
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

      // Email reminder (also the fallback whenever SMS isn't chosen or a send
      // is blocked). Records "sent" itself; on failure it returns the reason so
      // the caller records one outcome with the full story.
      type EmailAttempt =
        | { result: "sent" }
        | { result: "failed" | "unknown"; reason: string };
      let emailAccepted = false;
      const emailReminder = async (
        communicationId: string,
        attempt: number,
      ): Promise<EmailAttempt> => {
        const currentRecipient = await currentEmailRecipient({
          practiceId: appt.practiceId,
          appointmentId: appt.id,
          clientId: appt.clientId!,
          startTime: startDate,
        });
        const clientEmail = normalizeEmailSuppressionAddress(
          currentRecipient?.recipientEmail,
        );
        if (!currentRecipient || !clientEmail) {
          return {
            result: "failed",
            reason:
              "The appointment or the client's email address is no longer eligible for a reminder.",
          };
        }
        if (currentRecipient.suppressionReason) {
          return {
            result: "failed",
            reason: emailSuppressionSendBlockMessage(
              currentRecipient.suppressionReason,
            ),
          };
        }
        const providerResult = await withTenant(
          db,
          appt.practiceId,
          async (tx) => {
            // Hold this shared practice-row lock through the provider request.
            // Restore's hold update therefore drains an already-started email,
            // while a committed hold prevents any later provider request.
            if (
              !(await lockPracticeForExternalSideEffects(
                tx,
                appt.practiceId,
              ))
            ) {
              return { held: true as const };
            }
            try {
              const result = await sendAppointmentReminder({
                to: clientEmail,
                clientName: `${currentRecipient.clientFirstName} ${currentRecipient.clientLastName}`,
                patientName: currentRecipient.patientName ?? "Unknown",
                appointmentDate,
                appointmentTime,
                practiceName: currentRecipient.practiceName,
                idempotencyKey: appointmentReminderEmailIdempotencyKey(
                  appt,
                  attempt,
                ),
              });
              return { held: false as const, result };
            } catch (error) {
              // The provider call may have gone out before the throw.
              console.error(
                `Reminder email for appointment ${appt.id} threw:`,
                error,
              );
              return {
                held: false as const,
                result: {
                  success: false as const,
                  outcome: "outcome_unknown" as const,
                  id: undefined,
                },
              };
            }
          },
        );
        if (providerResult.held) {
          return {
            result: "failed",
            reason:
              "Paused because practice recovery is in progress.",
          };
        }
        const { result } = providerResult;
        if (result.success) {
          // The provider accepted it: a projection error below must never
          // turn a delivered reminder into a retryable failure.
          emailAccepted = true;
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId,
            channel: "email",
            content: `Automated appointment reminder sent for ${appt.patientName} on ${appt.startTime.toISOString()}`,
            status: "sent",
            providerMessageId: result.id,
          });
          return { result: "sent" };
        }
        return {
          result: result.outcome === "outcome_unknown" ? "unknown" : "failed",
          reason: emailReminderFailureReason(result),
        };
      };
      const reminderContent = (
        result: "failed" | "unknown",
        reason: string,
      ) =>
        `Automated appointment reminder ${result === "failed" ? "failed" : "delivery unknown"} for ${appt.patientName} on ${appt.startTime.toISOString()}: ${reason}`;

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
        const claim = await claimReminderCommunication({
          practiceId: appt.practiceId,
          appointmentId: appt.id,
          clientId: appt.clientId,
          channel: initialChannel,
          patientName: appt.patientName,
          startTime: startDate,
          now: new Date(),
        });
        if (claim.status === "ineligible") {
          ineligible++;
          continue;
        }
        if (claim.status === "deduped") {
          deduped++;
          continue;
        }
        const { communicationId, attempt } = claim;
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
                idempotencyKey: appointmentReminderSmsIdempotencyKey(
                  appt,
                  attempt,
                ),
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
            // Keep the communication pending and its dedupe claim intact,
            // marked unknown so it is never retried. A later provider
            // event/operator reconciliation projects the result.
            await recordReminderOutcome({
              practiceId: appt.practiceId,
              communicationId,
              channel: "sms",
              content: reminderContent(
                "unknown",
                smsReminderFailureReason(result),
              ),
              status: "unknown",
            }).catch(() => undefined);
            failed++;
          } else {
            preservePendingSmsOutcome = false;
            const smsReason = smsReminderFailureReason(result);
            if (!normalizeEmailSuppressionAddress(appt.clientEmail)) {
              await recordReminderOutcome({
                practiceId: appt.practiceId,
                communicationId,
                channel: "sms",
                content: reminderContent("failed", smsReason),
                status: "failed",
              });
              failed++;
            } else {
              // SMS blocked (e.g. opted out) — fall back to email.
              claimedChannel = "email";
              await withTenant(db, appt.practiceId, (tx) =>
                switchAppointmentReminderClaimToEmail(tx, {
                  practiceId: appt.practiceId,
                  communicationId,
                }),
              );
              const email = await emailReminder(communicationId, attempt);
              if (email.result === "sent") {
                sent++;
              } else {
                await recordReminderOutcome({
                  practiceId: appt.practiceId,
                  communicationId,
                  channel: "email",
                  content: reminderContent(
                    email.result,
                    `Text message: ${smsReason} Email fallback: ${email.reason}`,
                  ),
                  status: email.result,
                });
                failed++;
              }
            }
          }
        } else if (channel === "email") {
          const email = await emailReminder(communicationId, attempt);
          if (email.result === "sent") {
            sent++;
          } else {
            await recordReminderOutcome({
              practiceId: appt.practiceId,
              communicationId,
              channel: "email",
              content: reminderContent(email.result, email.reason),
              status: email.result,
            });
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
        } else if (claimedCommunicationId && emailAccepted) {
          await alertOps(
            "Accepted reminder email projection failed",
            `practice=${appt.practiceId} communication=${claimedCommunicationId} source=appointment_reminder`,
          ).catch(() => undefined);
        } else if (claimedCommunicationId) {
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            communicationId: claimedCommunicationId,
            channel: claimedChannel,
            content: reminderContent("failed", reminderFailureReason(error)),
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

    const eligible = upcomingAppointments.length - suppressed - ineligible;
    console.log(
      `Cron reminders completed: ${sent} sent, ${failed} failed, ${skipped} deferred (quiet hours), ${deduped} deduped, ${ineligible} no longer eligible, ${suppressed} suppressed (${suppressedDemo} demo, ${suppressedReservedAddress} reserved address) out of ${upcomingAppointments.length} total`,
    );

    if (failed > 0) {
      void alertOps(
        "Appointment reminders had failures",
        `${failed} of ${eligible} eligible reminders failed to send (${sent} sent, ${skipped} deferred, ${deduped} deduped, ${ineligible} no longer eligible, ${suppressed} suppressed).`,
      );
    }

    await reportCronHeartbeat({
      job: "reminders",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${failed} failed, ${skipped} deferred, ${deduped} deduped, ${ineligible} no longer eligible, ${suppressed} suppressed`,
      metrics: {
        total: upcomingAppointments.length,
        eligible,
        sent,
        failed,
        skipped,
        deduped,
        ineligible,
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
