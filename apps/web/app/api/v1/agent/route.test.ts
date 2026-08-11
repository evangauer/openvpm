import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const activePracticeRows: unknown[][] = [];
  const activePracticeSelectBuilders: Array<{
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
  }> = [];

  class AgentNotConfiguredError extends Error {
    constructor() {
      super("OpenVPM Agent is not configured.");
      this.name = "AgentNotConfiguredError";
    }
  }

  class AgentRateLimitedError extends Error {
    readonly retryAfterSeconds: number;
    readonly limit: number;
    readonly resetAt: Date;

    constructor(
      retryAfterSeconds: number,
      limit = 20,
      resetAt = new Date("2026-06-30T04:45:00.000Z")
    ) {
      super("Too many agent runs. Try again later.");
      this.name = "AgentRateLimitedError";
      this.retryAfterSeconds = retryAfterSeconds;
      this.limit = limit;
      this.resetAt = resetAt;
    }
  }

  class AgentPracticeNotFoundError extends Error {
    constructor() {
      super("Practice not found");
      this.name = "AgentPracticeNotFoundError";
    }
  }

  class AgentRecoveryHoldError extends Error {
    constructor() {
      super("Practice recovery is in progress.");
      this.name = "AgentRecoveryHoldError";
    }
  }

  return {
    AgentNotConfiguredError,
    AgentPracticeNotFoundError,
    AgentRecoveryHoldError,
    AgentRateLimitedError,
    activePracticeRows,
    activePracticeSelectBuilders,
    authenticateApiKey: vi.fn(),
    runAgent: vi.fn(),
    tx: {
      kind: "tenant-db",
      select: vi.fn(() => {
        const result = activePracticeRows.shift() ?? [{ id: "active-practice" }];
        const builder = {
          from: vi.fn(() => builder),
          where: vi.fn(() => builder),
          limit: vi.fn(async () => result),
        };
        activePracticeSelectBuilders.push(builder);
        return builder;
      }),
    },
    withTenant: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
  hasScope: (scopes: string[], required: string) =>
    scopes.includes("*") || scopes.includes(required),
}));

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/agent", () => ({
  runAgent: mocks.runAgent,
  AgentNotConfiguredError: mocks.AgentNotConfiguredError,
  AgentPracticeNotFoundError: mocks.AgentPracticeNotFoundError,
  AgentRecoveryHoldError: mocks.AgentRecoveryHoldError,
  AgentRateLimitedError: mocks.AgentRateLimitedError,
}));

const { AGENT_INSTRUCTION_MAX_LENGTH } = await import("@/lib/agent/policy");
const { POST } = await import("./route");
const { JSON_REQUEST_BODY_MAX_BYTES } = await import("@/lib/request-json");

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const API_KEY_ID = "key-1";

function request(body: Record<string, unknown>) {
  return new Request("https://openvpm.test/api/v1/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function oversizedRequest() {
  return new Request("https://openvpm.test/api/v1/agent", {
    method: "POST",
    headers: {
      "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });
}

beforeEach(() => {
  mocks.authenticateApiKey.mockResolvedValue({
    ok: true,
    ctx: {
      practiceId: PRACTICE_ID,
      apiKeyId: API_KEY_ID,
      scopes: ["agent:run"],
    },
  });
  mocks.withTenant.mockImplementation(
    async (
      _db: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>
    ) => fn(mocks.tx)
  );
  mocks.runAgent.mockResolvedValue({
    text: "Done",
    toolCalls: [],
    iterations: 1,
    stopReason: "stop",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.activePracticeRows.length = 0;
  mocks.activePracticeSelectBuilders.length = 0;
});

describe("POST /api/v1/agent", () => {
  it("rejects oversized JSON bodies before tenant work", async () => {
    const response = await POST(oversizedRequest());
    const json = await response.json();

    expect(response.status).toBe(413);
    expect(json).toEqual({
      error: { message: "Request body too large" },
    });
    expect(mocks.authenticateApiKey).toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects oversized instructions before tenant work", async () => {
    const response = await POST(
      request({
        instruction: "x".repeat(AGENT_INSTRUCTION_MAX_LENGTH + 1),
      })
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields.instruction).toEqual([expect.any(String)]);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("rejects blank instructions before tenant work", async () => {
    const response = await POST(
      request({
        instruction: "   \n\t  ",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.message).toBe("Validation failed");
    expect(json.error.fields.instruction).toEqual([expect.any(String)]);
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("trims instructions before running the public API agent", async () => {
    const response = await POST(
      request({
        instruction: "  Summarize today's schedule  ",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      data: {
        text: "Done",
        toolCalls: [],
        iterations: 1,
        stopReason: "stop",
      },
    });
    expect(mocks.runAgent).toHaveBeenCalledWith({
      instruction: "Summarize today's schedule",
      allowWrites: false,
      apiKeyScopes: ["agent:run"],
      context: {
        db: mocks.tx,
        practiceId: PRACTICE_ID,
        userId: `apikey:${API_KEY_ID}`,
        postCommitEffect: expect.any(Function),
      },
    });
  });

  it("runs queued effects only after the tenant transaction completes", async () => {
    const order: string[] = [];
    const effect = vi.fn(async () => {
      order.push("effect");
    });
    mocks.withTenant.mockImplementationOnce(
      async (
        _db: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>
      ) => {
        const result = await fn(mocks.tx);
        order.push("commit");
        return result;
      }
    );
    mocks.runAgent.mockImplementationOnce(async ({ context }) => {
      order.push("agent");
      context.postCommitEffect?.(effect);
      return {
        text: "Done",
        toolCalls: [],
        iterations: 1,
        stopReason: "stop" as const,
      };
    });

    const response = await POST(
      request({ instruction: "Book an appointment for tomorrow" })
    );

    expect(response.status).toBe(200);
    expect(effect).toHaveBeenCalledWith({});
    expect(order).toEqual(["agent", "commit", "effect"]);
  });

  it("rejects write-enabled agent runs without the agent:write scope", async () => {
    const response = await POST(
      request({
        instruction: "Book an appointment for tomorrow",
        allow_writes: true,
      })
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: { message: "API key missing required scope: agent:write" },
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("allows write-enabled agent runs with the agent:write scope", async () => {
    mocks.authenticateApiKey.mockResolvedValueOnce({
      ok: true,
      ctx: {
        practiceId: PRACTICE_ID,
        apiKeyId: API_KEY_ID,
        scopes: ["agent:run", "agent:write"],
      },
    });

    const response = await POST(
      request({
        instruction: "Book an appointment for tomorrow",
        allow_writes: true,
      })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      data: {
        text: "Done",
        toolCalls: [],
        iterations: 1,
        stopReason: "stop",
      },
    });
    expect(mocks.runAgent).toHaveBeenCalledWith({
      instruction: "Book an appointment for tomorrow",
      allowWrites: true,
      apiKeyScopes: ["agent:run", "agent:write"],
      context: {
        db: mocks.tx,
        practiceId: PRACTICE_ID,
        userId: `apikey:${API_KEY_ID}`,
        postCommitEffect: expect.any(Function),
      },
    });
  });

  it("rejects agent runs when the authenticated practice is inactive", async () => {
    mocks.activePracticeRows.push([]);

    const response = await POST(
      request({
        instruction: "Summarize today's schedule",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      error: { message: "Practice not found" },
    });
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.tx.select).toHaveBeenCalled();
  });

  it("maps agent run throttles to a public 429 response", async () => {
    const resetAt = new Date("2026-06-30T04:45:00.000Z");
    mocks.runAgent.mockRejectedValueOnce(
      new mocks.AgentRateLimitedError(42, 20, resetAt)
    );

    const response = await POST(
      request({
        instruction: "Summarize today's schedule",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      resetAt.toISOString()
    );
    expect(json).toEqual({
      error: { message: "Too many agent runs. Try again later." },
    });
    expect(mocks.runAgent).toHaveBeenCalledWith({
      instruction: "Summarize today's schedule",
      allowWrites: false,
      apiKeyScopes: ["agent:run"],
      context: {
        db: mocks.tx,
        practiceId: PRACTICE_ID,
        userId: `apikey:${API_KEY_ID}`,
        postCommitEffect: expect.any(Function),
      },
    });
  });

  it("maps stale practice failures from agent tools to 404", async () => {
    mocks.runAgent.mockRejectedValueOnce(new mocks.AgentPracticeNotFoundError());

    const response = await POST(
      request({
        instruction: "Summarize today's schedule",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      error: { message: "Practice not found" },
    });
  });

  it("maps missing agent provider configuration to 503", async () => {
    mocks.runAgent.mockRejectedValueOnce(new mocks.AgentNotConfiguredError());

    const response = await POST(
      request({
        instruction: "Summarize today's schedule",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toEqual({
      error: { message: "OpenVPM Agent is not configured." },
    });
  });
});
