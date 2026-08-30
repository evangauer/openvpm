import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { users, webauthnCredentials } from "@openpims/db";
import {
  activeWebAuthnCredentials,
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
  registrationResponseSchema,
} from "@/lib/webauthn-ceremony";
import {
  passkeyRequiredForIdentity,
  webauthnAdminPolicy,
  webauthnConfiguration,
} from "@/lib/webauthn-config";
import { createRouter, protectedProcedure } from "../trpc";

const credentialName = z.string().trim().min(1).max(80);

function ceremonyError(error: unknown): TRPCError {
  console.error("[passkeys] WebAuthn ceremony failed", error);
  return new TRPCError({
    code: "BAD_REQUEST",
    message:
      "The passkey ceremony could not be verified. Start again and use an authenticator for this OpenVPM site.",
  });
}

export const passkeysRouter = createRouter({
  status: protectedProcedure.query(async ({ ctx }) => {
    const session = ctx.session!;
    const credentials = await activeWebAuthnCredentials(ctx.db, {
      practiceId: session.user.practiceId,
      userId: session.user.id,
    });
    return {
      available: webauthnConfiguration() !== null,
      policy: webauthnAdminPolicy(),
      requiredForIdentity: passkeyRequiredForIdentity(session.user),
      credentials: credentials.map((credential) => ({
        backedUp: credential.backedUp,
        createdAt: credential.createdAt,
        deviceType: credential.deviceType,
        id: credential.id,
        lastUsedAt: credential.lastUsedAt,
        name: credential.name,
      })),
    };
  }),

  beginRegistration: protectedProcedure.mutation(async ({ ctx }) => {
    const session = ctx.session!;
    if (!webauthnConfiguration()) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Passkeys are not configured on this deployment.",
      });
    }
    try {
      return await beginWebAuthnRegistration({
        database: ctx.db,
        identity: {
          email: session.user.email,
          name: session.user.name,
          practiceId: session.user.practiceId,
          sessionVersion: session.user.sessionVersion,
          userId: session.user.id,
        },
      });
    } catch (error) {
      throw ceremonyError(error);
    }
  }),

  confirmRegistration: protectedProcedure
    .input(
      z.object({
        challengeId: z.string().uuid(),
        name: credentialName,
        credentialResponse: registrationResponseSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      try {
        // protectedProcedure turns resolver errors into tRPC results inside its
        // outer tenant transaction. A savepoint ensures the credential insert,
        // challenge consume, and session revocation still commit or roll back
        // as one unit if any later step fails.
        return await ctx.db.transaction(async (tx) => {
          const result = await finishWebAuthnRegistration({
            challengeId: input.challengeId,
            database: tx as unknown as typeof ctx.db,
            identity: {
              email: session.user.email,
              name: session.user.name,
              practiceId: session.user.practiceId,
              sessionVersion: session.user.sessionVersion,
              userId: session.user.id,
            },
            name: input.name,
            response: input.credentialResponse,
          });
          const [revoked] = await tx
            .update(users)
            .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
            .where(
              and(
                eq(users.id, session.user.id),
                eq(users.practiceId, session.user.practiceId),
                eq(users.sessionVersion, session.user.sessionVersion),
                isNull(users.deletedAt),
              ),
            )
            .returning({ id: users.id });
          if (!revoked) {
            throw new Error("Session generation changed during enrollment.");
          }
          return { ok: true, credentialId: result.credentialId };
        });
      } catch (error) {
        throw ceremonyError(error);
      }
    }),

  rename: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: credentialName }))
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      const [updated] = await ctx.db
        .update(webauthnCredentials)
        .set({ name: input.name, updatedAt: new Date() })
        .where(
          and(
            eq(webauthnCredentials.id, input.id),
            eq(webauthnCredentials.practiceId, session.user.practiceId),
            eq(webauthnCredentials.userId, session.user.id),
            isNull(webauthnCredentials.deletedAt),
          ),
        )
        .returning({ id: webauthnCredentials.id });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return { ok: true };
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.db.transaction(async (tx) => {
        // Serialize removals on the account. Two separate valid confirmations
        // must not both observe two credentials and retire the final pair.
        const [currentUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, session.user.id),
              eq(users.practiceId, session.user.practiceId),
              eq(users.sessionVersion, session.user.sessionVersion),
              isNull(users.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!currentUser) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Sign in again to manage passkeys.",
          });
        }
        const database = tx as unknown as typeof ctx.db;
        const active = await activeWebAuthnCredentials(database, {
          practiceId: session.user.practiceId,
          userId: session.user.id,
        });
        if (active.length <= 2 && passkeyRequiredForIdentity(session.user)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Required administrators and operators must keep at least two active passkeys.",
          });
        }
        const retiredAt = new Date();
        const [retired] = await tx
          .update(webauthnCredentials)
          .set({ deletedAt: retiredAt, updatedAt: retiredAt })
          .where(
            and(
              eq(webauthnCredentials.id, input.id),
              eq(webauthnCredentials.practiceId, session.user.practiceId),
              eq(webauthnCredentials.userId, session.user.id),
              isNull(webauthnCredentials.deletedAt),
            ),
          )
          .returning({ id: webauthnCredentials.id });
        if (!retired) throw new TRPCError({ code: "NOT_FOUND" });
        const [revoked] = await tx
          .update(users)
          .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
          .where(
            and(
              eq(users.id, session.user.id),
              eq(users.practiceId, session.user.practiceId),
              eq(users.sessionVersion, session.user.sessionVersion),
              isNull(users.deletedAt),
            ),
          )
          .returning({ id: users.id });
        if (!revoked)
          throw new Error("Session generation changed during removal.");
        return { ok: true };
      });
    }),
});
