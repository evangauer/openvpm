import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const activeUser = {
    id: "user-1",
    email: "admin@example.com",
    name: "Dr Admin",
    role: "admin",
    practiceId: "practice-1",
    passwordHash: "hashed-password",
    emailVerifiedAt: null,
  };
  const selectLimit = vi.fn(async (): Promise<unknown[]> => [activeUser]);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // In-memory stand-in for the rate_limit_buckets table.
  const buckets = new Map<
    string,
    { count: number; resetAt: Date; updatedAt: Date }
  >();

  return {
    db: {},
    activeUser,
    buckets,
    bcryptCompare: vi.fn(async (password: string) => password === "correct-password"),
    selectLimit,
    storeFailure: { current: null as Error | null },
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn({ select })
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/rate-limit", async () => {
  const actual =
    await vi.importActual<typeof import("../rate-limit")>("../rate-limit");
  const failIfDown = () => {
    if (mocks.storeFailure.current) throw mocks.storeFailure.current;
  };
  return {
    rateLimitRetryAfterSeconds: actual.rateLimitRetryAfterSeconds,
    rateLimit: vi.fn(
      async (options: {
        key: string;
        limit: number;
        windowMs: number;
        now?: Date;
      }) => {
        failIfDown();
        const now = options.now ?? new Date();
        const existing = mocks.buckets.get(options.key);
        const bucket =
          existing && existing.resetAt > now
            ? { ...existing, count: existing.count + 1, updatedAt: now }
            : {
                count: 1,
                resetAt: new Date(now.getTime() + options.windowMs),
                updatedAt: now,
              };
        mocks.buckets.set(options.key, bucket);
        return {
          success: bucket.count <= options.limit,
          remaining: Math.max(options.limit - bucket.count, 0),
          resetAt: bucket.resetAt,
        };
      }
    ),
    refundRateLimit: vi.fn(async (key: string, resetAt: Date) => {
      const bucket = mocks.buckets.get(key);
      if (bucket && bucket.resetAt.getTime() === resetAt.getTime()) {
        bucket.count = Math.max(bucket.count - 1, 0);
      }
    }),
    clearRateLimit: vi.fn(async (key: string) => {
      mocks.buckets.delete(key);
    }),
    consumeBackoffAttempt: vi.fn(
      async (options: {
        key: string;
        policy: Parameters<typeof actual.backoffDecision>[0];
        now?: Date;
      }) => {
        failIfDown();
        const now = options.now ?? new Date();
        const decision = actual.backoffDecision(
          options.policy,
          mocks.buckets.get(options.key),
          now
        );
        if (!decision.success) return decision;
        mocks.buckets.set(options.key, decision.next);
        return { success: true as const };
      }
    ),
  };
});

vi.mock("bcryptjs", () => ({
  compare: mocks.bcryptCompare,
}));

const { authOptions } = await import("../auth");
const { createDemoAccessToken, DEMO_ACCESS_COOKIE_NAME } = await import(
  "../demo-access"
);
const { loginErrorMessage } = await import("../login-error-message");
const { LOGIN_IP_LIMITS } = await import("../login-throttle");

type CredentialsProviderWithAuthorize = {
  options: {
    authorize: (
      credentials: Record<"email" | "password", string>,
      req: { headers: Record<string, string> }
    ) => Promise<unknown>;
  };
};

type DemoProviderWithAuthorize = {
  options: {
    authorize: (
      credentials: { role: string },
      req: { headers: Record<string, string> }
    ) => Promise<unknown>;
  };
};

function credentialsProvider() {
  return (authOptions.providers[0] as CredentialsProviderWithAuthorize).options;
}

function demoProvider() {
  return (authOptions.providers[1] as DemoProviderWithAuthorize).options;
}

const START = new Date("2026-06-28T12:00:00Z");

function advanceMinutes(minutes: number) {
  vi.setSystemTime(new Date(Date.now() + minutes * 60 * 1000));
}

/** Resolves to "ok", "invalid", or the user-facing rate-limit message. */
async function signIn(
  email: string,
  password: string,
  headers: Record<string, string> = { "x-forwarded-for": "203.0.113.10" }
): Promise<string> {
  try {
    const user = await credentialsProvider().authorize(
      { email, password },
      { headers }
    );
    return user ? "ok" : "invalid";
  } catch (err) {
    return loginErrorMessage((err as Error).message);
  }
}

const FIRST_IP_LIMIT = LOGIN_IP_LIMITS[0].limit;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  // Model a Vercel deployment unless a test says otherwise.
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("OPENVPM_TRUSTED_PROXY_HOPS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.buckets.clear();
  mocks.storeFailure.current = null;
  mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
});

function vercelHeaders(ip: string): Record<string, string> {
  return { "x-vercel-forwarded-for": ip, "x-forwarded-for": ip };
}

describe("credentials sign-in", () => {
  it("keeps trial access open while the user's email is unverified", async () => {
    const user = await credentialsProvider().authorize(
      { email: " Admin@Example.COM ", password: "correct-password" },
      { headers: vercelHeaders("203.0.113.10") }
    );

    expect(user).toMatchObject({
      id: "user-1",
      email: "admin@example.com",
      practiceId: "practice-1",
    });
    expect(mocks.activeUser.emailVerifiedAt).toBeNull();
  });

  it("fails closed without lookup or bcrypt work when the limiter is unavailable", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.storeFailure.current = new Error("rate limit unavailable");

    await expect(
      signIn("admin@example.com", "correct-password", vercelHeaders("203.0.113.10"))
    ).resolves.toBe("invalid");

    expect(errorSpy).toHaveBeenCalledWith(
      "[auth] login rate limit failed:",
      expect.any(Error)
    );
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("disables seeded password login on the hosted demo", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");

    await expect(
      signIn("admin@example.com", "correct-password")
    ).resolves.toBe("invalid");

    expect(mocks.buckets.size).toBe(0);
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });
});

describe("credentials sign-in throttling", () => {
  it("does not spend any budget on successful sign-ins", async () => {
    const headers = vercelHeaders("203.0.113.10");
    for (let i = 0; i < FIRST_IP_LIMIT * 3; i += 1) {
      await expect(
        signIn("admin@example.com", "correct-password", headers)
      ).resolves.toBe("ok");
    }

    expect(mocks.buckets.has("login:account:admin@example.com")).toBe(false);
    expect(mocks.buckets.get("login:ip:203.0.113.10")?.count).toBe(0);
    expect(mocks.buckets.get("login:ip-day:203.0.113.10")?.count).toBe(0);
  });

  it("locks one account after repeated failures, with growing backoff", async () => {
    const headers = vercelHeaders("203.0.113.10");
    for (let i = 0; i < 5; i += 1) {
      await expect(
        signIn("admin@example.com", "wrong-password", headers)
      ).resolves.toBe("invalid");
    }

    // Locked: even the right password is refused, and bcrypt never runs.
    mocks.bcryptCompare.mockClear();
    await expect(
      signIn("admin@example.com", "correct-password", headers)
    ).resolves.toBe("Too many sign-in attempts. Try again in 1 minute.");
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();

    // Retrying while locked doesn't extend the lock.
    advanceMinutes(1);
    await expect(
      signIn("admin@example.com", "wrong-password", headers)
    ).resolves.toBe("invalid");
    // The next lock doubles.
    await expect(
      signIn("admin@example.com", "correct-password", headers)
    ).resolves.toBe("Too many sign-in attempts. Try again in 2 minutes.");

    advanceMinutes(2);
    await expect(
      signIn("admin@example.com", "correct-password", headers)
    ).resolves.toBe("ok");
    // Success resets the streak.
    await expect(
      signIn("admin@example.com", "wrong-password", headers)
    ).resolves.toBe("invalid");
    expect(mocks.buckets.get("login:account:admin@example.com")?.count).toBe(1);
  });

  it("caps the account lock at one hour", async () => {
    const headers = vercelHeaders("203.0.113.10");
    for (let i = 0; i < 12; i += 1) {
      await signIn("admin@example.com", "wrong-password", headers);
      advanceMinutes(61);
    }
    advanceMinutes(-61);
    await expect(
      signIn("admin@example.com", "correct-password", headers)
    ).resolves.toBe("Too many sign-in attempts. Try again in 60 minutes.");
  });

  it("only locks the targeted account, not colleagues on the same network", async () => {
    const headers = vercelHeaders("203.0.113.10");
    for (let i = 0; i < 6; i += 1) {
      await signIn("admin@example.com", "wrong-password", headers);
    }
    mocks.selectLimit.mockResolvedValue([
      { ...mocks.activeUser, id: "user-2", email: "tech@example.com" },
    ]);
    await expect(
      signIn("tech@example.com", "correct-password", headers)
    ).resolves.toBe("ok");
  });

  it("answers the same way for accounts that don't exist", async () => {
    mocks.selectLimit.mockResolvedValue([]);
    const headers = vercelHeaders("203.0.113.10");
    const results: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await signIn("nobody@example.com", "correct-password", headers));
    }
    expect(results).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "Too many sign-in attempts. Try again in 1 minute.",
    ]);
  });

  it("lets a whole clinic behind one NAT sign in through a shift change", async () => {
    const nat = vercelHeaders("198.51.100.7");
    // 60 staff each sign in, a third of them after one typo.
    for (let i = 0; i < 60; i += 1) {
      const email = `staff${i}@example.com`;
      mocks.selectLimit.mockResolvedValue([
        { ...mocks.activeUser, id: `user-${i}`, email },
      ]);
      if (i % 3 === 0) {
        await expect(signIn(email, "typo", nat)).resolves.toBe("invalid");
      }
      await expect(signIn(email, "correct-password", nat)).resolves.toBe("ok");
    }
    expect(mocks.buckets.get("login:ip:198.51.100.7")?.count).toBe(20);
  });

  it("still limits guessing across many accounts from one IP", async () => {
    mocks.selectLimit.mockResolvedValue([]);
    const attacker = vercelHeaders("192.0.2.66");
    for (let i = 0; i < FIRST_IP_LIMIT; i += 1) {
      await expect(
        signIn(`victim${i}@example.com`, "Password1", attacker)
      ).resolves.toBe("invalid");
    }
    await expect(
      signIn("one-more@example.com", "Password1", attacker)
    ).resolves.toBe("Too many sign-in attempts. Try again in 15 minutes.");

    // A different client is unaffected.
    mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
    await expect(
      signIn("admin@example.com", "correct-password", vercelHeaders("203.0.113.10"))
    ).resolves.toBe("ok");
  });

  it("ignores a client-supplied X-Forwarded-For on Vercel", async () => {
    mocks.selectLimit.mockResolvedValue([]);
    for (let i = 0; i < FIRST_IP_LIMIT; i += 1) {
      await signIn(`victim${i}@example.com`, "Password1", {
        "x-vercel-forwarded-for": "192.0.2.66",
        "x-forwarded-for": `10.0.${i}.1`,
      });
    }
    await expect(
      signIn("one-more@example.com", "Password1", {
        "x-vercel-forwarded-for": "192.0.2.66",
        "x-forwarded-for": "10.9.9.9",
      })
    ).resolves.toMatch(/^Too many sign-in attempts/);
  });

  it("uses the proxy-appended address when a trusted proxy is configured", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OPENVPM_TRUSTED_PROXY_HOPS", "1");
    mocks.selectLimit.mockResolvedValue([]);
    for (let i = 0; i < FIRST_IP_LIMIT; i += 1) {
      // Spoofed left-most values change every time; the proxy's entry doesn't.
      await signIn(`victim${i}@example.com`, "Password1", {
        "x-forwarded-for": `10.0.${i}.1, 192.0.2.66`,
      });
    }
    await expect(
      signIn("one-more@example.com", "Password1", {
        "x-forwarded-for": "10.9.9.9, 192.0.2.66",
      })
    ).resolves.toMatch(/^Too many sign-in attempts/);
    expect(mocks.buckets.has("login:ip:10.0.0.1")).toBe(false);
  });

  it("can't be turned into a clinic-wide lockout on a self-host without a trusted proxy", async () => {
    vi.stubEnv("VERCEL", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.selectLimit.mockResolvedValue([]);
    // An attacker sprays random accounts; the claimed address changes each
    // time, so no per-IP bucket fills and nothing is shared with the clinic.
    for (let i = 0; i < 1000; i += 1) {
      await expect(
        signIn(`victim${i}@example.com`, "Password1", {
          "x-forwarded-for": `198.18.${i >> 8}.${i & 255}`,
        })
      ).resolves.toBe("invalid");
    }
    const ipKeys = [...mocks.buckets.keys()].filter((key) => key.includes(":ip"));
    expect(ipKeys).toHaveLength(1000);
    expect(ipKeys.every((key) => key.startsWith("login:ip-unverified:198.18."))).toBe(true);

    mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
    await expect(
      signIn("admin@example.com", "correct-password", {
        "x-forwarded-for": "203.0.113.10",
      })
    ).resolves.toBe("ok");
    expect(warnSpy.mock.calls.flat().join(" ")).toContain(
      "OPENVPM_TRUSTED_PROXY_HOPS"
    );
  });

  it("still slows a single unverified client that doesn't rotate its address", async () => {
    vi.stubEnv("VERCEL", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.selectLimit.mockResolvedValue([]);
    const attacker = { "x-forwarded-for": "192.0.2.66" };
    for (let i = 0; i < FIRST_IP_LIMIT; i += 1) {
      await signIn(`victim${i}@example.com`, "Password1", attacker);
    }
    await expect(
      signIn("one-more@example.com", "Password1", attacker)
    ).resolves.toBe("Too many sign-in attempts. Try again in 15 minutes.");
    expect(mocks.buckets.has("login:ip-unverified:192.0.2.66")).toBe(true);

    // Other clients have their own buckets.
    mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
    await expect(
      signIn("admin@example.com", "correct-password", {
        "x-forwarded-for": "203.0.113.10",
      })
    ).resolves.toBe("ok");
  });

  it("skips per-IP limits when a local proxy hides every client behind loopback", async () => {
    vi.stubEnv("VERCEL", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.selectLimit.mockResolvedValue([]);
    const viaProxy = { "x-forwarded-for": "127.0.0.1" };
    for (let i = 0; i < FIRST_IP_LIMIT * 2; i += 1) {
      await signIn(`victim${i}@example.com`, "Password1", viaProxy);
    }
    mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
    await expect(
      signIn("admin@example.com", "correct-password", viaProxy)
    ).resolves.toBe("ok");
    expect([...mocks.buckets.keys()].filter((key) => key.includes(":ip"))).toEqual([]);
  });

  it("still locks an account by backoff when per-IP limits don't apply", async () => {
    vi.stubEnv("VERCEL", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 5; i += 1) {
      await signIn("admin@example.com", "wrong-password", {
        "x-forwarded-for": `198.18.0.${i}`,
      });
    }
    await expect(
      signIn("admin@example.com", "correct-password", {
        "x-forwarded-for": "198.18.1.1",
      })
    ).resolves.toBe("Too many sign-in attempts. Try again in 1 minute.");
  });
});

describe("email-gated demo login", () => {
  it("requires a valid signed gate cookie before loading the seeded admin", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-at-least-32-characters-long");
    const token = createDemoAccessToken("vet@clinic.com");
    expect(token).toBeTruthy();

    mocks.selectLimit
      .mockResolvedValueOnce([mocks.activeUser])
      .mockResolvedValueOnce([{ id: mocks.activeUser.practiceId }]);

    const user = await demoProvider().authorize(
      { role: "admin" },
      { headers: { cookie: `${DEMO_ACCESS_COOKIE_NAME}=${token}` } }
    );

    expect(user).toMatchObject({
      id: "user-1",
      role: "admin",
      practiceId: "practice-1",
    });
    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.selectLimit).toHaveBeenCalledTimes(2);
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("rejects missing cookies and unknown roles without querying", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-at-least-32-characters-long");

    await expect(
      demoProvider().authorize(
        { role: "admin" },
        { headers: {} }
      )
    ).resolves.toBeNull();
    await expect(
      demoProvider().authorize(
        { role: "owner" },
        { headers: { cookie: `${DEMO_ACCESS_COOKIE_NAME}=invalid` } }
      )
    ).resolves.toBeNull();

    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("rejects a seeded user outside the named demo tenant", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-at-least-32-characters-long");
    const token = createDemoAccessToken("vet@clinic.com");
    mocks.selectLimit
      .mockResolvedValueOnce([mocks.activeUser])
      .mockResolvedValueOnce([]);

    await expect(
      demoProvider().authorize(
        { role: "admin" },
        { headers: { cookie: `${DEMO_ACCESS_COOKIE_NAME}=${token}` } }
      )
    ).resolves.toBeNull();
  });
});
