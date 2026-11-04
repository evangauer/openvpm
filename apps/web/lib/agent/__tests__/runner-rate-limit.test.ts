import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RUN_ACTOR_RATE_LIMIT,
  AGENT_RUN_PRACTICE_RATE_LIMIT,
  AGENT_RUN_RATE_WINDOW_MS,
  AgentNotConfiguredError,
  AgentBillingAccessError,
  AgentRateLimitedError,
  AgentRecoveryHoldError,
  configuredModel,
  isAgentConfigured,
  runAgent,
} from "../runner";

const mocks = vi.hoisted(() => {
  const anthropicModel = vi.fn((modelId: string) => ({
    provider: "anthropic",
    modelId,
  }));
  const vertexModel = vi.fn((modelId: string) => ({
    provider: "google-vertex",
    modelId,
  }));
  const oidcAuthClient = { provider: "google-oidc" };

  return {
    anthropicModel,
    vertexModel,
    createAnthropic: vi.fn(() => anthropicModel),
    createVertex: vi.fn(() => vertexModel),
    externalAccountFromJson: vi.fn((_config: unknown) => oidcAuthClient),
    getVercelOidcToken: vi.fn(async () => "signed-vercel-token"),
    oidcAuthClient,
    generateText: vi.fn(),
    stepCountIs: vi.fn((count: number) => ({ count })),
    tool: vi.fn((definition: unknown) => definition),
    rateLimit: vi.fn(),
    recordUsage: vi.fn(),
    readHostedAiAccess: vi.fn(),
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

vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: mocks.createVertex,
}));

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: mocks.getVercelOidcToken,
}));

vi.mock("google-auth-library", () => ({
  ExternalAccountClient: { fromJSON: mocks.externalAccountFromJson },
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/billing/usage", () => ({
  recordUsage: mocks.recordUsage,
}));

vi.mock("@/lib/billing/ai-access", () => ({
  readHostedAiAccess: mocks.readHostedAiAccess,
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
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
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
  vi.stubEnv("AI_MODEL", "claude-sonnet-4-6");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 19,
    resetAt,
  });
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.readHostedAiAccess.mockResolvedValue({
    allowed: true,
    reason: "allowed",
    message: null,
  });
  mocks.generateText.mockResolvedValue({
    text: " Done ",
    steps: [{}],
    finishReason: "stop",
  });
});

describe("agent demo isolation", () => {
  it.each(["true", " true ", "\ntrue\t"])("blocks configured credentials before provider or tenant work for %j", async (flag) => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", flag);
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "synthetic-project");
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "global");
    vi.stubEnv("GOOGLE_CLIENT_EMAIL", "synthetic@example.test");
    vi.stubEnv("GOOGLE_PRIVATE_KEY", "synthetic-private-key");
    for (const model of ["claude-sonnet-4-6", "gemini-3.5-flash"]) {
      vi.stubEnv("AI_MODEL", model);
      expect(isAgentConfigured()).toBe(false);
      expect(() => configuredModel()).toThrow(AgentNotConfiguredError);
      await expect(runAgent({ instruction: "Synthetic instruction", context, model })).rejects.toBeInstanceOf(AgentNotConfiguredError);
    }
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createVertex).not.toHaveBeenCalled();
    expect(mocks.externalAccountFromJson).not.toHaveBeenCalled();
    expect(mocks.getVercelOidcToken).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.lockPracticeForExternalSideEffects).not.toHaveBeenCalled();
    expect(mocks.readHostedAiAccess).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it.each(["false", "", "TRUE", "1"])("preserves non-demo configuredModel behavior for %j", (flag) => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", flag);
    expect(isAgentConfigured()).toBe(true);
    expect(configuredModel()).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(mocks.createAnthropic).toHaveBeenCalledOnce();
  });

  it("rechecks demo after awaited tenant work before resolving a paid model", async () => {
    const lock = deferred<boolean>();
    mocks.lockPracticeForExternalSideEffects.mockReturnValueOnce(lock.promise);
    const run = runAgent({ instruction: "Synthetic instruction", context });
    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledOnce();
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    lock.resolve(true);
    await expect(run).rejects.toBeInstanceOf(AgentNotConfiguredError);
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.createVertex).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("runAgent rate limiting", () => {
  it("builds Gemini through Vercel OIDC workload identity federation", async () => {
    vi.stubEnv("AI_MODEL", "google/gemini-3.5-flash");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "openvpm-ai");
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "global");
    vi.stubEnv("GCP_PROJECT_NUMBER", "123456789012");
    vi.stubEnv(
      "GCP_SERVICE_ACCOUNT_EMAIL",
      "vertex@openvpm-ai.iam.gserviceaccount.com",
    );
    vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_ID", "vercel");
    vi.stubEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID", "vercel");

    await runAgent({ instruction: "Summarize today", context });

    expect(mocks.createVertex).toHaveBeenCalledWith({
      project: "openvpm-ai",
      location: "global",
      googleAuthOptions: {
        authClient: mocks.oidcAuthClient,
        projectId: "openvpm-ai",
      },
    });
    expect(mocks.externalAccountFromJson).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "external_account",
        audience:
          "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel/providers/vercel",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/vertex@openvpm-ai.iam.gserviceaccount.com:generateAccessToken",
        subject_token_supplier: {
          getSubjectToken: expect.any(Function),
        },
      }),
    );
    const authConfig = mocks.externalAccountFromJson.mock.calls[0]?.[0] as {
      subject_token_supplier: { getSubjectToken: () => Promise<string> };
    };
    await expect(
      authConfig.subject_token_supplier.getSubjectToken(),
    ).resolves.toBe("signed-vercel-token");
    expect(mocks.vertexModel).toHaveBeenCalledWith("gemini-3.5-flash");
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

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
      }),
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
      const tools = (
        opts as {
          tools: {
            book_appointment: {
              execute: (args: unknown) => Promise<unknown>;
            };
          };
        }
      ).tools;
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
      runAgent({ instruction: "Find overdue invoices", context }),
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
        runAgent({ instruction: "Find overdue invoices", context }),
      ).rejects.toMatchObject({
        limit: AGENT_RUN_ACTOR_RATE_LIMIT,
        retryAfterSeconds: 60,
        resetAt: expectedResetAt,
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[agent.actor] rate limit failed:",
        expect.any(Error),
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
      runAgent({ instruction: "Find overdue invoices", context }),
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
        runAgent({ instruction: "Find overdue invoices", context }),
      ).rejects.toMatchObject({
        limit: AGENT_RUN_PRACTICE_RATE_LIMIT,
        retryAfterSeconds: 60,
        resetAt: expectedResetAt,
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[agent.practice] rate limit failed:",
        expect.any(Error),
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
      runAgent({ instruction: "Find overdue invoices", context }),
    ).rejects.toBeInstanceOf(AgentNotConfiguredError);

    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("rechecks card-backed AI access under the provider-call practice lock", async () => {
    mocks.readHostedAiAccess.mockResolvedValueOnce({
      allowed: false,
      reason: "billing_setup_required",
      message: "Add a card to your trial to try OpenVPM AI.",
    });

    await expect(
      runAgent({ instruction: "Summarize today", context }),
    ).rejects.toBeInstanceOf(AgentBillingAccessError);

    expect(mocks.lockPracticeForExternalSideEffects).toHaveBeenCalledTimes(1);
    expect(mocks.readHostedAiAccess).toHaveBeenCalledWith(
      context.db,
      context.practiceId,
    );
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });
});
