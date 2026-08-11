import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_ACTOR_RATE_LIMIT,
  AGENT_RUN_PRACTICE_RATE_LIMIT,
  AGENT_RUN_RATE_WINDOW_MS,
  AgentNotConfiguredError,
  AgentRateLimitedError,
  AgentRecoveryHoldError,
  runAgent,
} from "../runner";

const mocks = vi.hoisted(() => {
  const anthropicModel = vi.fn((modelId: string) => ({
    provider: "anthropic",
    modelId,
  }));
  const googleModel = vi.fn((modelId: string) => ({
    provider: "google",
    modelId,
  }));

  return {
    anthropicModel,
    googleModel,
    createAnthropic: vi.fn(() => anthropicModel),
    createGoogleGenerativeAI: vi.fn(() => googleModel),
    generateText: vi.fn(),
    stepCountIs: vi.fn((count: number) => ({ count })),
    tool: vi.fn((definition: unknown) => definition),
    rateLimit: vi.fn(),
    recordUsage: vi.fn(),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
  };
});

vi.mock("ai", () => ({
  generateText: mocks.generateText,
  stepCountIs: mocks.stepCountIs,
  tool: mocks.tool,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mocks.createGoogleGenerativeAI,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/billing/usage", () => ({
  recordUsage: mocks.recordUsage,
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

const resetAt = new Date("2099-01-01T00:00:00.000Z");
const context = {
  db: {} as never,
  practiceId: "practice-1",
  userId: "user-1",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubEnv("AI_MODEL", "claude-sonnet-4-6");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 19,
    resetAt,
  });
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.generateText.mockResolvedValue({
    text: " Done ",
    steps: [{}],
    finishReason: "stop",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("runAgent rate limiting", () => {
  it("does not call the model provider while the practice is held", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    await expect(
      runAgent({ instruction: "Summarize today", context }),
    ).rejects.toBeInstanceOf(AgentRecoveryHoldError);

    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("checks actor and practice buckets before calling the provider", async () => {
    const result = await runAgent({
      instruction: "Summarize today's schedule",
      context,
    });

    expect(result).toMatchObject({
      text: "Done",
      iterations: 1,
      stopReason: "stop",
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "agent-run:practice-1:actor:user-1",
      limit: AGENT_RUN_ACTOR_RATE_LIMIT,
      windowMs: AGENT_RUN_RATE_WINDOW_MS,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: "agent-run:practice-1:practice",
      limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
      windowMs: AGENT_RUN_RATE_WINDOW_MS,
    });
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Summarize today's schedule",
      })
    );
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      practiceId: "practice-1",
      kind: "ai_run",
    });
  });

  it("waits for hosted usage recording before returning a successful run", async () => {
    const usage = deferred();
    mocks.recordUsage.mockReturnValueOnce(usage.promise);

    let settled = false;
    const runPromise = runAgent({
      instruction: "Summarize today's schedule",
      context,
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    usage.resolve();
    await expect(runPromise).resolves.toMatchObject({
      text: "Done",
      iterations: 1,
      stopReason: "stop",
    });
  });

  it("blocks API-key write tools that are missing their resource scope", async () => {
    mocks.generateText.mockImplementationOnce(async (opts: unknown) => {
      const tools = (opts as {
        tools: {
          book_appointment: {
            execute: (args: unknown) => Promise<unknown>;
          };
        };
      }).tools;
      await tools.book_appointment.execute({});
      return {
        text: " Could not book. ",
        steps: [{}],
        finishReason: "stop",
      };
    });

    const result = await runAgent({
      instruction: "Book an appointment for tomorrow",
      allowWrites: true,
      apiKeyScopes: ["agent:run", "agent:write"],
      context,
    });

    expect(result).toMatchObject({
      text: "Could not book.",
      toolCalls: [
        {
          name: "book_appointment",
          input: {},
          error: "Tool requires API key scope: appointments:write.",
        },
      ],
    });
  });

  it("blocks actor overages before practice checks, provider calls, or billing usage", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt,
    });

    await expect(
      runAgent({ instruction: "Find overdue invoices", context })
    ).rejects.toMatchObject({
      limit: AGENT_RUN_ACTOR_RATE_LIMIT,
      resetAt,
    });

    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed before provider calls when the actor limiter is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:00:00.000Z"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));
    const expectedResetAt = new Date("2026-06-30T05:01:00.000Z");

    try {
      await expect(
        runAgent({ instruction: "Find overdue invoices", context })
      ).rejects.toMatchObject({
        limit: AGENT_RUN_ACTOR_RATE_LIMIT,
        retryAfterSeconds: 60,
        resetAt: expectedResetAt,
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[agent.actor] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "agent-run:practice-1:actor:user-1",
        limit: AGENT_RUN_ACTOR_RATE_LIMIT,
        windowMs: AGENT_RUN_RATE_WINDOW_MS,
      });
      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(mocks.recordUsage).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("blocks practice-wide overages before provider calls or billing usage", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 19, resetAt })
      .mockResolvedValueOnce({ success: false, remaining: 0, resetAt });

    await expect(
      runAgent({ instruction: "Find overdue invoices", context })
    ).rejects.toMatchObject({
      limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
      resetAt,
    });

    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed before provider calls when the practice limiter is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T05:00:00.000Z"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 19, resetAt })
      .mockRejectedValueOnce(new Error("rate limiter down"));
    const expectedResetAt = new Date("2026-06-30T05:01:00.000Z");

    try {
      await expect(
        runAgent({ instruction: "Find overdue invoices", context })
      ).rejects.toMatchObject({
        limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
        retryAfterSeconds: 60,
        resetAt: expectedResetAt,
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[agent.practice] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
        key: "agent-run:practice-1:actor:user-1",
        limit: AGENT_RUN_ACTOR_RATE_LIMIT,
        windowMs: AGENT_RUN_RATE_WINDOW_MS,
      });
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
        key: "agent-run:practice-1:practice",
        limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
        windowMs: AGENT_RUN_RATE_WINDOW_MS,
      });
      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(mocks.recordUsage).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not spend rate-limit buckets when the agent provider key is blank", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");

    await expect(
      runAgent({ instruction: "Find overdue invoices", context })
    ).rejects.toBeInstanceOf(AgentNotConfiguredError);

    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
