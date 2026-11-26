import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  careReminders,
  clients,
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
import {
  bulkOutreachFiltersSchema,
  CARE_REMINDER_BULK_MAX_BATCH_CEILING,
} from "@/lib/care-reminder-outreach";
import {
  deliverCareReminderOutreach,
  previewBulkCareReminderOutreach,
  sendBulkCareReminderOutreach,
} from "../care-reminder-outreach";
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

const sendBulkOutreachInput = z
  .object({
    filters: bulkOutreachFiltersSchema,
    selectAllMatching: z.boolean().optional(),
    reminderIds: z
      .array(z.string().guid())
      .max(CARE_REMINDER_BULK_MAX_BATCH_CEILING)
      .optional(),
  })
  .superRefine((input, ctx) => {
    const ids = input.reminderIds ?? [];
    if (!input.selectAllMatching && ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reminderIds"],
        message: "Choose at least one care reminder.",
      });
    }
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reminderIds"],
        message: "Choose each reminder at most once.",
      });
    }
  });

function outreachContext(ctx: {
  db: Database;
  practiceId: string;
  user: {
    id: string;
    practiceCreatedAt?: Date | string | null;
    emailVerifiedAt?: Date | string | null;
    practiceInPreview?: boolean;
  };
  ip?: string | null;
}) {
  return {
    db: ctx.db,
    practiceId: ctx.practiceId,
    user: {
      id: ctx.user.id,
      practiceCreatedAt: ctx.user.practiceCreatedAt,
      emailVerifiedAt: ctx.user.emailVerifiedAt,
      practiceInPreview: ctx.user.practiceInPreview,
    },
    ip: ctx.ip,
  };
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
      return deliverCareReminderOutreach(outreachContext(ctx), input);
    }),

  previewBulkOutreach: manageProcedure
    .input(bulkOutreachFiltersSchema)
    .query(async ({ ctx, input }) => {
      const preview = await previewBulkCareReminderOutreach(
        outreachContext(ctx),
        input,
      );
      if (!preview) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Practice not found",
        });
      }
      return preview;
    }),

  sendBulkOutreach: manageProcedure
    .input(sendBulkOutreachInput)
    .mutation(async ({ ctx, input }) => {
      return sendBulkCareReminderOutreach(outreachContext(ctx), input);
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
