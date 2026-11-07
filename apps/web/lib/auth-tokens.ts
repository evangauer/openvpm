import { randomBytes, createHash } from "crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import {
  authTokens,
  portalSessions,
  sessions,
  verificationTokens,
} from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

export type AuthTokenType = "email_verify" | "password_reset" | "invite";

const TTL_MS: Record<AuthTokenType, number> = {
  email_verify: 24 * 60 * 60 * 1000, // 24h
  password_reset: 60 * 60 * 1000, // 1h
  invite: 72 * 60 * 60 * 1000, // 72h
};

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a single-use token. Returns the RAW token (emailed to the user); only
 * its hash is persisted. Pre-tenant flow → system context.
 */
export async function createAuthToken(opts: {
  userId: string;
  email: string;
  type: AuthTokenType;
  now?: Date;
  db?: Database;
}): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  const now = opts.now ?? new Date();
  const issueToken = async (tx: Database) => {
    // Keep unexpired verification links valid. A resend may be delayed or the
    // provider may reject it, and neither case should burn a working link that
    // is already in the user's inbox. Password-reset and invite tokens retain
    // single-newest-link semantics because they grant new credentials/access.
    if (opts.type !== "email_verify") {
      await tx
        .update(authTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(authTokens.userId, opts.userId),
            eq(authTokens.type, opts.type),
            isNull(authTokens.usedAt),
            gt(authTokens.expiresAt, now)
          )
        );
    }

    await tx.insert(authTokens).values({
      userId: opts.userId,
      email: opts.email.toLowerCase(),
      tokenHash: hashToken(raw),
      type: opts.type,
      expiresAt: new Date(now.getTime() + TTL_MS[opts.type]),
    });
  };

  if (opts.db) {
    await issueToken(opts.db);
  } else {
    await withSystem(db, issueToken);
  }
  return raw;
}

/**
 * Validate + consume a token. Returns the matching record (userId/email) if it's
 * the right type, unused, and unexpired — and marks it used. Otherwise null.
 */
export async function consumeAuthToken(
  raw: string,
  type: AuthTokenType,
  opts: { now?: Date; db?: Database } = {}
): Promise<{ userId: string; email: string } | null> {
  const tokenHash = hashToken(raw);
  const now = opts.now ?? new Date();
  const claimToken = async (tx: Database) => {
    const [row] = await tx
      .update(authTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.type, type),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, now)
        )
      )
      .returning({
        userId: authTokens.userId,
        email: authTokens.email,
      });
    return row ?? null;
  };

  if (opts.db) {
    return claimToken(opts.db);
  }
  return withSystem(db, claimToken);
}

export async function cleanupExpiredAuthArtifacts(options: {
  now?: Date;
  db?: Database;
} = {}): Promise<{
  authTokensDeleted: number;
  sessionsDeleted: number;
  verificationTokensDeleted: number;
  portalSessionsDeleted: number;
  deleted: number;
  cutoff: Date;
}> {
  const cutoff = options.now ?? new Date();
  const cleanup = async (tx: Database) => {
    const deletedAuthTokens = await tx
      .delete(authTokens)
      .where(lt(authTokens.expiresAt, cutoff))
      .returning({ id: authTokens.id });
    const deletedSessions = await tx
      .delete(sessions)
      .where(lt(sessions.expires, cutoff))
      .returning({ id: sessions.id });
    const deletedVerificationTokens = await tx
      .delete(verificationTokens)
      .where(lt(verificationTokens.expires, cutoff))
      .returning({ expires: verificationTokens.expires });
    const deletedPortalSessions = await tx
      .delete(portalSessions)
      .where(lt(portalSessions.expiresAt, cutoff))
      .returning({ id: portalSessions.id });

    return {
      authTokensDeleted: deletedAuthTokens.length,
      sessionsDeleted: deletedSessions.length,
      verificationTokensDeleted: deletedVerificationTokens.length,
      portalSessionsDeleted: deletedPortalSessions.length,
    };
  };

  const counts = options.db
    ? await cleanup(options.db)
    : await withSystem(db, cleanup);
  return {
    ...counts,
    deleted:
      counts.authTokensDeleted +
      counts.sessionsDeleted +
      counts.verificationTokensDeleted +
      counts.portalSessionsDeleted,
    cutoff,
  };
}
