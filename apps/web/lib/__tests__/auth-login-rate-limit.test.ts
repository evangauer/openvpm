import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const activeUser = {
    id: "user-1",
    email: "admin@example.com",
    name: "Dr Admin",
    role: "admin",
    practiceId: "practice-1",
    passwordHash: "hashed-password",
  };
  const selectLimit = vi.fn(async (): Promise<unknown[]> => [activeUser]);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    db: {},
    tx: { select },
    activeUser,
    bcryptCompare: vi.fn(async () => true),
    clearRateLimit: vi.fn(async () => undefined),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 4,
      resetAt: new Date("2026-06-28T12:00:00Z"),
    })),
    selectLimit,
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

vi.mock("@/lib/rate-limit", () => ({
  clearRateLimit: mocks.clearRateLimit,
  rateLimit: mocks.rateLimit,
}));

vi.mock("bcryptjs", () => ({
  compare: mocks.bcryptCompare,
}));

const { authOptions } = await import("../auth");
const { createDemoAccessToken, DEMO_ACCESS_COOKIE_NAME } = await import(
  "../demo-access"
);

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

const ORIGINAL_DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE;
const ORIGINAL_NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("NEXT_PUBLIC_DEMO_MODE", ORIGINAL_DEMO_MODE);
  restoreEnv("NEXTAUTH_SECRET", ORIGINAL_NEXTAUTH_SECRET);
  vi.clearAllMocks();
  mocks.selectLimit.mockResolvedValue([mocks.activeUser]);
  mocks.bcryptCompare.mockResolvedValue(true);
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 4,
    resetAt: new Date("2026-06-28T12:00:00Z"),
  });
});

describe("credentials login rate-limit cleanup", () => {
  it("clears the email bucket after successful sign-in without resetting the IP bucket", async () => {
    const user = await credentialsProvider().authorize(
      { email: " Admin@Example.COM ", password: "password123" },
      { headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.5" } }
    );

    expect(user).toMatchObject({
      id: "user-1",
      email: "admin@example.com",
      name: "Dr Admin",
      role: "admin",
      practiceId: "practice-1",
    });
    expect(mocks.clearRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.clearRateLimit).toHaveBeenCalledWith(
      "login:email:admin@example.com"
    );
    expect(mocks.clearRateLimit).not.toHaveBeenCalledWith(
      "login:ip:203.0.113.10"
    );
  });

  it("does not clear any login bucket after a failed password check", async () => {
    mocks.bcryptCompare.mockResolvedValueOnce(false);

    await expect(
      credentialsProvider().authorize(
        { email: "admin@example.com", password: "wrong-password" },
        { headers: { "x-forwarded-for": "203.0.113.10" } }
      )
    ).resolves.toBeNull();

    expect(mocks.clearRateLimit).not.toHaveBeenCalled();
  });

  it("fails closed without lookup or bcrypt work when the limiter is unavailable", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limit unavailable"));

    try {
      await expect(
        credentialsProvider().authorize(
          { email: "admin@example.com", password: "password123" },
          { headers: { "x-forwarded-for": "203.0.113.10" } }
        )
      ).resolves.toBeNull();

      expect(errorSpy).toHaveBeenCalledWith(
        "[auth] login rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.withSystem).not.toHaveBeenCalled();
      expect(mocks.bcryptCompare).not.toHaveBeenCalled();
      expect(mocks.clearRateLimit).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("disables seeded password login on the hosted demo", async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";

    await expect(
      credentialsProvider().authorize(
        { email: "admin@example.com", password: "password123" },
        { headers: { "x-forwarded-for": "203.0.113.10" } }
      )
    ).resolves.toBeNull();

    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });
});

describe("email-gated demo login", () => {
  it("requires a valid signed gate cookie before loading the seeded admin", async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-characters-long";
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
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-characters-long";

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
    process.env.NEXT_PUBLIC_DEMO_MODE = "true";
    process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-characters-long";
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
