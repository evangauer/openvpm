import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  careReminders,
  clients,
  communications,
  emailSuppressions,
  locationMessaging,
  locations,
  patients,
  practices,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import {
  clinicalDateInput,
  clinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import { sendCareReminder } from "@/lib/email";
import { sendCareReminderSms } from "@/lib/sms";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { assertOutboundEmailAllowed } from "@/lib/outbound-email-security";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import { isQuietHours } from "@/lib/messaging/reminders";
import { withDurableSmsCommunication } from "@/lib/messaging/durable-sms-communication";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { createRouter, protectedProcedure, requireRole } from "../trpc";

const manageProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk"),
);
const reminderTitleInput = clinicalTextInput("Reminder title", 255);
const reminderNotesInput = z
  .string()
  .trim()
  .max(4000, "Reminder notes must be at most 4,000 characters.")
  .optional()
  .transform((value) => value || undefined);
const expectedUpdatedAtInput = z.string().datetime();
const careReminderDismisser = alias(users, "care_reminder_dismisser");
const outreachInput = z.object({
  reminderId: z.string().guid(),
  channel: z.enum(["email", "sms"]),
  requestId: z.string().guid(),
});
const dismissalInput = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().guid(),
          expectedUpdatedAt: expectedUpdatedAtInput,
        }),
      )
      .min(1)
      .max(100),
    dismissed: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.dismissed && (!input.reason || input.reason.length < 3)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Explain why these reminders are invalid.",
      });
    }
    if (
      new Set(input.items.map((item) => item.id)).size !== input.items.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Choose each reminder at most once.",
      });
    }
  });

async function activePractice(
  db: Pick<Database, "select">,
  practiceId: string,
) {
  const [practice] = await db
    .select({ id: practices.id, timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
  }
  return practice;
}

function careReminderOutreachDedupeKey(
  practiceId: string,
  channel: "email" | "sms",
  requestId: string,
): string {
  return `${channel}:care-reminder:${practiceId}:${requestId}`;
}

async function activeCareReminderSmsSender(
  db: Pick<Database, "select">,
  practiceId: string,
): Promise<{ locationId: string } | null> {
  const senders = await db
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
        eq(locationMessaging.practiceId, practiceId),
        isNull(locationMessaging.deletedAt),
        eq(locationMessaging.enabled, true),
        eq(locationMessaging.registrationStatus, "active"),
        hasNonBlankMessagingSender(),
      ),
    )
    .limit(2);
  return senders.length === 1 ? senders[0]! : null;
}

export const careRemindersRouter = createRouter({
  list: protectedProcedure
    .input(
      z
        .object({
          status: z
            .enum(["open", "completed", "dismissed", "all"])
            .default("open"),
          due: z.enum(["all", "overdue", "upcoming"]).default("all"),
          patientId: z.string().guid().optional(),
          limit: z.number().int().min(1).max(1000).default(500),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const practice = await activePractice(ctx.db, ctx.practiceId);
      const today = formatDateInputForTimeZone(
        new Date(),
        practice.timezone ?? null,
      );
      const status = input?.status ?? "open";
      const due = input?.due ?? "all";
      const conditions = [
        eq(careReminders.practiceId, ctx.practiceId),
        eq(patients.practiceId, ctx.practiceId),
        eq(clients.practiceId, ctx.practiceId),
        isNull(careReminders.deletedAt),
        isNull(patients.deletedAt),
        isNull(clients.deletedAt),
      ];
      if (status !== "all") conditions.push(eq(careReminders.status, status));
      if (due === "overdue") conditions.push(lte(careReminders.dueDate, today));
      if (due === "upcoming") conditions.push(gt(careReminders.dueDate, today));
      if (input?.patientId) {
        conditions.push(eq(careReminders.patientId, input.patientId));
      }

      const items = await ctx.db
        .select({
          id: careReminders.id,
          patientId: careReminders.patientId,
          patientName: patients.name,
          patientStatus: patients.status,
          clientId: clients.id,
          clientName: sql<string>`${clients.firstName} || ' ' || ${clients.lastName}`,
          clientEmail: clients.email,
          clientPhone: clients.phone,
          clientSmsConsent: clients.smsConsent,
          title: careReminders.title,
          notes: careReminders.notes,
          dueDate: careReminders.dueDate,
          status: careReminders.status,
          imported: sql<boolean>`${careReminders.externalSource} is not null`,
          completedAt: careReminders.completedAt,
          dismissedAt: careReminders.dismissedAt,
          dismissalReason: careReminders.dismissalReason,
          dismissedByName: careReminderDismisser.name,
          createdAt: careReminders.createdAt,
          updatedAt: careReminders.updatedAt,
        })
        .from(careReminders)
        .innerJoin(patients, eq(careReminders.patientId, patients.id))
        .innerJoin(clients, eq(patients.clientId, clients.id))
        .leftJoin(
          careReminderDismisser,
          and(
            eq(careReminders.dismissedBy, careReminderDismisser.id),
            eq(careReminderDismisser.practiceId, ctx.practiceId),
          ),
        )
        .where(and(...conditions))
        .orderBy(
          status === "completed"
            ? desc(careReminders.completedAt)
            : status === "dismissed"
              ? desc(careReminders.dismissedAt)
              : asc(careReminders.dueDate),
          asc(careReminders.id),
        )
        .limit(input?.limit ?? 500);

      const [counts] = await ctx.db
        .select({
          open: sql<number>`count(*) filter (where ${careReminders.status} = 'open')::int`,
          overdue: sql<number>`count(*) filter (where ${careReminders.status} = 'open' and ${careReminders.dueDate} <= ${today})::int`,
          upcoming: sql<number>`count(*) filter (where ${careReminders.status} = 'open' and ${careReminders.dueDate} > ${today})::int`,
          completed: sql<number>`count(*) filter (where ${careReminders.status} = 'completed')::int`,
          dismissed: sql<number>`count(*) filter (where ${careReminders.status} = 'dismissed')::int`,
        })
        .from(careReminders)
        .where(
          and(
            eq(careReminders.practiceId, ctx.practiceId),
            isNull(careReminders.deletedAt),
          ),
        );

      return {
        today,
        counts: counts ?? {
          open: 0,
          overdue: 0,
          upcoming: 0,
          completed: 0,
          dismissed: 0,
        },
        items,
      };
    }),

  create: manageProcedure
    .input(
      z.object({
        patientId: z.string().guid(),
        title: reminderTitleInput,
        notes: reminderNotesInput,
        dueDate: clinicalDateInput("Due date"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await activePractice(ctx.db, ctx.practiceId);
      const [patient] = await ctx.db
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      if (!patient) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found",
        });
      }
      const [reminder] = await ctx.db
        .insert(careReminders)
        .values({
          practiceId: ctx.practiceId,
          patientId: input.patientId,
          title: input.title,
          notes: input.notes ?? null,
          dueDate: input.dueDate,
          createdBy: ctx.user.id,
        })
        .returning();
      return reminder!;
    }),

  sendOutreach: manageProcedure
    .input(outreachInput)
    .mutation(async ({ ctx, input }) => {
      const outcome = await ctx.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        if (!(await lockPracticeForExternalSideEffects(db, ctx.practiceId))) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: RECOVERY_HOLD_BLOCK_MESSAGE,
          });
        }

        const [reminder] = await db
          .select({
            id: careReminders.id,
            title: careReminders.title,
            dueDate: careReminders.dueDate,
            status: careReminders.status,
            patientName: patients.name,
            clientId: clients.id,
            clientFirstName: clients.firstName,
            clientLastName: clients.lastName,
            clientEmail: clients.email,
            clientPhone: clients.phone,
            clientSmsConsent: clients.smsConsent,
            emailSuppressionReason: emailSuppressions.reason,
            practiceName: practices.name,
            practicePhone: practices.phone,
            practiceAddress: practices.address,
            practiceTimezone: practices.timezone,
          })
          .from(careReminders)
          .innerJoin(
            patients,
            and(
              eq(careReminders.patientId, patients.id),
              eq(patients.practiceId, ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .innerJoin(
            clients,
            and(
              eq(patients.clientId, clients.id),
              eq(clients.practiceId, ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .innerJoin(
            practices,
            and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)),
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
              eq(careReminders.id, input.reminderId),
              eq(careReminders.practiceId, ctx.practiceId),
              isNull(careReminders.deletedAt),
            ),
          )
          .limit(1);
        if (!reminder) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Care reminder not found",
          });
        }
        if (reminder.status !== "open") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Only open care reminders can be sent to a client.",
          });
        }

        const clientName =
          [reminder.clientFirstName, reminder.clientLastName]
            .filter(Boolean)
            .join(" ") || "Client";
        const dueDate = formatClinicalDate(
          reminder.dueDate,
          reminder.practiceTimezone,
          reminder.dueDate,
        );
        const subject = `Care Reminder for ${reminder.patientName}`;
        const content = `Hello ${clientName},\n\nThis is a reminder from our veterinary team about ${reminder.patientName}: ${reminder.title}. The reminder date is ${dueDate}. Please contact us if you have questions or would like to schedule.`;
        const dedupeKey = careReminderOutreachDedupeKey(
          ctx.practiceId,
          input.channel,
          input.requestId,
        );

        let email: string | null = null;
        let smsSender: { locationId: string } | null = null;
        if (input.channel === "email") {
          email = normalizeEmailSuppressionAddress(reminder.clientEmail);
          if (!email) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Client does not have an email address on file",
            });
          }
          if (reminder.emailSuppressionReason) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: emailSuppressionSendBlockMessage(
                reminder.emailSuppressionReason,
              ),
            });
          }
          await assertOutboundEmailAllowed({
            practiceId: ctx.practiceId,
            practiceCreatedAt: ctx.user.practiceCreatedAt,
            userId: ctx.user.id,
            userEmailVerifiedAt: ctx.user.emailVerifiedAt,
            ip: ctx.ip,
            operation: "care_reminder",
          });
        } else {
          if (!reminder.clientPhone || !reminder.clientSmsConsent) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Client does not have an SMS-consented phone number on file",
            });
          }
          if (isQuietHours(new Date(), reminder.practiceTimezone)) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "SMS reminders cannot be sent during quiet hours (9 PM–8 AM local time). Try again after 8 AM.",
            });
          }
          smsSender = await activeCareReminderSmsSender(db, ctx.practiceId);
          if (!smsSender) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Set up exactly one active clinic texting number before sending care reminders by SMS",
            });
          }
        }

        const insertCommunication = async (
          db: Pick<Database, "insert" | "select">,
        ) => {
          const [inserted] = await db
            .insert(communications)
            .values({
              practiceId: ctx.practiceId,
              clientId: reminder.clientId,
              channel: input.channel,
              direction: "outbound",
              subject: input.channel === "email" ? subject : null,
              content,
              status: "pending",
              dedupeKey,
            })
            .onConflictDoNothing({ target: communications.dedupeKey })
            .returning();
          if (inserted) return { communication: inserted, replayed: false };

          const [existing] = await db
            .select()
            .from(communications)
            .where(
              and(
                eq(communications.practiceId, ctx.practiceId),
                eq(communications.dedupeKey, dedupeKey),
                eq(communications.clientId, reminder.clientId),
                eq(communications.channel, input.channel),
                eq(communications.direction, "outbound"),
                isNull(communications.deletedAt),
              ),
            )
            .limit(1);
          if (!existing) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Reminder request ID is already in use.",
            });
          }
          if (
            existing.content !== content ||
            (existing.subject ?? null) !==
              (input.channel === "email" ? subject : null)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Reminder request ID was already used for different reminder data.",
            });
          }
          return { communication: existing, replayed: true };
        };

        const durableSms = input.channel === "sms";
        const claim = durableSms
          ? await withDurableSmsCommunication(
              ctx.practiceId,
              insertCommunication,
            )
          : await insertCommunication(db);
        const communication = claim.communication;
        if (
          claim.replayed &&
          new Set(["sent", "delivered", "read"]).has(communication.status)
        ) {
          return { success: true, channel: input.channel, replayed: true };
        }
        if (claim.replayed) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              communication.status === "failed"
                ? "This reminder delivery failed. Start a new send to retry it."
                : "This reminder delivery is already being processed.",
          });
        }

        const result =
          input.channel === "email"
            ? await sendCareReminder({
                to: email!,
                clientName,
                patientName: reminder.patientName,
                reminderTitle: reminder.title,
                dueDate,
                practiceName: reminder.practiceName,
                practicePhone: reminder.practicePhone ?? undefined,
                practiceAddress: reminder.practiceAddress ?? undefined,
                idempotencyKey: dedupeKey,
              })
            : await sendCareReminderSms({
                to: reminder.clientPhone!,
                patientName: reminder.patientName,
                reminderTitle: reminder.title,
                dueDate,
                practiceName: reminder.practiceName,
                practicePhone: reminder.practicePhone ?? undefined,
                practiceId: ctx.practiceId,
                locationId: smsSender!.locationId,
                clientId: reminder.clientId,
                communicationId: communication.id,
                sourceId: reminder.id,
                idempotencyKey: dedupeKey,
              });

        if (
          input.channel === "sms" &&
          !result.success &&
          "outcome" in result &&
          result.outcome === "outcome_unknown"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The texting provider outcome is unknown. Do not resend until support confirms the outcome.",
          });
        }

        const project = (db: Pick<Database, "update">) =>
          db
            .update(communications)
            .set({
              status: result.success ? "sent" : "failed",
              providerMessageId: result.success
                ? "sid" in result
                  ? result.sid
                  : result.id
                : undefined,
            })
            .where(
              and(
                eq(communications.id, communication.id),
                eq(communications.practiceId, ctx.practiceId),
                eq(communications.status, "pending"),
                isNull(communications.deletedAt),
              ),
            );
        if (durableSms) {
          await withDurableSmsCommunication(ctx.practiceId, project);
        } else {
          await project(db);
        }
        if (!result.success) {
          return {
            deliveryError: result.error ?? "Could not send care reminder",
          } as const;
        }
        return { success: true, channel: input.channel, replayed: false };
      });
      if ("deliveryError" in outcome) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: outcome.deliveryError,
        });
      }
      return outcome;
    }),

  setCompleted: manageProcedure
    .input(
      z.object({
        id: z.string().guid(),
        completed: z.boolean(),
        expectedUpdatedAt: expectedUpdatedAtInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await activePractice(tx as unknown as Database, ctx.practiceId);
        const [current] = await tx
          .select({
            id: careReminders.id,
            status: careReminders.status,
            updatedAt: careReminders.updatedAt,
          })
          .from(careReminders)
          .where(
            and(
              eq(careReminders.id, input.id),
              eq(careReminders.practiceId, ctx.practiceId),
              isNull(careReminders.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Care reminder not found",
          });
        }
        const targetStatus = input.completed ? "completed" : "open";
        if (current.status === "dismissed") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Restore this dismissed reminder before completing it.",
          });
        }
        if (current.status === targetStatus) return current;
        if (
          current.updatedAt.getTime() !==
          new Date(input.expectedUpdatedAt).getTime()
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This reminder changed. Refresh before updating it.",
          });
        }
        const now = new Date();
        const [updated] = await tx
          .update(careReminders)
          .set({
            status: targetStatus,
            completedAt: input.completed ? now : null,
            completedBy: input.completed ? ctx.user.id : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(careReminders.id, current.id),
              eq(careReminders.practiceId, ctx.practiceId),
              isNull(careReminders.deletedAt),
            ),
          )
          .returning();
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This reminder changed. Refresh before updating it.",
          });
        }
        return updated;
      });
    }),

  setDismissed: manageProcedure
    .input(dismissalInput)
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        await activePractice(tx as unknown as Database, ctx.practiceId);
        const ids = input.items.map((item) => item.id);
        const expectedById = new Map(
          input.items.map((item) => [
            item.id,
            new Date(item.expectedUpdatedAt).getTime(),
          ]),
        );
        const current = await tx
          .select({
            id: careReminders.id,
            status: careReminders.status,
            updatedAt: careReminders.updatedAt,
          })
          .from(careReminders)
          .where(
            and(
              inArray(careReminders.id, ids),
              eq(careReminders.practiceId, ctx.practiceId),
              isNull(careReminders.deletedAt),
            ),
          )
          .orderBy(asc(careReminders.id))
          .for("update");
        if (
          current.length !== ids.length ||
          current.some(
            (row) =>
              row.updatedAt.getTime() !== expectedById.get(row.id) ||
              row.status !== (input.dismissed ? "open" : "dismissed"),
          )
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "One or more reminders changed. Refresh before updating them.",
          });
        }
        const now = new Date();
        const updated = await tx
          .update(careReminders)
          .set({
            status: input.dismissed ? "dismissed" : "open",
            dismissedAt: input.dismissed ? now : null,
            dismissedBy: input.dismissed ? ctx.user.id : null,
            dismissalReason: input.dismissed ? input.reason! : null,
            completedAt: null,
            completedBy: null,
            updatedAt: now,
          })
          .where(
            and(
              inArray(careReminders.id, ids),
              eq(careReminders.practiceId, ctx.practiceId),
              eq(careReminders.status, input.dismissed ? "open" : "dismissed"),
              isNull(careReminders.deletedAt),
            ),
          )
          .returning({ id: careReminders.id });
        if (updated.length !== ids.length) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "One or more reminders changed. Refresh before updating them.",
          });
        }
        return { id: updated[0]!.id, ids: updated.map((row) => row.id) };
      }),
    ),
});
