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
  setCookie: vi.fn(),
}));

// authorize() sets the known-device cookie through next/headers; capture it
// the way the route handler would append it to the response.
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.setCookie }),
}));

// The cost-12 dummy hash checked for unknown accounts takes ~250ms per call in
// pure JS. These scenarios exercise the rate-limit store, not bcrypt, so skip
// that one comparison (lib/auth.ts DUMMY_PASSWORD_HASH); real hashes, such as
// one set by a password reset, still go through bcrypt.
vi.mock("bcryptjs", async (importOriginal) => {
  const imported = await importOriginal<
    typeof import("bcryptjs") & { default?: typeof import("bcryptjs") }
  >();
  const actual = imported.default ?? imported;
  const dummyHash =
    "$2a$12$952CXRCtzm0M4qmcFoZkteQvA5Tdh.CIhvCabrgb5qUbk.VcE35va";
  const compare = async (password: string, passwordHash: string) =>
    passwordHash === dummyHash
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

  /** A browser's cookie jar for the known-device cookie. */
  type Browser = { cookie: string | null };
  const newBrowser = (): Browser => ({ cookie: null });

  async function signIn(
    email: string,
    password: string,
    headers: Record<string, string>,
    browser?: Browser,
  ): Promise<string> {
    try {
      const user = await authorize(
        { email, password },
        {
          headers: browser?.cookie
            ? { ...headers, cookie: browser.cookie }
            : headers,
        },
      );
      if (user && browser) {
        const set = mocks.setCookie.mock.calls.at(-1) as [string, string];
        browser.cookie = `${set[0]}=${set[1]}`;
      }
      return user ? "ok" : "invalid";
    } catch (err) {
      return loginErrorMessage((err as Error).message);
    }
  }

  async function resetCaller(options: {
    ip: string | null;
    verified: boolean;
    browser?: Browser;
  }) {
    const { authRouter } = await import("../routers/auth");
    const { db } = await import("@openpims/db/client");
    const { knownDeviceCookieFromHeader } = await import("@/lib/known-device");
    return authRouter.createCaller({
      db,
      session: null,
      ip: options.ip,
      verifiedIp: options.verified ? options.ip : null,
      knownDeviceCookie: knownDeviceCookieFromHeader(options.browser?.cookie),
    } as never);
  }

  const LOCKED_1M = "Too many sign-in attempts. Try again in 1 minute.";

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


  it("(A) can't be locked out by spraying with the clinic's forged address on an unconfigured self-host", async () => {
    useSelfHost();
    await clearBuckets();
    const staff = Array.from(
      { length: 10 },
      (_, i) => `forged-clinic-${i}@example.invalid`,
    );
    await addUsers(staff);
    const clinic = { "x-forwarded-for": "203.0.113.10" };

    // The attacker claims the clinic's public address on every request.
    for (let i = 0; i < 1000; i += 1) {
      await expect(
        signIn(`spray-${randomUUID()}@example.invalid`, "Password1", clinic),
      ).resolves.toBe("invalid");
    }
    // Claimed addresses are never limited, so there is nothing to fill.
    expect(await buckets("login:ip")).toEqual([]);

    // Every staff member signs in from the clinic, with or without a
    // forwarded address.
    for (const email of staff) {
      await expect(signIn(email, PASSWORD, clinic)).resolves.toBe("ok");
    }
    await expect(signIn(staff[0]!, PASSWORD, {})).resolves.toBe("ok");
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
      ).resolves.toBe(LOCKED_1M);

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
    expect(await buckets("login:ip-day:")).toEqual([]);
    expect(await buckets("login:account:nat-staff-")).toEqual([]);

    // Many more successes leave the failure budget untouched.
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

  it("(B) a guest on the clinic's Wi-Fi can't lock out staff on known devices, and nothing lasts a day", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const clinic = { "x-vercel-forwarded-for": "198.51.100.20" };
      const staff = ["wifi-a@example.invalid", "wifi-b@example.invalid"];
      await addUsers([...staff, "wifi-new@example.invalid"]);
      const browsers = staff.map(() => newBrowser());
      for (const [i, email] of staff.entries()) {
        await expect(signIn(email, PASSWORD, clinic, browsers[i])).resolves.toBe(
          "ok",
        );
      }

      // Same public IP: lock each staff account, then spray random accounts
      // and hammer until every per-IP limit is spent.
      for (const email of staff) {
        for (let i = 0; i < 6; i += 1) await signIn(email, "wrong", clinic);
      }
      const results: string[] = [];
      for (let i = 0; i < 620; i += 1) {
        results.push(
          await signIn(`guest-${i}@example.invalid`, "Password1", clinic),
        );
      }
      expect(results.at(-1)).toBe(
        "Too many sign-in attempts. Try again in 15 minutes.",
      );
      expect(await bucketCount("login:ip:198.51.100.20")).toBeGreaterThan(50);
      expect(await bucketCount("login:ip-req:198.51.100.20")).toBeGreaterThan(600);

      // Staff on their usual browsers get straight in.
      for (const [i, email] of staff.entries()) {
        await expect(signIn(email, PASSWORD, clinic, browsers[i])).resolves.toBe(
          "ok",
        );
      }
      // Someone on a new device is held for at most the 15-minute window,
      // never a day: there is no daily per-IP bucket.
      expect(await buckets("login:ip-day:")).toEqual([]);
      await expect(
        signIn("wifi-new@example.invalid", PASSWORD, clinic, newBrowser()),
      ).resolves.toBe("Too many sign-in attempts. Try again in 15 minutes.");
      vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1000);
      await expect(
        signIn("wifi-new@example.invalid", PASSWORD, clinic, newBrowser()),
      ).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);

  it("(C) gives the same answers whatever address is claimed, so there's no oracle", async () => {
    useSelfHost();
    await clearBuckets();
    await addUsers(["oracle@example.invalid"]);
    const owner = newBrowser();
    const home = { "x-forwarded-for": "203.0.113.50" };
    await expect(
      signIn("oracle@example.invalid", PASSWORD, home, owner),
    ).resolves.toBe("ok");

    const { clearLoginAccountLock } = await import("@/lib/login-throttle");
    async function probe(headers: Record<string, string>) {
      await clearLoginAccountLock("oracle@example.invalid");
      const answers: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        answers.push(await signIn("oracle@example.invalid", "wrong", headers));
      }
      answers.push(await signIn("oracle@example.invalid", PASSWORD, headers));
      return answers;
    }
    const fromOwnersAddress = await probe(home);
    const fromElsewhere = await probe({ "x-forwarded-for": "192.0.2.123" });
    const fromNowhere = await probe({});
    expect(fromOwnersAddress).toEqual(fromElsewhere);
    expect(fromOwnersAddress).toEqual(fromNowhere);
    expect(fromOwnersAddress).toEqual([
      ...Array(5).fill("invalid"),
      ...Array(4).fill(LOCKED_1M),
    ]);
    // Forging the owner's address didn't lock the owner's browser out either.
    await expect(
      signIn("oracle@example.invalid", PASSWORD, home, owner),
    ).resolves.toBe("ok");
  }, 60_000);

  it("lets a known device in during an account-wide lock, but not a new one", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    await addUsers(["known@example.invalid"]);
    const owner = newBrowser();
    const from = (ip: string) => ({ "x-vercel-forwarded-for": ip });
    await expect(
      signIn("known@example.invalid", PASSWORD, from("203.0.113.20"), owner),
    ).resolves.toBe("ok");
    expect(owner.cookie).toMatch(/^__Host-openvpm-device=/);

    // An attacker rotates addresses and keeps the account-wide lock engaged.
    for (let i = 0; i < 20; i += 1) {
      await signIn("known@example.invalid", "wrong", from(`192.0.2.${i + 1}`));
    }
    await expect(
      signIn("known@example.invalid", "wrong", from("192.0.2.100")),
    ).resolves.toMatch(/^Too many sign-in attempts/);

    // The owner's browser gets in from anywhere, repeatedly, without
    // resetting the attacker's backoff.
    for (const ip of ["203.0.113.20", "198.51.100.200", "192.0.2.1"]) {
      await expect(
        signIn("known@example.invalid", PASSWORD, from(ip), owner),
      ).resolves.toBe("ok");
    }
    expect(await bucketCount("login:account:known@example.invalid")).toBe(5);

    // The correct password on a new device is still held by the lock.
    await expect(
      signIn("known@example.invalid", PASSWORD, from("203.0.113.20"), newBrowser()),
    ).resolves.toBe(LOCKED_1M);

    // Guessing from the known device has its own backoff.
    for (let i = 0; i < 5; i += 1) {
      await expect(
        signIn("known@example.invalid", "wrong", from("203.0.113.20"), owner),
      ).resolves.toBe("invalid");
    }
    await expect(
      signIn("known@example.invalid", PASSWORD, from("203.0.113.20"), owner),
    ).resolves.toBe(LOCKED_1M);
    expect(await buckets("login:account-dev:")).toHaveLength(1);
  }, 60_000);

  it("rejects forged, expired, and other accounts' device cookies", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    await addUsers(["cookie-a@example.invalid", "cookie-b@example.invalid"]);
    const at = { "x-vercel-forwarded-for": "203.0.113.70" };
    const a = newBrowser();
    const b = newBrowser();
    await signIn("cookie-a@example.invalid", PASSWORD, at, a);
    await signIn("cookie-b@example.invalid", PASSWORD, at, b);
    for (let i = 0; i < 6; i += 1) {
      await signIn("cookie-a@example.invalid", "wrong", {
        "x-vercel-forwarded-for": `192.0.2.${i + 1}`,
      });
    }

    const { issueKnownDeviceCookie } = await import("@/lib/known-device");
    const [name, value] = a.cookie!.split("=") as [string, string];
    const [body, signature] = value.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.d = "A".repeat(22);
    const reSigned = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    const expired = issueKnownDeviceCookie(
      null,
      "cookie-a@example.invalid",
      new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
    )!;
    process.env.NEXTAUTH_SECRET = "some-other-deployment-secret-32-characters";
    const wrongKey = issueKnownDeviceCookie(null, "cookie-a@example.invalid")!;
    process.env.NEXTAUTH_SECRET = "integration-secret-at-least-32-characters";

    for (const cookie of [
      b.cookie!, // another account's valid cookie
      `${name}=${reSigned}`, // edited payload, old signature
      `${name}=${expired.value}`,
      `${name}=${wrongKey.value}`,
      `${name}=not-a-cookie`,
    ]) {
      await expect(
        signIn("cookie-a@example.invalid", PASSWORD, at, { cookie }),
        cookie,
      ).resolves.toBe(LOCKED_1M);
    }
    await expect(
      signIn("cookie-a@example.invalid", PASSWORD, at, a),
    ).resolves.toBe("ok");
  }, 60_000);

  it("holds 40 parallel guesses to the 5 free failures, with or without a device cookie", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    await addUsers(["parallel@example.invalid", "parallel-dev@example.invalid"]);
    const at = { "x-vercel-forwarded-for": "203.0.113.80" };

    const unknown = await Promise.all(
      Array.from({ length: 40 }, () =>
        signIn("parallel@example.invalid", "wrong", at),
      ),
    );
    expect(unknown.filter((r) => r === "invalid")).toHaveLength(5);
    expect(unknown.filter((r) => r.startsWith("Too many"))).toHaveLength(35);

    const device = newBrowser();
    await signIn("parallel-dev@example.invalid", PASSWORD, at, device);
    const known = await Promise.all(
      Array.from({ length: 40 }, () =>
        signIn("parallel-dev@example.invalid", "wrong", at, { ...device }),
      ),
    );
    expect(known.filter((r) => r === "invalid")).toHaveLength(5);
    expect(known.filter((r) => r.startsWith("Too many"))).toHaveLength(35);
  }, 60_000);

  it("bounds IPv6 reset flooding and keeps the owner's own reset working", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    mocks.sendPasswordResetEmail.mockClear();
    await addUsers(["reset6@example.invalid"]);
    const owner = newBrowser();
    await signIn("reset6@example.invalid", PASSWORD, {
      "x-vercel-forwarded-for": "2001:db8:aa:1::10",
    }, owner);

    // Rotating addresses inside one /64 shares one bucket.
    let accepted = 0;
    for (let i = 0; i < 30; i += 1) {
      const caller = await resetCaller({
        ip: `2001:db8:bad:1::${(i + 1).toString(16)}`,
        verified: true,
      });
      try {
        await caller.requestPasswordReset({ email: "reset6@example.invalid" });
        accepted += 1;
      } catch (err) {
        expect(err).toMatchObject({ code: "TOO_MANY_REQUESTS" });
      }
    }
    expect(accepted).toBe(5);

    // Rotating /64s runs into the per-address daily cap.
    for (let i = 0; i < 60; i += 1) {
      const caller = await resetCaller({
        ip: `2001:db8:bad:${(i + 2).toString(16)}::1`,
        verified: true,
      });
      await caller
        .requestPasswordReset({ email: "reset6@example.invalid" })
        .then(() => {
          accepted += 1;
        })
        .catch((err) => expect(err).toMatchObject({ code: "TOO_MANY_REQUESTS" }));
    }
    expect(accepted).toBe(20);
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(20);
    expect(await buckets("pwreset:reset6@example.invalid:net:2001:db8:bad:1::/64")).toHaveLength(1);

    // A browser without the device cookie is held by the cap...
    await expect(
      (await resetCaller({ ip: "2001:db8:aa:1::10", verified: true }))
        .requestPasswordReset({ email: "reset6@example.invalid" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // ...the owner's known browser isn't.
    await expect(
      (await resetCaller({ ip: "2001:db8:aa:1::10", verified: true, browser: owner }))
        .requestPasswordReset({ email: "Reset6@Example.invalid" }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(21);
  }, 60_000);

  it("doesn't key reset limits on claimed or non-public addresses", async () => {
    useSelfHost();
    await clearBuckets();
    mocks.sendPasswordResetEmail.mockClear();
    await addUsers(["reset-claimed@example.invalid"]);
    // Forging the owner's address can't use up their per-network bucket,
    // because a claimed address doesn't get one; only the daily cap applies.
    for (const ip of ["203.0.113.90", "172.18.0.1", null]) {
      for (let i = 0; i < 6; i += 1) {
        await (await resetCaller({ ip, verified: false }))
          .requestPasswordReset({ email: "reset-claimed@example.invalid" });
      }
    }
    expect(await buckets("pwreset:reset-claimed@example.invalid:net:")).toEqual([]);
    expect(await bucketCount("pwreset:reset-claimed@example.invalid:day")).toBe(18);
    await expect(
      (await resetCaller({ ip: "10.0.0.5", verified: true }))
        .requestPasswordReset({ email: "reset-claimed@example.invalid" }),
    ).resolves.toEqual({ ok: true });
    expect(await buckets("pwreset:reset-claimed@example.invalid:net:")).toEqual([]);
  }, 60_000);

  for (const hops of [undefined, "1"]) {
    it(`can't be locked out through nginx that doesn't forward client addresses (hops=${hops ?? "unset"})`, async () => {
      useSelfHost();
      if (hops) process.env.OPENVPM_TRUSTED_PROXY_HOPS = hops;
      await clearBuckets();
      await addUsers([`gateway-${hops ?? "unset"}@example.invalid`]);
      // Without `proxy_set_header X-Forwarded-For`, Next.js fills the header
      // with the Docker gateway nginx connects from, for every client.
      const viaGateway = { "x-forwarded-for": "172.18.0.1" };
      for (let i = 0; i < 1000; i += 1) {
        await expect(
          signIn(`spray-${randomUUID()}@example.invalid`, "Password1", viaGateway),
        ).resolves.toBe("invalid");
      }
      expect(await buckets("login:ip")).toEqual([]);
      await expect(
        signIn(`gateway-${hops ?? "unset"}@example.invalid`, PASSWORD, viaGateway),
      ).resolves.toBe("ok");
    }, 120_000);
  }

  it("makes the browser that completes a password reset a known device", async () => {
    process.env.VERCEL = "1";
    await clearBuckets();
    mocks.sendPasswordResetEmail.mockClear();
    mocks.setCookie.mockClear();
    await addUsers(["reset-device@example.invalid"]);
    const from = (ip: string) => ({ "x-vercel-forwarded-for": ip });
    const lockFromElsewhere = async () => {
      for (let i = 0; i < 20; i += 1) {
        await signIn("reset-device@example.invalid", "wrong", from(`192.0.2.${i + 1}`));
      }
    };
    await lockFromElsewhere();

    // The owner resets from a browser that has never signed in.
    await (await resetCaller({ ip: "203.0.113.40", verified: true }))
      .requestPasswordReset({ email: "reset-device@example.invalid" });
    const [[{ resetUrl }]] = mocks.sendPasswordResetEmail.mock.calls as unknown as [
      [{ resetUrl: string }],
    ];
    const token = new URL(resetUrl).searchParams.get("token")!;
    await (await resetCaller({ ip: "203.0.113.40", verified: true })).resetPassword({
      token,
      password: PASSWORD,
    });
    const [name, value] = mocks.setCookie.mock.calls.at(-1) as [string, string];
    const owner: Browser = { cookie: `${name}=${value}` };

    // Guessing resumes and locks the account again; the owner's browser is
    // let through, another new browser isn't.
    await lockFromElsewhere();
    await expect(
      signIn("reset-device@example.invalid", PASSWORD, from("203.0.113.40"), newBrowser()),
    ).resolves.toBe(LOCKED_1M);
    await expect(
      signIn("reset-device@example.invalid", PASSWORD, from("203.0.113.40"), owner),
    ).resolves.toBe("ok");
  }, 60_000);

  it("prunes expired limit records without a scheduler", async () => {
    useSelfHost();
    await clearBuckets();
    await ownerDb.insert(schema.rateLimitBuckets).values({
      key: "login:account:stale@example.invalid",
      count: 3,
      resetAt: new Date(Date.now() - 60_000),
    });
    const { cleanupRateLimitsOccasionally } = await import("@/lib/login-throttle");
    cleanupRateLimitsOccasionally(new Date(Date.now() + 2 * 60 * 60 * 1000));
    let left = await buckets("login:account:stale@");
    for (let i = 0; i < 50 && left.length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      left = await buckets("login:account:stale@");
    }
    expect(left).toEqual([]);
  }, 60_000);

  it("lets an admin clear a staff member's sign-in lock and device streaks, with an audit entry", async () => {
    useSelfHost();
    await clearBuckets();
    const [adminUser] = await ownerDb
      .insert(schema.users)
      .values({
        practiceId,
        email: "unlock-admin@example.invalid",
        passwordHash: await hash(PASSWORD, 4),
        name: "Synthetic Admin",
        role: "admin",
      })
      .returning();
    await addUsers(["locked-out@example.invalid"]);
    const [target] = await ownerDb
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(like(schema.users.email, "locked-out@example.invalid"));
    const device = newBrowser();
    await signIn("locked-out@example.invalid", PASSWORD, {}, device);
    for (let i = 0; i < 6; i += 1) {
      await signIn("locked-out@example.invalid", "wrong", {});
      await signIn("locked-out@example.invalid", "wrong", {}, device);
    }
    await expect(
      signIn("locked-out@example.invalid", PASSWORD, {}),
    ).resolves.toMatch(/^Too many sign-in attempts/);
    await expect(
      signIn("locked-out@example.invalid", PASSWORD, {}, device),
    ).resolves.toMatch(/^Too many sign-in attempts/);

    const { appRouter } = await import("../routers/_app");
    const { db } = await import("@openpims/db/client");
    const session = (role: string) => ({
      user: {
        id: adminUser!.id,
        email: adminUser!.email,
        name: adminUser!.name,
        role,
        practiceId,
      },
    });
    const caller = (role: string) =>
      appRouter.createCaller({ db, session: session(role), ip: "203.0.113.41" } as never)
        .settings;

    await expect(
      caller("veterinarian").clearStaffSignInLock({ id: target!.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const locks = await caller("admin").staffSignInLocks();
    expect(locks.map((lock) => lock.userId)).toEqual([target!.id]);
    await expect(
      caller("admin").clearStaffSignInLock({ id: target!.id }),
    ).resolves.toEqual({ id: target!.id });
    await expect(caller("admin").staffSignInLocks()).resolves.toEqual([]);
    expect(await buckets("login:account-dev:")).toEqual([]);
    await expect(
      signIn("locked-out@example.invalid", PASSWORD, {}),
    ).resolves.toBe("ok");
    await expect(
      signIn("locked-out@example.invalid", PASSWORD, {}, device),
    ).resolves.toBe("ok");

    // The audit entry is written after the response; wait for it briefly.
    let audit: { entityType: string; action: string; entityId: string | null; userId: string | null }[] = [];
    for (let i = 0; i < 50 && audit.length === 0; i += 1) {
      audit = await ownerDb
        .select({
          entityType: schema.auditLog.entityType,
          action: schema.auditLog.action,
          entityId: schema.auditLog.entityId,
          userId: schema.auditLog.userId,
        })
        .from(schema.auditLog)
        .where(like(schema.auditLog.action, "clearStaffSignInLock"));
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit).toEqual([
      {
        entityType: "settings",
        action: "clearStaffSignInLock",
        entityId: target!.id,
        userId: adminUser!.id,
      },
    ]);
  }, 60_000);
});
