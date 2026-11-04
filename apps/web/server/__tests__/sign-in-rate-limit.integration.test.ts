import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hash } from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { like } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";

const mocks = vi.hoisted(() => ({
  sendPasswordResetEmail: vi.fn(async () => ({ success: true })),
}));

// The cost-12 dummy hash checked for unknown accounts takes ~250ms per call in
// pure JS. These scenarios exercise the rate-limit store, not bcrypt, so skip
// that one comparison; real hashes still go through bcrypt.
vi.mock("bcryptjs", async (importOriginal) => {
  const imported = await importOriginal<
    typeof import("bcryptjs") & { default?: typeof import("bcryptjs") }
  >();
  const actual = imported.default ?? imported;
  const compare = async (password: string, passwordHash: string) =>
    passwordHash.startsWith("$2a$12$")
      ? false
      : actual.compare(password, passwordHash);
  return {
    ...actual,
    compare,
    default: { ...actual, compare },
  };
});

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
}));

const integration =
  process.env.SIGN_IN_RATE_LIMIT_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

type Authorize = (
  credentials: Record<"email" | "password", string>,
  req: { headers: Record<string, string> },
) => Promise<unknown>;

const PASSWORD = "correct-horse-battery";

integration("Sign-in rate limiting PostgreSQL contract", () => {
  const adminUrl = process.env.DATABASE_URL;
  const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD;
  const databaseName = `openpims_sign_in_limits_${randomUUID().replaceAll("-", "")}`;
  const originalEnv = { ...process.env };
  let admin: ReturnType<typeof postgres>;
  let owner: ReturnType<typeof postgres> | undefined;
  let ownerDb: ReturnType<typeof drizzle<typeof schema>>;
  let practiceId: string;
  let authorize: Authorize;
  let loginErrorMessage: (error: string) => string;

  async function signIn(
    email: string,
    password: string,
    headers: Record<string, string>,
  ): Promise<string> {
    try {
      return (await authorize({ email, password }, { headers }))
        ? "ok"
        : "invalid";
    } catch (err) {
      return loginErrorMessage((err as Error).message);
    }
  }

  async function addUsers(emails: string[]) {
    const passwordHash = await hash(PASSWORD, 4);
    await ownerDb.insert(schema.users).values(
      emails.map((email) => ({
        practiceId,
        email,
        passwordHash,
        name: "Synthetic Staff",
        role: "veterinarian" as const,
      })),
    );
  }

  async function buckets(prefix: string) {
    return ownerDb
      .select({
        key: schema.rateLimitBuckets.key,
        count: schema.rateLimitBuckets.count,
      })
      .from(schema.rateLimitBuckets)
      .where(like(schema.rateLimitBuckets.key, `${prefix}%`));
  }

  async function bucketCount(key: string) {
    const [row] = (await buckets(key)).filter((b) => b.key === key);
    return row?.count;
  }

  async function clearBuckets() {
    await ownerDb.delete(schema.rateLimitBuckets);
  }

  function useSelfHost() {
    delete process.env.VERCEL;
    delete process.env.OPENVPM_TRUSTED_PROXY_HOPS;
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    if (!appPassword) throw new Error("OPENPIMS_APP_DB_PASSWORD is required");
    if (!/^openpims_sign_in_limits_[a-f0-9]+$/.test(databaseName))
      throw new Error("unsafe database name");
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    ownerUrl.search = "";
    ownerUrl.hash = "";
    admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    for (const command of ["db:migrate", "db:rls"]) {
      execFileSync("pnpm", ["--filter", "@openpims/db", command], {
        cwd: resolve(process.cwd(), "../.."),
        env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
        stdio: "pipe",
        timeout: 60_000,
      });
    }
    owner = postgres(ownerUrl.toString(), { max: 2 });
    ownerDb = drizzle(owner, { schema });
    const [practice] = await ownerDb
      .insert(schema.practices)
      .values({ name: "Synthetic Sign-in Clinic" })
      .returning();
    practiceId = practice!.id;

    // The app under test connects as the least-privilege role, as in production.
    const appUrl = new URL(ownerUrl);
    appUrl.username = "openpims_app";
    appUrl.password = appPassword;
    process.env.DATABASE_URL = appUrl.toString();
    process.env.NEXTAUTH_SECRET = "integration-secret-at-least-32-characters";
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    delete process.env.HOSTED_BILLING_ENABLED;

    const { authOptions } = await import("@/lib/auth");
    authorize = (
      authOptions.providers[0] as unknown as { options: { authorize: Authorize } }
    ).options.authorize;
    ({ loginErrorMessage } = await import("@/lib/login-error-message"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }, 120_000);

  afterAll(async () => {
    process.env = originalEnv;
    vi.useRealTimers();
    const { db } = await import("@openpims/db/client");
    await (db as unknown as { $client?: { end(): Promise<void> } }).$client
      ?.end()
      .catch(() => undefined);
    globalThis.__openpimsDb = undefined;
    await owner?.end();
    if (admin) {
      await admin.unsafe(
        `drop database if exists "${databaseName}" with (force)`,
      );
      await admin.end();
    }
  }, 60_000);

  it("can't be locked out clinic-wide by random-email spraying on an unconfigured self-host", async () => {
    useSelfHost();
    await clearBuckets();

    // One attacker, 1000 failures across random accounts. Without a trusted
    // proxy the claimed address is all there is; rotating it dodges the
    // per-IP limit, holding it still trips that address's limit only.
    const results: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      results.push(
        await signIn(`spray-${randomUUID()}@example.invalid`, "Password1", {
          "x-forwarded-for": `198.18.${i >> 8}.${i & 255}`,
        }),
      );
    }
    for (let i = 0; i < 500; i += 1) {
      results.push(
        await signIn(`spray-${randomUUID()}@example.invalid`, "Password1", {
          "x-forwarded-for": "192.0.2.66",
        }),
      );
    }
    expect(results.filter((r) => r === "invalid")).toHaveLength(550);
    expect(results.filter((r) => r.startsWith("Too many"))).toHaveLength(450);

    // No bucket is shared by every client, and nothing lasts a day.
    expect(await buckets("login:ip:")).toEqual([]);
    expect(await buckets("login:ip-day:")).toEqual([]);

    // A fresh account with the right password, from the clinic, still works.
    await addUsers(["fresh@example.invalid"]);
    await expect(
      signIn("fresh@example.invalid", PASSWORD, {
        "x-forwarded-for": "203.0.113.10",
      }),
    ).resolves.toBe("ok");
    // Even with no forwarded address at all (per-account limits only).
    await expect(signIn("fresh@example.invalid", PASSWORD, {})).resolves.toBe(
      "ok",
    );
  }, 120_000);

  it("locks one account with growing backoff and clears it on success", async () => {
    useSelfHost();
    await clearBuckets();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await addUsers(["backoff@example.invalid"]);
      // Failures from different claimed addresses still count against the account.
      for (let i = 0; i < 5; i += 1) {
        await expect(
          signIn("backoff@example.invalid", "wrong", {
            "x-forwarded-for": `198.18.200.${i}`,
          }),
        ).resolves.toBe("invalid");
      }
      await expect(
        signIn("backoff@example.invalid", PASSWORD, {
          "x-forwarded-for": "203.0.113.10",
        }),
      ).resolves.toBe("Too many sign-in attempts. Try again in 1 minute.");

      vi.setSystemTime(Date.now() + 61_000);
      await expect(
        signIn("backoff@example.invalid", "wrong", {
          "x-forwarded-for": "203.0.113.10",
        }),
      ).resolves.toBe("invalid");
      await expect(
        signIn("backoff@example.invalid", PASSWORD, {
          "x-forwarded-for": "203.0.113.10",
        }),
      ).resolves.toBe("Too many sign-in attempts. Try again in 2 minutes.");

      vi.setSystemTime(Date.now() + 121_000);
      await expect(
        signIn("backoff@example.invalid", PASSWORD, {
          "x-forwarded-for": "203.0.113.10",
        }),
      ).resolves.toBe("ok");
      expect(await bucketCount("login:account:backoff@example.invalid")).toBe(
        undefined,
      );

      // Proving control of the mailbox lifts a lock immediately.
      for (let i = 0; i < 6; i += 1) {
        await signIn("backoff@example.invalid", "wrong", {
          "x-forwarded-for": "198.18.201.1",
        });
      }
      const { clearLoginAccountLock } = await import("@/lib/login-throttle");
      await clearLoginAccountLock("Backoff@Example.invalid");
      await expect(
        signIn("backoff@example.invalid", PASSWORD, {
          "x-forwarded-for": "203.0.113.10",
        }),
      ).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("lets a clinic behind one NAT through a shift change, refunding successes", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    const nat = {
      "x-vercel-forwarded-for": "198.51.100.7",
      "x-forwarded-for": "198.51.100.7",
    };
    const staff = Array.from(
      { length: 60 },
      (_, i) => `nat-staff-${i}@example.invalid`,
    );
    await addUsers(staff);
    for (const [i, email] of staff.entries()) {
      if (i % 3 === 0) {
        await expect(signIn(email, "typo", nat)).resolves.toBe("invalid");
      }
      await expect(signIn(email, PASSWORD, nat)).resolves.toBe("ok");
    }
    // Only the 20 typos were spent; every success gave its reservation back.
    expect(await bucketCount("login:ip:198.51.100.7")).toBe(20);
    expect(await bucketCount("login:ip-day:198.51.100.7")).toBe(20);
    expect(await buckets("login:account:nat-staff-")).toEqual([]);

    // Many more successes leave the budget untouched.
    for (let i = 0; i < 100; i += 1) {
      await expect(signIn(staff[i % 60]!, PASSWORD, nat)).resolves.toBe("ok");
    }
    expect(await bucketCount("login:ip:198.51.100.7")).toBe(20);
  }, 60_000);

  it("limits guessing across accounts from one verified IP without touching others", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    const attacker = {
      "x-vercel-forwarded-for": "192.0.2.77",
      "x-forwarded-for": "10.0.0.1",
    };
    for (let i = 0; i < 50; i += 1) {
      await expect(
        signIn(`guess-${i}@example.invalid`, "Password1", attacker),
      ).resolves.toBe("invalid");
    }
    await expect(
      signIn("guess-x@example.invalid", "Password1", attacker),
    ).resolves.toBe("Too many sign-in attempts. Try again in 15 minutes.");
    await addUsers(["other-clinic@example.invalid"]);
    await expect(
      signIn("other-clinic@example.invalid", PASSWORD, {
        "x-vercel-forwarded-for": "203.0.113.10",
      }),
    ).resolves.toBe("ok");
  }, 60_000);

  it("keeps the owner's reset requests working while an attacker spams their address", async () => {
    useSelfHost();
    await clearBuckets();
    mocks.sendPasswordResetEmail.mockClear();
    await addUsers(["reset@example.invalid"]);
    const { authRouter } = await import("../routers/auth");
    const { db } = await import("@openpims/db/client");
    const caller = (ip: string) =>
      authRouter.createCaller({ db, session: null, ip } as never);

    for (let i = 0; i < 5; i += 1) {
      await expect(
        caller("192.0.2.66").requestPasswordReset({
          email: "reset@example.invalid",
        }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      caller("192.0.2.66").requestPasswordReset({
        email: "reset@example.invalid",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // The owner, on their own network, still gets a link.
    await expect(
      caller("203.0.113.10").requestPasswordReset({
        email: "Reset@Example.invalid",
      }),
    ).resolves.toEqual({ ok: true });

    // Rotating addresses can't flood the mailbox past the daily cap.
    let accepted = 6;
    for (let i = 0; i < 30; i += 1) {
      try {
        await caller(`198.18.50.${i}`).requestPasswordReset({
          email: "reset@example.invalid",
        });
        accepted += 1;
      } catch (err) {
        expect(err).toMatchObject({ code: "TOO_MANY_REQUESTS" });
      }
    }
    expect(accepted).toBe(20);
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(20);
  }, 60_000);
});
