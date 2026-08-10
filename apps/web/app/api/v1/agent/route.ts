import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { authenticateApiKey, hasScope } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import {
  withErrorHandling,
  apiError,
  validationError,
} from "@/lib/compat/shared/errors";
import {
  AgentNotConfiguredError,
  AgentPracticeNotFoundError,
  AgentRateLimitedError,
  runAgent,
} from "@/lib/agent";
import { AGENT_INSTRUCTION_MAX_LENGTH } from "@/lib/agent/policy";
import { readJsonRequestBody } from "@/lib/request-json";
import { assertActivePractice } from "@/lib/compat/shared/active-practice";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  instruction: z.string().trim().min(1).max(AGENT_INSTRUCTION_MAX_LENGTH),
  allow_writes: z.boolean().optional().default(false),
});

function agentRateLimitHeaders(error: AgentRateLimitedError): HeadersInit {
  return {
    "Retry-After": String(error.retryAfterSeconds),
    "X-RateLimit-Limit": String(error.limit),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": error.resetAt.toISOString(),
  };
}

// POST /api/v1/agent — run the OpenVPM Agent over the API, scoped to the key's
// practice. This is what lets external automations (and an agent-led ops layer)
// drive the practice through one natural-language endpoint.
export async function POST(req: Request) {
  const auth = await authenticateApiKey(req, "agent:run");
  if (!auth.ok) return auth.response;

  return withErrorHandling(async () => {
    const body = await readJsonRequestBody(req);
    if (!body.ok) {
      if (body.reason === "too_large") {
        return apiError("Request body too large", 413);
      }
      return apiError("Request body must be valid JSON", 400);
    }

    const parsed = BodySchema.safeParse(body.data);
    if (!parsed.success) return validationError(parsed.error);

    if (parsed.data.allow_writes && !hasScope(auth.ctx.scopes, "agent:write")) {
      return apiError("API key missing required scope: agent:write", 403);
    }

    try {
      const postCommitEffects: Array<
        (rootDb: typeof db) => Promise<void>
      > = [];
      const result = await withTenant(db, auth.ctx.practiceId, async (tx) => {
        const activePractice = await assertActivePractice(
          tx,
          auth.ctx.practiceId
        );
        if (!activePractice.ok) return activePractice.response;

        return runAgent({
          instruction: parsed.data.instruction,
          allowWrites: parsed.data.allow_writes,
          apiKeyScopes: auth.ctx.scopes,
          context: {
            db: tx,
            practiceId: auth.ctx.practiceId,
            // No human user on an API call; identify the actor by key.
            userId: `apikey:${auth.ctx.apiKeyId}`,
            postCommitEffect: (effect) => postCommitEffects.push(effect),
          },
        });
      });
      if (result instanceof NextResponse) return result;
      for (const effect of postCommitEffects) {
        try {
          await effect(db);
        } catch {
          console.error("[agent api] post-commit effect failed");
        }
      }
      return NextResponse.json({ data: result });
    } catch (e) {
      if (e instanceof AgentNotConfiguredError) {
        return apiError(e.message, 503);
      }
      if (e instanceof AgentRateLimitedError) {
        return NextResponse.json(
          { error: { message: e.message } },
          {
            status: 429,
            headers: agentRateLimitHeaders(e),
          }
        );
      }
      if (e instanceof AgentPracticeNotFoundError) {
        return apiError(e.message, 404);
      }
      throw e;
    }
  });
}
