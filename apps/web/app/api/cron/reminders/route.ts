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
  type AppointmentReminderClaim,
  appointmentReminderDedupeKey,
  appointmentReminderEmailFields,
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderMessageFields,
  appointmentReminderResultForClaim,
  appointmentReminderSmsIdempotencyKey,
  appointmentReminderDispatchEligible,
  currentAppointmentReminderEmailRecipient,
  claimAppointmentReminderCommunication,
  emailReminderFailureReason,
  recordAppointmentReminderOutcome,
  sendClaimedAppointmentReminderEmail,
  reminderFailureReason,
  smsReminderFailureReason,
  switchAppointmentReminderClaimToEmail,
} from "@/lib/messaging/appointment-reminder";

type ReminderChannel = "sms" | "email";

async function claimReminderCommunication(opts: {
  practiceId: string;
  appointmentId: string;
  clientId: string;
  channel: ReminderChannel;
  patientName: string | null;
  startTime: Date;
  now: Date;
}): Promise<
  | { status: "claimed"; claim: AppointmentReminderClaim }
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
    return claim ? { status: "claimed", claim } : { status: "deduped" };
  });
}

async function recordReminderOutcome(opts: {
  practiceId: string;
  claim: AppointmentReminderClaim;
  channel: ReminderChannel;
  status: "sent" | "failed" | "unknown";
  content: string;
  providerMessageId?: string;
}): Promise<void> {
  await withTenant(db, opts.practiceId, (tx) =>
    recordAppointmentReminderOutcome(tx, {
      practiceId: opts.practiceId,
      claim: opts.claim,
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
            // A preview clinic has no card-backed trial yet: nothing leaves
            // the app until it starts one.
            sql`not (
              ${practices.previewEndsAt} is not null
              and ${practices.billingStatus} = 'none'
              and ${practices.trialEndsAt} is null
              and ${practices.stripeSubscriptionId} is null
            )`,
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

      // Email reminder (also the fallback whenever SMS isn't chosen or a send
      // is blocked). Records "sent" itself; on failure it returns the reason so
      // the caller records one outcome with the full story.
      type EmailAttempt =
        | { result: "sent" }
        | { result: "superseded" }
        | { result: "failed" | "unknown"; reason: string };
      let emailAccepted = false;
      let emailProviderCalled = false;
      const emailReminder = async (
        claim: AppointmentReminderClaim,
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
        // Fenced by the claim, and holding the practice's shared recovery
        // lock through the provider request: restore's hold update drains an
        // already-started email, and a committed hold blocks any later one.
        const providerResult = await sendClaimedAppointmentReminderEmail(
          (fn) => withTenant(db, appt.practiceId, fn),
          { practiceId: appt.practiceId, claim, holdForRecovery: true },
          () =>
            sendAppointmentReminder({
              to: clientEmail,
              ...appointmentReminderEmailFields({
                startTime: startDate,
                timeZone: appt.practiceTimezone,
                clientFirstName: currentRecipient.clientFirstName,
                clientLastName: currentRecipient.clientLastName,
                patientName: currentRecipient.patientName,
                practiceName: currentRecipient.practiceName,
                practicePhone: currentRecipient.practicePhone,
              }),
              idempotencyKey: appointmentReminderEmailIdempotencyKey(
                appt,
                claim.attempt,
              ),
            }),
        );
        if (providerResult.status === "superseded") {
          return { result: "superseded" };
        }
        if (providerResult.status === "held") {
          return {
            result: "failed",
            reason:
              "Paused because practice recovery is in progress.",
          };
        }
        emailProviderCalled = true;
        const { result } = providerResult;
        if (result.success) {
          // The provider accepted it: a projection error below must never
          // turn a delivered reminder into a retryable failure.
          emailAccepted = true;
          await recordReminderOutcome({
            practiceId: appt.practiceId,
            claim,
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
      // Record a reminder that did not go out. On a redispatch a failure is
      // recorded as "Delivery unknown" (see AppointmentReminderClaim).
      const recordUnsent = (
        claim: AppointmentReminderClaim,
        channel: ReminderChannel,
        status: "failed" | "unknown",
        reason: string,
      ) => {
        const result = appointmentReminderResultForClaim(claim, status);
        return recordReminderOutcome({
          practiceId: appt.practiceId,
          claim,
          channel,
          content: `Automated appointment reminder ${result === "failed" ? "failed" : "delivery unknown"} for ${appt.patientName} on ${appt.startTime.toISOString()}: ${reason}`,
          status: result,
        });
      };

      let activeClaim: AppointmentReminderClaim | null = null;
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
        const reminderClaim = claim.claim;
        activeClaim = reminderClaim;
        // A reclaimed pending email (for example an interrupted SMS-to-email
        // fallback) is resent by email under its own key, never as a text.
        const sendChannel: ReminderChannel = reminderClaim.channel;
        claimedChannel = sendChannel;
        const message = appointmentReminderMessageFields({
          startTime: startDate,
          timeZone: appt.practiceTimezone,
          patientName: appt.patientName,
          practiceName: appt.practiceName,
          practicePhone: appt.practicePhone,
        });

        if (sendChannel === "sms") {
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
                ...message,
                practiceId: appt.practiceId,
                locationId: senderLocationId,
                clientId: appt.clientId,
                communicationId: reminderClaim.id,
                source: "appointment_reminder",
                sourceId: dedupeKey,
                idempotencyKey: appointmentReminderSmsIdempotencyKey(
                  appt,
                  reminderClaim.attempt,
                ),
                reminderClaimToken: reminderClaim.claimToken,
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
              claim: reminderClaim,
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
            await recordUnsent(
              reminderClaim,
              "sms",
              "unknown",
              smsReminderFailureReason(result),
            ).catch(() => undefined);
            failed++;
          } else {
            preservePendingSmsOutcome = false;
            const smsReason = smsReminderFailureReason(result);
            if (!normalizeEmailSuppressionAddress(appt.clientEmail)) {
              await recordUnsent(reminderClaim, "sms", "failed", smsReason);
              failed++;
            } else {
              // SMS blocked (e.g. opted out) — fall back to email, unless
              // another send has taken this reminder over.
              claimedChannel = "email";
              const switched = await withTenant(db, appt.practiceId, (tx) =>
                switchAppointmentReminderClaimToEmail(tx, {
                  practiceId: appt.practiceId,
                  claim: reminderClaim,
                }),
              );
              const email: EmailAttempt = switched
                ? await emailReminder(reminderClaim)
                : { result: "superseded" };
              if (email.result === "sent") {
                sent++;
              } else if (email.result === "superseded") {
                deduped++;
              } else {
                await recordUnsent(
                  reminderClaim,
                  "email",
                  email.result,
                  `Text message: ${smsReason} Email fallback: ${email.reason}`,
                );
                failed++;
              }
            }
          }
        } else {
          const email = await emailReminder(reminderClaim);
          if (email.result === "sent") {
            sent++;
          } else if (email.result === "superseded") {
            deduped++;
          } else {
            await recordUnsent(
              reminderClaim,
              "email",
              email.result,
              email.reason,
            );
            failed++;
          }
        }
      } catch (error) {
        if (activeClaim && preservePendingSmsOutcome) {
          await alertOps(
            "Accepted or ambiguous SMS reminder projection failed",
            `practice=${appt.practiceId} communication=${activeClaim.id} attempt=${smsAttemptId ?? "unknown"} source=appointment_reminder`,
          ).catch(() => undefined);
        } else if (activeClaim && emailAccepted) {
          await alertOps(
            "Accepted reminder email projection failed",
            `practice=${appt.practiceId} communication=${activeClaim.id} source=appointment_reminder`,
          ).catch(() => undefined);
        } else if (activeClaim) {
          // Once the email provider has been called, an error is never proof
          // that the email did not go out.
          await recordUnsent(
            activeClaim,
            claimedChannel,
            emailProviderCalled ? "unknown" : "failed",
            reminderFailureReason(error),
          ).catch(() => undefined);
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
