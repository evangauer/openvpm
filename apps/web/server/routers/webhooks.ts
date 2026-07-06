import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { practices, webhooks } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import {
  WEBHOOK_URL_MAX_LENGTH,
  isWebhookDeliveryUrl,
} from "@/lib/webhook-urls";

type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const adminProcedure = protectedProcedure.use(requireRole("admin"));
export const WEBHOOK_EVENT_MAX_COUNT = WEBHOOK_EVENTS.length;

const webhookUrlInput = z
  .string()
  .trim()
  .min(1, "Webhook URL is required.")
  .max(
    WEBHOOK_URL_MAX_LENGTH,
    `Webhook URL must be at most ${WEBHOOK_URL_MAX_LENGTH} characters.`
  )
  .url("Webhook URL must be a valid URL.")
  .refine(
    isWebhookDeliveryUrl,
    "Webhook URL must use the HTTP or HTTPS scheme."
  );

function hasUniqueItems<T>(items: T[]): boolean {
  return new Set(items).size === items.length;
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

async function assertActivePractice(db: Database, practiceId: string) {
  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

export const webhooksRouter = createRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx.db, ctx.practiceId);
    return ctx.db
      .select({
        id: webhooks.id,
        url: webhooks.url,
        events: webhooks.events,
        active: webhooks.active,
        createdAt: webhooks.createdAt,
      })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(webhooks.deletedAt)
        )
      );
  }),

  create: adminProcedure
    .input(
      z.object({
        url: webhookUrlInput,
        events: z
          .array(z.enum(WEBHOOK_EVENTS))
          .min(1)
          .max(
            WEBHOOK_EVENT_MAX_COUNT,
            `Webhooks can subscribe to at most ${WEBHOOK_EVENT_MAX_COUNT} events.`
          )
          .refine(hasUniqueItems, "Webhook events must be unique."),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const secret = randomUUID();

      const [webhook] = await ctx.db
        .insert(webhooks)
        .values({
          practiceId: ctx.practiceId,
          url: input.url,
          events: input.events,
          secret,
          active: true,
        })
        .returning({
          id: webhooks.id,
          url: webhooks.url,
          events: webhooks.events,
          active: webhooks.active,
          createdAt: webhooks.createdAt,
        });

      if (!webhook) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Webhook was not created",
        });
      }

      return {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        createdAt: webhook.createdAt,
        secret, // Shown once at creation time
      };
    }),

  toggle: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Get current state
      const [existing] = await ctx.db
        .select({ active: webhooks.active })
        .from(webhooks)
        .where(
          and(
            eq(webhooks.id, input.id),
            eq(webhooks.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(webhooks.deletedAt)
          )
        );

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      }

      const [updated] = await ctx.db
        .update(webhooks)
        .set({ active: !existing.active })
        .where(
          and(
            eq(webhooks.id, input.id),
            eq(webhooks.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(webhooks.deletedAt)
          )
        )
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      }

      return {
        id: updated.id,
        url: updated.url,
        events: updated.events,
        active: updated.active,
        createdAt: updated.createdAt,
      };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .update(webhooks)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(webhooks.id, input.id),
            eq(webhooks.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(webhooks.deletedAt)
          )
        )
        .returning();

      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      }

      return { success: true as const };
    }),

  events: adminProcedure.query(() => {
    return WEBHOOK_EVENTS.map((event) => ({ event }));
  }),
});
