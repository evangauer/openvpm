import { z } from "zod";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { apiKeys, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  generateApiKey,
  API_SCOPES,
  apiScopesHaveValidDependencies,
} from "@/lib/api-auth";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

export const API_KEY_SCOPE_MAX_COUNT = API_SCOPES.length;

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

export const apiKeysRouter = createRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx.db, ctx.practiceId);
    return ctx.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(apiKeys.deletedAt)
        )
      )
      .orderBy(desc(apiKeys.createdAt));
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(128),
        scopes: z
          .array(z.enum(API_SCOPES))
          .min(1)
          .max(
            API_KEY_SCOPE_MAX_COUNT,
            `API keys can include at most ${API_KEY_SCOPE_MAX_COUNT} scopes.`
          )
          .refine(hasUniqueItems, "API key scopes must be unique.")
          .refine(
            apiScopesHaveValidDependencies,
            "agent:write requires agent:run or *."
          ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const { raw, prefix, hash } = await generateApiKey();

      const [created] = await ctx.db
        .insert(apiKeys)
        .values({
          practiceId: ctx.practiceId,
          name: input.name,
          scopes: input.scopes,
          keyPrefix: prefix,
          keyHash: hash,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          scopes: apiKeys.scopes,
          createdAt: apiKeys.createdAt,
        });

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "API key was not created",
        });
      }

      // The raw key is returned exactly once and never persisted in plaintext.
      return {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        scopes: created.scopes,
        createdAt: created.createdAt,
        key: raw,
      };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [revoked] = await ctx.db
        .update(apiKeys)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, input.id),
            eq(apiKeys.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(apiKeys.deletedAt)
          )
        )
        .returning({ id: apiKeys.id });

      if (!revoked) {
        throw new TRPCError({ code: "NOT_FOUND", message: "API key not found" });
      }
      return { success: true as const };
    }),
});
