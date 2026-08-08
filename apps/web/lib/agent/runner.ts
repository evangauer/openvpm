import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  AGENT_TOOLS,
  AgentPracticeNotFoundError,
  type AgentTool,
  type AgentToolContext,
} from "./tools";
import { recordUsage } from "@/lib/billing/usage";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Provider-agnostic agent runner (Vercel AI SDK). The active model is chosen by
 * `AI_MODEL` (falling back to the legacy `AGENT_MODEL`); the provider is inferred
 * from the model id, so the same code runs on Gemini or Claude with only an env
 * change. Each tool already carries a Zod schema, which the AI SDK consumes
 * directly, and the SDK runs the tool-use loop for us up to MAX_ITERATIONS.
 */
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 8;
const MAX_OUTPUT_TOKENS = 1024;
export const AGENT_RUN_RATE_WINDOW_MS = 60_000;
export const AGENT_RUN_ACTOR_RATE_LIMIT = 20;
export const AGENT_RUN_PRACTICE_RATE_LIMIT = 120;

const SYSTEM_PROMPT = `You are the OpenVPM Agent, an operations assistant embedded in an open-source veterinary practice management system.

You help practice staff by using the provided tools to read and act on practice data. Guidelines:
- Always use tools to ground answers in real data. Never invent client names, patient records, appointment times, or doses.
- You operate on a single practice's data; you cannot see other practices.
- For any drug dose, use calculate_drug_dose and present it as a reference range that the prescribing clinician must verify. Never present a dose as a final prescribing decision.
- Before booking an appointment, confirm you have the right client and patient (use find_client / get_patient_summary first when ids are not given).
- Be concise and clinical. Surface warnings the tools return.`;

export interface AgentToolCall {
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
}

export interface AgentRunResult {
  text: string;
  toolCalls: AgentToolCall[];
  iterations: number;
  stopReason: string | null;
}

export class AgentNotConfiguredError extends Error {
  constructor() {
    super(
      "OpenVPM Agent is not configured. Set an AI key (GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY for Gemini, or ANTHROPIC_API_KEY for Claude) to enable agent runs."
    );
    this.name = "AgentNotConfiguredError";
  }
}

export class AgentRateLimitedError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    public readonly limit: number,
    public readonly resetAt: Date
  ) {
    super("Too many agent runs. Try again later.");
    this.name = "AgentRateLimitedError";
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the model id from request override → AI_MODEL → legacy AGENT_MODEL → default. */
function activeModelId(override?: string): string {
  return (
    nonBlank(override) ??
    nonBlank(process.env.AI_MODEL) ??
    nonBlank(process.env.AGENT_MODEL) ??
    DEFAULT_MODEL
  );
}

/** Google (Gemini) vs Anthropic (Claude) inferred from the model id. */
function isGoogleModel(modelId: string): boolean {
  return /^(google\/|models\/)?gemini/i.test(modelId);
}

function googleApiKey(): string | undefined {
  return (
    nonBlank(process.env.GOOGLE_API_KEY) ??
    nonBlank(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  );
}

function anthropicApiKey(): string | undefined {
  return nonBlank(process.env.ANTHROPIC_API_KEY);
}

function hasProviderKey(modelId: string): boolean {
  return isGoogleModel(modelId) ? Boolean(googleApiKey()) : Boolean(anthropicApiKey());
}

/** Whether the configured provider has its API key set. */
export function isAgentConfigured(): boolean {
  return hasProviderKey(activeModelId());
}

/**
 * Resolve the configured AI SDK model instance for one-shot generations
 * (e.g. SOAP drafts) that share the agent's provider/model configuration.
 * Throws AgentNotConfiguredError when no provider key is set.
 */
export function configuredModel(): LanguageModel {
  const modelId = activeModelId();
  if (!hasProviderKey(modelId)) throw new AgentNotConfiguredError();
  return resolveModel(modelId);
}

/** Build an AI SDK model instance for the given model id. */
function resolveModel(modelId: string) {
  if (isGoogleModel(modelId)) {
    const google = createGoogleGenerativeAI({ apiKey: googleApiKey() });
    return google(modelId.replace(/^google\//, ""));
  }
  const anthropic = createAnthropic({ apiKey: anthropicApiKey() });
  return anthropic(modelId.replace(/^anthropic\//, ""));
}

function retryAfterSeconds(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}

function hasApiScope(scopes: string[], required: string): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

function missingToolApiScopes(
  toolDef: AgentTool,
  apiKeyScopes: string[] | undefined
): string[] {
  if (!apiKeyScopes) return [];
  return (toolDef.requiredApiScopes ?? []).filter(
    (scope) => !hasApiScope(apiKeyScopes, scope)
  );
}

async function enforceAgentRunRateLimitBucket(input: {
  key: string;
  limit: number;
  logContext: string;
}): Promise<void> {
  let result: Awaited<ReturnType<typeof rateLimit>>;
  try {
    result = await rateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: AGENT_RUN_RATE_WINDOW_MS,
    });
  } catch (err) {
    console.error(`[agent.${input.logContext}] rate limit failed:`, err);
    const resetAt = new Date(Date.now() + AGENT_RUN_RATE_WINDOW_MS);
    throw new AgentRateLimitedError(
      retryAfterSeconds(resetAt),
      input.limit,
      resetAt
    );
  }

  if (!result.success) {
    throw new AgentRateLimitedError(
      retryAfterSeconds(result.resetAt),
      input.limit,
      result.resetAt
    );
  }
}

async function enforceAgentRunRateLimit(ctx: AgentToolContext): Promise<void> {
  await enforceAgentRunRateLimitBucket({
    key: `agent-run:${ctx.practiceId}:actor:${ctx.userId}`,
    limit: AGENT_RUN_ACTOR_RATE_LIMIT,
    logContext: "actor",
  });

  await enforceAgentRunRateLimitBucket({
    key: `agent-run:${ctx.practiceId}:practice`,
    limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
    logContext: "practice",
  });
}

/**
 * Build the AI SDK tool set from AGENT_TOOLS. Write tools are gated behind
 * `allowWrites`; every call (and any error) is captured into `sink` so the
 * caller can report exactly what the agent did, mirroring the prior runner.
 */
function buildToolSet(
  ctx: AgentToolContext,
  allowWrites: boolean,
  apiKeyScopes: string[] | undefined,
  sink: AgentToolCall[]
): ToolSet {
  const entries = AGENT_TOOLS.map((t) => [
    t.name,
    tool({
      description: t.description,
      inputSchema: t.zod,
      execute: async (args: unknown) => {
        const call: AgentToolCall = { name: t.name, input: args };
        try {
          if (!t.readOnly && !allowWrites) {
            call.error = "Write tools are disabled for this run.";
          } else {
            const missingScopes = missingToolApiScopes(t, apiKeyScopes);
            if (missingScopes.length > 0) {
              call.error = `Tool requires API key scope${
                missingScopes.length === 1 ? "" : "s"
              }: ${missingScopes.join(", ")}.`;
            } else {
              call.result = await t.execute(args, ctx);
            }
          }
        } catch (e) {
          if (e instanceof AgentPracticeNotFoundError) {
            throw e;
          }
          call.error = e instanceof Error ? e.message : "Tool execution failed";
        }
        sink.push(call);
        return call.error ? { error: call.error } : call.result;
      },
    }),
  ] as const);
  return Object.fromEntries(entries) as ToolSet;
}

/**
 * Run the OpenVPM Agent against a natural-language instruction. Executes a
 * tool-use loop scoped to the caller's practice. Write tools are gated behind
 * `allowWrites` (default false) so a read-only run can never mutate data.
 */
export async function runAgent(opts: {
  instruction: string;
  context: AgentToolContext;
  allowWrites?: boolean;
  apiKeyScopes?: string[];
  model?: string;
  /** Prior conversation turns, oldest first, for multi-turn chat context. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<AgentRunResult> {
  const modelId = activeModelId(opts.model);
  if (!hasProviderKey(modelId)) throw new AgentNotConfiguredError();

  const allowWrites = opts.allowWrites ?? false;
  await enforceAgentRunRateLimit(opts.context);

  const toolCalls: AgentToolCall[] = [];
  // A conversation (with history) uses `messages`; a one-shot run uses `prompt`.
  const messagesInput =
    opts.history && opts.history.length > 0
      ? {
          messages: [
            ...opts.history.map((m) => ({ role: m.role, content: m.content })),
            { role: "user" as const, content: opts.instruction },
          ],
        }
      : { prompt: opts.instruction };
  const result = await generateText({
    model: resolveModel(modelId),
    system: SYSTEM_PROMPT,
    ...messagesInput,
    tools: buildToolSet(
      opts.context,
      allowWrites,
      opts.apiKeyScopes,
      toolCalls
    ),
    stopWhen: stepCountIs(MAX_ITERATIONS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Meter only successful agent runs for hosted billing (no-op on self-host).
  await recordUsage({ practiceId: opts.context.practiceId, kind: "ai_run" });

  return {
    text: result.text.trim(),
    toolCalls,
    iterations: result.steps.length,
    stopReason: result.finishReason ?? null,
  };
}

/** Names of tools the agent can use, for surfacing in the UI/docs. */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);
