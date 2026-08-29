import { compare } from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { practices, users } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import {
  consumeRecoveryCodeHash,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchingTotpCounter,
  mfaEncryptionConfigured,
  totpProvisioningUri,
} from "@/lib/mfa";
import { rateLimit } from "@/lib/rate-limit";
import { createRouter, protectedProcedure } from "../trpc";

const MFA_ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const currentPasswordInput = z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH);
const mfaCodeInput = z.string().trim().min(6).max(64);

async function readMfaUser(
  database: Database,
  userId: string,
  practiceId: string,
) {
  const [user] = await database
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      sessionVersion: users.sessionVersion,
      mfaSecretEncrypted: users.mfaSecretEncrypted,
      mfaEnabledAt: users.mfaEnabledAt,
      mfaLastUsedTotpCounter: users.mfaLastUsedTotpCounter,
      mfaRecoveryCodeHashes: users.mfaRecoveryCodeHashes,
      mfaPendingSecretEncrypted: users.mfaPendingSecretEncrypted,
      mfaPendingExpiresAt: users.mfaPendingExpiresAt,
      practiceName: practices.name,
    })
    .from(users)
    .innerJoin(
      practices,
      and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
    )
    .where(
      and(
        eq(users.id, userId),
        eq(users.practiceId, practiceId),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return user ?? null;
}

async function requireCurrentPassword(input: {
  database: Database;
  userId: string;
  practiceId: string;
  password: string;
  ip?: string | null;
}) {
  try {
    const limited = await rateLimit({
      key: `mfa-password:${input.userId}:${input.ip || "unknown"}`,
      limit: 8,
      windowMs: 15 * 60 * 1_000,
    });
    if (!limited.success) throw new Error("rate limited");
  } catch {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many verification attempts. Please try again later.",
    });
  }

  const user = await readMfaUser(
    input.database,
    input.userId,
    input.practiceId,
  );
  if (!user || !(await compare(input.password, user.passwordHash))) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "The current password was not accepted.",
    });
  }
  return user;
}

function activeFactor(
  user: NonNullable<Awaited<ReturnType<typeof readMfaUser>>>,
  code: string,
):
  | { type: "totp"; counter: number }
  | { type: "recovery"; remaining: string[]; prior: string[] }
  | null {
  if (!user.mfaEnabledAt || !user.mfaSecretEncrypted) return null;
  const secret = decryptMfaSecret(user.mfaSecretEncrypted);
  const counter = matchingTotpCounter(secret, code);
  if (
    counter !== null &&
    (user.mfaLastUsedTotpCounter === null ||
      counter > user.mfaLastUsedTotpCounter)
  ) {
    return { type: "totp", counter };
  }
  const prior = Array.isArray(user.mfaRecoveryCodeHashes)
    ? user.mfaRecoveryCodeHashes
    : [];
  const recovery = consumeRecoveryCodeHash(prior, code);
  return recovery.accepted
    ? { type: "recovery", remaining: recovery.remaining, prior }
    : null;
}

function factorGuard(factor: NonNullable<ReturnType<typeof activeFactor>>) {
  return factor.type === "totp"
    ? sql`(${users.mfaLastUsedTotpCounter} is null or ${users.mfaLastUsedTotpCounter} < ${factor.counter})`
    : sql`${users.mfaRecoveryCodeHashes} = ${JSON.stringify(factor.prior)}::jsonb`;
}

export const mfaRouter = createRouter({
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = await readMfaUser(ctx.db, ctx.user.id, ctx.practiceId);
    if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
    return {
      available: mfaEncryptionConfigured(),
      enabled: Boolean(user.mfaEnabledAt && user.mfaSecretEncrypted),
      enabledAt: user.mfaEnabledAt,
      recoveryCodesRemaining: Array.isArray(user.mfaRecoveryCodeHashes)
        ? user.mfaRecoveryCodeHashes.length
        : 0,
      enrollmentPending: Boolean(
        user.mfaPendingSecretEncrypted &&
        user.mfaPendingExpiresAt &&
        user.mfaPendingExpiresAt > new Date(),
      ),
    };
  }),

  beginEnrollment: protectedProcedure
    .input(z.object({ password: currentPasswordInput }))
    .mutation(async ({ ctx, input }) => {
      if (!mfaEncryptionConfigured()) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message:
            "Two-step verification is not configured on this deployment.",
        });
      }
      const user = await requireCurrentPassword({
        database: ctx.db,
        userId: ctx.user.id,
        practiceId: ctx.practiceId,
        password: input.password,
        ip: ctx.ip,
      });
      if (user.mfaEnabledAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Two-step verification is already enabled.",
        });
      }

      const secret = generateTotpSecret();
      const expiresAt = new Date(Date.now() + MFA_ENROLLMENT_TTL_MS);
      const [updated] = await ctx.db
        .update(users)
        .set({
          mfaPendingSecretEncrypted: encryptMfaSecret(secret),
          mfaPendingExpiresAt: expiresAt,
        })
        .where(
          and(
            eq(users.id, ctx.user.id),
            eq(users.practiceId, ctx.practiceId),
            eq(users.sessionVersion, user.sessionVersion),
            isNull(users.deletedAt),
          ),
        )
        .returning({ id: users.id });
      if (!updated) throw new TRPCError({ code: "UNAUTHORIZED" });
      return {
        secret,
        provisioningUri: totpProvisioningUri({
          secret,
          email: user.email,
          practiceName: user.practiceName,
        }),
        expiresAt,
      };
    }),

  confirmEnrollment: protectedProcedure
    .input(z.object({ code: mfaCodeInput.regex(/^\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      if (!mfaEncryptionConfigured()) {
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
      }
      const user = await readMfaUser(ctx.db, ctx.user.id, ctx.practiceId);
      if (
        !user?.mfaPendingSecretEncrypted ||
        !user.mfaPendingExpiresAt ||
        user.mfaPendingExpiresAt <= new Date()
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This setup expired. Start two-step verification again.",
        });
      }
      let counter: number | null = null;
      try {
        counter = matchingTotpCounter(
          decryptMfaSecret(user.mfaPendingSecretEncrypted),
          input.code,
        );
      } catch {
        counter = null;
      }
      if (counter === null) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "That authentication code was not accepted.",
        });
      }

      const recoveryCodes = generateRecoveryCodes();
      const [updated] = await ctx.db
        .update(users)
        .set({
          mfaSecretEncrypted: user.mfaPendingSecretEncrypted,
          mfaEnabledAt: new Date(),
          mfaLastUsedTotpCounter: counter,
          mfaRecoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
          mfaPendingSecretEncrypted: null,
          mfaPendingExpiresAt: null,
          sessionVersion: sql`${users.sessionVersion} + 1`,
        })
        .where(
          and(
            eq(users.id, ctx.user.id),
            eq(users.practiceId, ctx.practiceId),
            eq(users.sessionVersion, user.sessionVersion),
            eq(users.mfaPendingSecretEncrypted, user.mfaPendingSecretEncrypted),
            isNull(users.deletedAt),
          ),
        )
        .returning({ id: users.id });
      if (!updated) throw new TRPCError({ code: "UNAUTHORIZED" });
      return { recoveryCodes, sessionRevoked: true };
    }),

  regenerateRecoveryCodes: protectedProcedure
    .input(z.object({ password: currentPasswordInput, code: mfaCodeInput }))
    .mutation(async ({ ctx, input }) => {
      const user = await requireCurrentPassword({
        database: ctx.db,
        userId: ctx.user.id,
        practiceId: ctx.practiceId,
        password: input.password,
        ip: ctx.ip,
      });
      let factor: ReturnType<typeof activeFactor> = null;
      try {
        factor = activeFactor(user, input.code);
      } catch {
        factor = null;
      }
      if (!factor) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "The authentication code was not accepted.",
        });
      }
      const recoveryCodes = generateRecoveryCodes();
      const [updated] = await ctx.db
        .update(users)
        .set({
          mfaRecoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
          ...(factor.type === "totp"
            ? { mfaLastUsedTotpCounter: factor.counter }
            : {}),
          sessionVersion: sql`${users.sessionVersion} + 1`,
        })
        .where(
          and(
            eq(users.id, ctx.user.id),
            eq(users.practiceId, ctx.practiceId),
            eq(users.sessionVersion, user.sessionVersion),
            factorGuard(factor),
            isNull(users.deletedAt),
          ),
        )
        .returning({ id: users.id });
      if (!updated) throw new TRPCError({ code: "UNAUTHORIZED" });
      return { recoveryCodes, sessionRevoked: true };
    }),

  disable: protectedProcedure
    .input(z.object({ password: currentPasswordInput, code: mfaCodeInput }))
    .mutation(async ({ ctx, input }) => {
      const user = await requireCurrentPassword({
        database: ctx.db,
        userId: ctx.user.id,
        practiceId: ctx.practiceId,
        password: input.password,
        ip: ctx.ip,
      });
      let factor: ReturnType<typeof activeFactor> = null;
      try {
        factor = activeFactor(user, input.code);
      } catch {
        factor = null;
      }
      if (!factor) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "The authentication code was not accepted.",
        });
      }
      const [updated] = await ctx.db
        .update(users)
        .set({
          mfaSecretEncrypted: null,
          mfaEnabledAt: null,
          mfaLastUsedTotpCounter: null,
          mfaRecoveryCodeHashes: null,
          mfaPendingSecretEncrypted: null,
          mfaPendingExpiresAt: null,
          sessionVersion: sql`${users.sessionVersion} + 1`,
        })
        .where(
          and(
            eq(users.id, ctx.user.id),
            eq(users.practiceId, ctx.practiceId),
            eq(users.sessionVersion, user.sessionVersion),
            factorGuard(factor),
            isNull(users.deletedAt),
          ),
        )
        .returning({ id: users.id });
      if (!updated) throw new TRPCError({ code: "UNAUTHORIZED" });
      return { ok: true, sessionRevoked: true };
    }),
});
