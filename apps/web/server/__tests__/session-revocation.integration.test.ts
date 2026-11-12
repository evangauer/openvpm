import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hash } from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import type { Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";

const mocks = vi.hoisted(() => ({
  currentSession: null as unknown,
  setCookie: vi.fn(),
}));

// Route handlers read the session cookie through NextAuth; here the decoded
// session is supplied directly so each request presents a chosen JWT.
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth")>()),
  getServerSession: vi.fn(async () => mocks.currentSession),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.setCookie }),
}));

const integration =
  process.env.SESSION_REVOCATION_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

type Authorize = (
  credentials: Record<"email" | "password", string>,
  req: { headers: Record<string, string> },
) => Promise<User | null>;

const PASSWORD = "correct-horse-battery";

integration("Staff session revocation PostgreSQL contract", () => {
  const adminUrl = process.env.DATABASE_URL;
  const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD;
  const databaseName = `openpims_session_revocation_${randomUUID().replaceAll("-", "")}`;
  const originalEnv = { ...process.env };
  let admin: ReturnType<typeof postgres>;
  let owner: ReturnType<typeof postgres> | undefined;
  let ownerDb: ReturnType<typeof drizzle<typeof schema>>;
  let practiceId: string;
  let authorize: Authorize;

  async function addUser(
    role: (typeof schema.userRoleEnum.enumValues)[number],
  ) {
    const email = `${role}-${randomUUID()}@example.invalid`;
    const [user] = await ownerDb
      .insert(schema.users)
      .values({
        practiceId,
        email,
        passwordHash: await hash(PASSWORD, 4),
        name: "Synthetic Staff",
        role,
        isVeterinarian: role === "veterinarian",
        emailVerifiedAt: new Date(),
      })
      .returning();
    return user!;
  }

  /** Sign in through the real credentials provider and NextAuth callbacks. */
  async function signIn(email: string): Promise<Session> {
    const { authOptions } = await import("@/lib/auth");
    const user = await authorize(
      { email, password: PASSWORD },
      { headers: {} },
    );
    if (!user) throw new Error("sign-in failed");
    const token = (await authOptions.callbacks!.jwt!({
      token: {} as JWT,
      user,
      account: null,
    })) as JWT;
    return authOptions.callbacks!.session!({
      session: { user: { email, name: user.name }, expires: "" } as Session,
      token,
      user,
      newSession: undefined,
      trigger: "update",
    } as never) as Promise<Session>;
  }

  async function callerAs(session: unknown) {
    mocks.currentSession = session;
    const { createTRPCContext } = await import("../trpc");
    const { appRouter } = await import("../routers/_app");
    return appRouter.createCaller(await createTRPCContext());
  }

  async function sessionVersionOf(userId: string) {
    const [row] = await ownerDb
      .select({ sessionVersion: schema.users.sessionVersion })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row!.sessionVersion;
  }

  beforeAll(async () => {
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    if (!appPassword) throw new Error("OPENPIMS_APP_DB_PASSWORD is required");
    if (!/^openpims_session_revocation_[a-f0-9]+$/.test(databaseName))
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
      .values({ name: "Synthetic Session Clinic" })
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }, 120_000);

  afterAll(async () => {
    process.env = originalEnv;
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

  it("carries the account's session version into the signed session", async () => {
    const vet = await addUser("veterinarian");
    const session = await signIn(vet.email);
    expect(session.user.sessionVersion).toBe(1);
    expect(session.user.role).toBe("veterinarian");
  });

  it("applies a role change made outside the app on the very next request", async () => {
    await addUser("admin");
    const target = await addUser("admin");
    const session = await signIn(target.email);
    const before = await callerAs(session);
    await expect(before.settings.deploymentNotices()).resolves.toBeTruthy();

    // No version bump: the database role alone must take effect.
    await ownerDb
      .update(schema.users)
      .set({ role: "viewer" })
      .where(eq(schema.users.id, target.id));

    const after = await callerAs(session);
    await expect(after.settings.deploymentNotices()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      after.settings.updateUser({ id: target.id, name: "Renamed" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Your account has read-only (viewer) access.",
    });
  });

  it("signs a demoted admin out everywhere and keeps unrelated edits harmless", async () => {
    const actor = await signIn((await addUser("admin")).email);
    const target = await addUser("admin");
    const targetSession = await signIn(target.email);

    // A name-only edit leaves the target's sessions alone.
    await (await callerAs(actor)).settings.updateUser({
      id: target.id,
      name: "Still Admin",
    });
    expect(await sessionVersionOf(target.id)).toBe(1);
    // Re-saving the same role is not a role change.
    await (await callerAs(actor)).settings.updateUser({
      id: target.id,
      role: "admin",
    });
    expect(await sessionVersionOf(target.id)).toBe(1);
    await expect(
      (await callerAs(targetSession)).settings.deploymentNotices(),
    ).resolves.toBeTruthy();

    await (await callerAs(actor)).settings.updateUser({
      id: target.id,
      role: "technician",
    });
    expect(await sessionVersionOf(target.id)).toBe(2);
    await expect(
      (await callerAs(targetSession)).settings.deploymentNotices(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Promotion takes the other update path and also revokes.
    await (await callerAs(actor)).settings.updateUser({
      id: target.id,
      role: "admin",
    });
    expect(await sessionVersionOf(target.id)).toBe(3);

    // Signing in again issues a session for the current generation.
    const fresh = await signIn(target.email);
    expect(fresh.user.sessionVersion).toBe(3);
    await expect(
      (await callerAs(fresh)).settings.deploymentNotices(),
    ).resolves.toBeTruthy();
  });

  it("signs the account out everywhere after a password reset", async () => {
    const vet = await addUser("veterinarian");
    const session = await signIn(vet.email);
    await expect(
      (await callerAs(session)).auth.me(),
    ).resolves.toMatchObject({ id: vet.id });

    const { createAuthToken } = await import("@/lib/auth-tokens");
    const { db } = await import("@openpims/db/client");
    const { withSystem } = await import("@/lib/tenant-db");
    const token = await withSystem(db, (tx) =>
      createAuthToken({
        userId: vet.id,
        email: vet.email,
        type: "password_reset",
        db: tx,
      }),
    );
    await (await callerAs(null)).auth.resetPassword({
      token,
      password: "a-brand-new-passphrase",
    });

    expect(await sessionVersionOf(vet.id)).toBe(2);
    await expect((await callerAs(session)).auth.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("does not revive old sessions when a deactivated account is restored", async () => {
    const actor = await signIn((await addUser("admin")).email);
    const tech = await addUser("technician");
    const session = await signIn(tech.email);

    await (await callerAs(actor)).settings.deactivateUser({ id: tech.id });
    await expect((await callerAs(session)).auth.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await (await callerAs(actor)).settings.restoreUser({ id: tech.id });

    expect(await sessionVersionOf(tech.id)).toBe(3);
    await expect((await callerAs(session)).auth.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    // Restoring an account that is already active leaves its sessions alone.
    const current = await signIn(tech.email);
    await (await callerAs(actor)).settings.restoreUser({ id: tech.id });
    expect(await sessionVersionOf(tech.id)).toBe(3);
    await expect((await callerAs(current)).auth.me()).resolves.toMatchObject({
      id: tech.id,
    });
  });

  it("keeps sessions issued before versioning until the account is bumped", async () => {
    const vet = await addUser("veterinarian");
    const { sessionVersion: _omitted, ...legacyUser } = (
      await signIn(vet.email)
    ).user;
    const legacy = { user: legacyUser, expires: "" };

    await expect((await callerAs(legacy)).auth.me()).resolves.toMatchObject({
      id: vet.id,
    });

    await ownerDb
      .update(schema.users)
      .set({ sessionVersion: 2 })
      .where(eq(schema.users.id, vet.id));
    await expect((await callerAs(legacy)).auth.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
