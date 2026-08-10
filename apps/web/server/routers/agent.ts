import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  createRouter,
  protectedProcedure,
  requireFeature,
  requireRole,
} from "../trpc";
import { practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  runAgent,
  isAgentConfigured,
  AGENT_TOOL_NAMES,
  AgentNotConfiguredError,
  AgentPracticeNotFoundError,
  AgentRateLimitedError,
} from "@/lib/agent";
import { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";
import { billingEnforced } from "@/lib/billing/plans";

export { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";

// The OpenVPM Agent is a Cloud feature on hosted; unrestricted on self-host.
const agentProcedure = protectedProcedure
  .use(requireRole("admin", "veterinarian"))
  .use(requireFeature("agent"));

type AgentContext = {
  db: Database;
  practiceId: string;
};

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: AgentContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

export const agentRouter = createRouter({
  /** Whether the agent is enabled (API key present) and what it can do. */
  status: protectedProcedure.query(() => ({
    configured: isAgentConfigured(),
    // Hosted users get a friendly "unavailable" message when unconfigured;
    // self-host admins get env-var instructions they can act on.
    hosted: billingEnforced(),
    tools: AGENT_TOOL_NAMES,
  })),

  /** Run the OpenVPM Agent against a natural-language instruction. */
  run: agentProcedure
    .input(
      z.object({
        instruction: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
        // Writes (e.g. booking) are opt-in per run and require an explicit flag.
        allowWrites: z.boolean().default(false),
        // Prior turns (oldest first) for multi-turn chat. Bounded to keep the
        // prompt small; the client sends a trailing window of the conversation.
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
            })
          )
          .max(20)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      try {
        return await runAgent({
          instruction: input.instruction,
          allowWrites: input.allowWrites,
          history: input.history,
          context: {
            db: ctx.db,
            practiceId: ctx.practiceId,
            userId: ctx.user.id,
            postCommitEffect: ctx.postCommitEffect,
          },
        });
      } catch (e) {
        if (e instanceof AgentNotConfiguredError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
          });
        }
        if (e instanceof AgentRateLimitedError) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: e.message });
        }
        if (e instanceof AgentPracticeNotFoundError) {
          throw practiceNotFound();
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e instanceof Error ? e.message : "Agent run failed",
        });
      }
    }),
});
