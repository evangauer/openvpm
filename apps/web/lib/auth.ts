import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { practices, users } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";
import { rateLimitRetryAfterSeconds } from "@/lib/rate-limit";
import { resolveClientIp } from "@/lib/request-ip";
import {
  cleanupRateLimitsOccasionally,
  loginIpBucket,
  loginThrottleKeys,
  recordLoginFailure,
  releaseLoginAttempt,
  reserveLoginAttempt,
  warnUnverifiedLoginIpOnce,
  type LoginAttemptGate,
} from "@/lib/login-throttle";
import { loginRateLimitedErrorCode } from "@/lib/login-error-message";
import {
  knownDeviceCookieFromHeader,
  knownDeviceForAccount,
  rememberKnownDevice,
} from "@/lib/known-device";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { nextAuthSecret } from "@/lib/auth-secret";
import {
  DEMO_ROLE_EMAILS,
  demoModeEnabled,
  isDemoRole,
  verifiedDemoAccessFromRequest,
} from "@/lib/demo-access";

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
});

function cookieHeader(headers: unknown): string | null {
  const value = (headers as Record<string, string | string[] | undefined> | undefined)
    ?.cookie;
  return Array.isArray(value) ? value.join("; ") : (value ?? null);
}

export function parseLoginCredentials(
  credentials: Record<"email" | "password", string> | undefined
): { email: string; password: string } | null {
  const parsed = loginCredentialsInput.safeParse(credentials);
  return parsed.success ? parsed.data : null;
}


declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
      practiceId: string;
      /** Identity generation the session was issued for (users.session_version). */
      sessionVersion?: number;
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
    // Display hint only. Server authorization re-reads the role from the
    // database on every request.
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
    /** Absent on sessions issued before versioning; treated as the default. */
    sessionVersion?: number;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        // The hosted demo uses its own signed email gate. Never leave the
        // seeded password accounts as a bypass on that deployment.
        if (demoModeEnabled()) return null;

        const parsedCredentials = parseLoginCredentials(credentials);
        if (!parsedCredentials) {
          return null;
        }
        const { email, password } = parsedCredentials;
        const client = resolveClientIp(req);
        warnUnverifiedLoginIpOnce(client);
        cleanupRateLimitsOccasionally();
        const deviceCookie = knownDeviceCookieFromHeader(
          cookieHeader(req?.headers)
        );
        const knownDevice = knownDeviceForAccount(deviceCookie, email);
        const throttleKeys = loginThrottleKeys(
          email,
          loginIpBucket(client),
          knownDevice?.deviceId ?? null
        );

        // Budget is reserved before the password check and given back on
        // success, so only failed attempts count.
        let gate: LoginAttemptGate;
        try {
          gate = await reserveLoginAttempt(throttleKeys);
        } catch (err) {
          console.error("[auth] login rate limit failed:", err);
          return null;
        }

        if (!gate.allowed) {
          // Same response whether or not the account exists. NextAuth hands
          // the message to signIn() as `error`; the login page renders it.
          throw new Error(
            loginRateLimitedErrorCode(rateLimitRetryAfterSeconds(gate.retryAt))
          );
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
          await recordLoginFailure(throttleKeys, gate);
          return null;
        }

        const isValid = await compare(password, user.passwordHash);
        if (!isValid) {
          await recordLoginFailure(throttleKeys, gate);
          return null;
        }

        await releaseLoginAttempt(throttleKeys, gate);
        await rememberKnownDevice(deviceCookie, email);

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
  },
  secret: nextAuthSecret(),
};
