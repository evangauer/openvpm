import { compare } from "bcryptjs";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import {
  consumeRecoveryCodeHash,
  decryptMfaSecret,
  matchingTotpCounter,
} from "@/lib/mfa";
import {
  issuePrivilegedActionProof,
  PRIVILEGED_ACTION_COOKIE,
  PRIVILEGED_ACTION_TTL_SECONDS,
  cookieValue,
  verifyPrivilegedActionProof,
} from "@/lib/privileged-action-proof";
import { clientIpFromRequest } from "@/lib/request-ip";
import { rateLimit } from "@/lib/rate-limit";
import { readJsonRequestBody } from "@/lib/request-json";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { db } from "@openpims/db/client";
import { users } from "@openpims/db";

export const dynamic = "force-dynamic";

const inputSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().trim().min(6).max(64),
});
const STEP_UP_BODY_MAX_BYTES = 2 * 1024;

type ActiveSession = {
  user: {
    id: string;
    practiceId: string;
    sessionVersion: number;
  };
};

function jsonError(status: number, message: string) {
  return NextResponse.json(
    { ok: false, message },
    { status, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function activeSession(): Promise<ActiveSession | null> {
  const session = (await getServerSession(authOptions)) as ActiveSession | null;
  return session?.user?.id &&
    session.user.practiceId &&
    Number.isInteger(session.user.sessionVersion)
    ? session
    : null;
}

async function consumeFactor(input: {
  session: ActiveSession;
  password: string;
  code: string;
}): Promise<boolean> {
  return withTenant(db, input.session.user.practiceId, async (tx) => {
    const [user] = await tx
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
        mfaSecretEncrypted: users.mfaSecretEncrypted,
        mfaEnabledAt: users.mfaEnabledAt,
        mfaLastUsedTotpCounter: users.mfaLastUsedTotpCounter,
        mfaRecoveryCodeHashes: users.mfaRecoveryCodeHashes,
      })
      .from(users)
      .where(
        and(
          eq(users.id, input.session.user.id),
          eq(users.practiceId, input.session.user.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (
      !user ||
      user.sessionVersion !== input.session.user.sessionVersion ||
      !user.mfaEnabledAt ||
      !user.mfaSecretEncrypted ||
      !(await compare(input.password, user.passwordHash))
    ) {
      return false;
    }

    let secret: string;
    try {
      secret = decryptMfaSecret(user.mfaSecretEncrypted);
    } catch {
      return false;
    }
    const counter = matchingTotpCounter(secret, input.code);
    if (
      counter !== null &&
      (user.mfaLastUsedTotpCounter === null ||
        counter > user.mfaLastUsedTotpCounter)
    ) {
      const [updated] = await tx
        .update(users)
        .set({ mfaLastUsedTotpCounter: counter })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.practiceId, input.session.user.practiceId),
            eq(users.sessionVersion, user.sessionVersion),
            or(
              isNull(users.mfaLastUsedTotpCounter),
              lt(users.mfaLastUsedTotpCounter, counter),
            ),
            isNull(users.deletedAt),
          ),
        )
        .returning({ id: users.id });
      return Boolean(updated);
    }

    const existingHashes = Array.isArray(user.mfaRecoveryCodeHashes)
      ? user.mfaRecoveryCodeHashes
      : [];
    const recovery = consumeRecoveryCodeHash(existingHashes, input.code);
    if (!recovery.accepted) return false;
    const [updated] = await tx
      .update(users)
      .set({ mfaRecoveryCodeHashes: recovery.remaining })
      .where(
        and(
          eq(users.id, user.id),
          eq(users.practiceId, input.session.user.practiceId),
          eq(users.sessionVersion, user.sessionVersion),
          sql`${users.mfaRecoveryCodeHashes} = ${JSON.stringify(existingHashes)}::jsonb`,
          isNull(users.deletedAt),
        ),
      )
      .returning({ id: users.id });
    return Boolean(updated);
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return jsonError(403, "The identity confirmation request was rejected.");
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return jsonError(415, "Identity confirmation requires JSON.");
  }
  const session = await activeSession();
  if (!session) return jsonError(401, "Sign in again to continue.");

  const body = await readJsonRequestBody(request, STEP_UP_BODY_MAX_BYTES);
  const parsed = body.ok ? inputSchema.safeParse(body.data) : null;
  if (!parsed?.success) {
    return jsonError(
      400,
      "Enter your current password and authentication code.",
    );
  }

  const ip = clientIpFromRequest(request);
  try {
    const limited = await rateLimit({
      key: `step-up:${session.user.id}:${ip}`,
      limit: 6,
      windowMs: 15 * 60 * 1000,
    });
    if (!limited.success) {
      return jsonError(429, "Too many attempts. Please try again later.");
    }
  } catch {
    return jsonError(503, "Identity confirmation is temporarily unavailable.");
  }

  if (!(await consumeFactor({ session, ...parsed.data }))) {
    return jsonError(
      401,
      "The password or authentication code was not accepted.",
    );
  }

  const proof = issuePrivilegedActionProof({
    userId: session.user.id,
    practiceId: session.user.practiceId,
    sessionVersion: session.user.sessionVersion,
  });
  const response = NextResponse.json(
    { ok: true, expiresInSeconds: PRIVILEGED_ACTION_TTL_SECONDS },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
  response.cookies.set(PRIVILEGED_ACTION_COOKIE, proof, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "strict",
    path: "/",
    maxAge: PRIVILEGED_ACTION_TTL_SECONDS,
  });
  void withSystem(db, (tx) =>
    recordAuditLog(tx, {
      practiceId: session.user.practiceId,
      userId: session.user.id,
      ip,
      path: "auth.privilegedActionStepUp",
      rawInput: undefined,
      resultData: { expiresInSeconds: PRIVILEGED_ACTION_TTL_SECONDS },
    }),
  ).catch(() => {});
  return response;
}

export async function GET(request: Request) {
  const session = await activeSession();
  if (!session) return jsonError(401, "Sign in again to continue.");
  const proof = cookieValue(
    request.headers.get("cookie"),
    PRIVILEGED_ACTION_COOKIE,
  );
  return NextResponse.json(
    {
      ok: true,
      active: verifyPrivilegedActionProof(proof, {
        userId: session.user.id,
        practiceId: session.user.practiceId,
        sessionVersion: session.user.sessionVersion,
      }),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return jsonError(403, "The identity confirmation request was rejected.");
  }
  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
  response.cookies.set(PRIVILEGED_ACTION_COOKIE, "", {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
