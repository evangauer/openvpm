import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { practices, users } from "@openpims/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";
import { clearRateLimit, rateLimit } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { nextAuthSecret } from "@/lib/auth-secret";
import { AUTH_SESSION_MAX_AGE_SECONDS } from "@/lib/auth-session-policy";
import {
  consumeRecoveryCodeHash,
  decryptMfaSecret,
  matchingTotpCounter,
  mfaEncryptionConfigured,
} from "@/lib/mfa";
import {
  DEMO_ROLE_EMAILS,
  demoModeEnabled,
  isDemoRole,
  verifiedDemoAccessFromRequest,
} from "@/lib/demo-access";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_EMAIL_LIMIT = 8;
const LOGIN_IP_LIMIT = 40;
export { AUTH_SESSION_MAX_AGE_SECONDS } from "@/lib/auth-session-policy";
export const LOGIN_EMAIL_MAX_LENGTH = AUTH_EMAIL_MAX_LENGTH;
const DUMMY_PASSWORD_HASH =
  "$2a$12$952CXRCtzm0M4qmcFoZkteQvA5Tdh.CIhvCabrgb5qUbk.VcE35va";
const DEMO_PRACTICE_NAME = "Neighborhood Veterinary";

const loginCredentialsInput = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(LOGIN_EMAIL_MAX_LENGTH)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
  mfaCode: z.string().trim().max(64).optional(),
});

export function parseLoginCredentials(
  credentials:
    | (Record<"email" | "password", string> &
        Partial<Record<"mfaCode", string>>)
    | undefined,
): { email: string; password: string; mfaCode?: string } | null {
  const parsed = loginCredentialsInput.safeParse(credentials);
  return parsed.success ? parsed.data : null;
}

export const clientIpFromAuthRequest = clientIpFromRequest;

export function loginRateLimitKeys(email: string, ip: string): {
  emailKey: string;
  ipKey: string;
} {
  return {
    emailKey: `login:email:${email.trim().toLowerCase()}`,
    ipKey: `login:ip:${ip || "unknown"}`,
  };
}

/**
 * NextAuth intentionally normalizes CredentialsProvider failures to
 * `CredentialsSignin`. After a failed first-factor sign-in, the login page can
 * call this same-origin helper to distinguish an invalid password from an MFA
 * challenge without revealing whether an arbitrary email exists.
 */
export async function validCredentialsRequireMfa(input: {
  email: string;
  password: string;
  ip: string;
}): Promise<boolean> {
  const parsed = parseLoginCredentials({
    email: input.email,
    password: input.password,
  });
  if (!parsed) return false;

  try {
    const { success } = await rateLimit({
      key: `login:mfa-probe:${parsed.email}:${input.ip || "unknown"}`,
      limit: LOGIN_EMAIL_LIMIT,
      windowMs: LOGIN_WINDOW_MS,
    });
    if (!success) return false;
  } catch {
    return false;
  }

  const [user] = await withSystem(db, (tx) =>
    tx
      .select({
        passwordHash: users.passwordHash,
        mfaEnabledAt: users.mfaEnabledAt,
        mfaSecretEncrypted: users.mfaSecretEncrypted,
      })
      .from(users)
      .where(and(eq(users.email, parsed.email), isNull(users.deletedAt)))
      .limit(1),
  );
  if (!user) {
    await compare(parsed.password, DUMMY_PASSWORD_HASH);
    return false;
  }
  const valid = await compare(parsed.password, user.passwordHash);
  return Boolean(
    valid &&
      user.mfaEnabledAt &&
      user.mfaSecretEncrypted &&
      mfaEncryptionConfigured(),
  );
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
      practiceId: string;
      sessionVersion: number;
      emailVerifiedAt?: Date | string | null;
      practiceCreatedAt?: Date | string | null;
    };
  }
  interface User {
    id: string;
    email: string;
    name: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
    sessionVersion: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
    sessionVersion: number;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        mfaCode: { label: "Authentication code", type: "text" },
      },
      async authorize(credentials, req) {
        // The hosted demo uses its own signed email gate. Never leave the
        // seeded password accounts as a bypass on that deployment.
        if (demoModeEnabled()) return null;

        const parsedCredentials = parseLoginCredentials(credentials);
        if (!parsedCredentials) {
          return null;
        }
        const { email, password, mfaCode } = parsedCredentials;
        const ip = clientIpFromAuthRequest(req);
        const { emailKey, ipKey } = loginRateLimitKeys(email, ip);

        let emailLimit: Awaited<ReturnType<typeof rateLimit>>;
        let ipLimit: Awaited<ReturnType<typeof rateLimit>>;
        try {
          [emailLimit, ipLimit] = await Promise.all([
            rateLimit({
              key: emailKey,
              limit: LOGIN_EMAIL_LIMIT,
              windowMs: LOGIN_WINDOW_MS,
            }),
            rateLimit({
              key: ipKey,
              limit: LOGIN_IP_LIMIT,
              windowMs: LOGIN_WINDOW_MS,
            }),
          ]);
        } catch (err) {
          console.error("[auth] login rate limit failed:", err);
          return null;
        }

        if (!emailLimit.success || !ipLimit.success) {
          return null;
        }

        // Login looks up by email with no tenant context yet → system context.
        const [user] = await withSystem(db, (tx) =>
          tx
            .select()
            .from(users)
            .where(and(eq(users.email, email), isNull(users.deletedAt)))
            .limit(1)
        );

        if (!user) {
          await compare(password, DUMMY_PASSWORD_HASH);
          return null;
        }

        const isValid = await compare(password, user.passwordHash);
        if (!isValid) return null;

        const mfaResult = await verifyLoginMfa(user, mfaCode);
        if (mfaResult === "required") throw new Error("MFA_REQUIRED");
        if (mfaResult !== "accepted") throw new Error("MFA_INVALID");

        await clearRateLimit(emailKey).catch(() => undefined);

        // Email verification is a SOFT requirement on hosted: new users sign in
        // immediately after signup (so the trial + onboarding aren't blocked by
        // an email round-trip) and are nudged to confirm via an in-app banner.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
    CredentialsProvider({
      id: "demo",
      name: "demo",
      credentials: {
        role: { label: "Role", type: "text" },
      },
      async authorize(credentials, req) {
        if (
          !demoModeEnabled() ||
          !verifiedDemoAccessFromRequest(req) ||
          !isDemoRole(credentials?.role)
        ) {
          return null;
        }

        const demoEmail = DEMO_ROLE_EMAILS[credentials.role];
        const user = await withSystem(db, async (tx) => {
          const [candidate] = await tx
            .select()
            .from(users)
            .where(
              and(eq(users.email, demoEmail), isNull(users.deletedAt))
            )
            .limit(1);
          if (!candidate) return null;

          const [practice] = await tx
            .select({ id: practices.id })
            .from(practices)
            .where(
              and(
                eq(practices.id, candidate.practiceId),
                eq(practices.name, DEMO_PRACTICE_NAME),
                isNull(practices.deletedAt)
              )
            )
            .limit(1);
          return practice ? candidate : null;
        });

        if (!user) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.practiceId = user.practiceId;
        token.sessionVersion = user.sessionVersion;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.practiceId = token.practiceId;
      session.user.sessionVersion = token.sessionVersion;
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  },
  jwt: {
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  },
  secret: nextAuthSecret(),
};

async function verifyLoginMfa(
  user: typeof users.$inferSelect,
  suppliedCode: string | undefined,
): Promise<"accepted" | "required" | "invalid"> {
  if (!user.mfaEnabledAt) return "accepted";
  const code = suppliedCode?.trim();
  if (!code) return "required";
  if (!user.mfaSecretEncrypted || !mfaEncryptionConfigured()) {
    console.error("[auth] enabled MFA is not decryptable");
    return "invalid";
  }

  try {
    const secret = decryptMfaSecret(user.mfaSecretEncrypted);
    const counter = matchingTotpCounter(secret, code);
    if (counter !== null) {
      const [consumed] = await withSystem(db, (tx) =>
        tx
          .update(users)
          .set({ mfaLastUsedTotpCounter: counter })
          .where(
            and(
              eq(users.id, user.id),
              eq(users.sessionVersion, user.sessionVersion),
              isNull(users.deletedAt),
              sql`(${users.mfaLastUsedTotpCounter} is null or ${users.mfaLastUsedTotpCounter} < ${counter})`,
            ),
          )
          .returning({ id: users.id }),
      );
      return consumed ? "accepted" : "invalid";
    }

    const storedHashes = Array.isArray(user.mfaRecoveryCodeHashes)
      ? user.mfaRecoveryCodeHashes
      : [];
    const recovery = consumeRecoveryCodeHash(storedHashes, code);
    if (!recovery.accepted) return "invalid";
    const [consumed] = await withSystem(db, (tx) =>
      tx
        .update(users)
        .set({ mfaRecoveryCodeHashes: recovery.remaining })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.sessionVersion, user.sessionVersion),
            isNull(users.deletedAt),
            sql`${users.mfaRecoveryCodeHashes} = ${JSON.stringify(storedHashes)}::jsonb`,
          ),
        )
        .returning({ id: users.id }),
    );
    return consumed ? "accepted" : "invalid";
  } catch {
    console.error("[auth] MFA verification failed");
    return "invalid";
  }
}
