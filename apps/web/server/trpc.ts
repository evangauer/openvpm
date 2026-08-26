import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { recordAuditLog } from "@/lib/audit";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { withTenant, withSystem } from "@/lib/tenant-db";
import { assertHostedRlsRoleOnce } from "@/lib/rls-assertion";
import { clientIpFromRequest } from "@/lib/request-ip";
import { externallyVisibleRequestOrigin } from "@/lib/request-origin";
import { practices, users } from "@openpims/db";
import {
  billingEnforced,
  hasHostedFullAccess,
  isEntitled,
  effectiveTier,
  type Feature,
} from "@/lib/billing/plans";
import { readHostedAiAccess } from "@/lib/billing/ai-access";
import {
  portalSessionTokenFromCookie,
  resolvePortalSession,
  type PortalSessionClient,
} from "@/lib/portal/session";

type UserRole =
  | "admin"
  | "veterinarian"
  | "technician"
  | "front_desk"
  | "viewer";

interface AppSession extends Session {
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    practiceId: string;
    recoveryHold?: boolean;
    emailVerifiedAt?: Date | string | null;
    practiceCreatedAt?: Date | string | null;
  };
}

export type TRPCContext = {
  db: Database;
  session: AppSession | null;
  ip?: string | null;
  portalSessionToken?: string | null;
  requestOrigin?: string | null;
  requestUrlOrigin?: string | null;
  /** Pre-resolved only by portalProcedure (or explicitly injected test callers). */
  portalClient?: PortalSessionClient;
  portalSessionId?: string;
  /**
   * Queue a mutation side effect that must begin only after the procedure's
   * outer RLS transaction commits. The callback receives the root pool, not
   * the transaction handle; it must establish its own tenant/system scope for
   * every database operation. Effects run before the tRPC result is returned.
   */
  postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
};

type PostCommitEffect = (rootDb: Database) => Promise<void>;

async function runPostCommitEffects(
  rootDb: Database,
  effects: PostCommitEffect[],
  path: string,
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect(rootDb);
    } catch {
      // Do not log the thrown value: effects may handle auth links or contact
      // data. The route path is sufficient for a PHI-free operational signal.
      console.error(`[trpc post-commit] effect failed for ${path}`);
    }
  }
}

function clientIp(req?: Request): string | null {
  if (!req) return null;
  const ip = clientIpFromRequest(req);
  return ip === "unknown" ? null : ip;
}

async function activeSessionOrNull(
  database: Database,
  session: AppSession | null,
): Promise<AppSession | null> {
  if (!session?.user?.id || !session.user.practiceId) {
    return null;
  }

  const [activeUser] = await withTenant(
    database,
    session.user.practiceId,
    (tx) =>
      tx
        .select({
          id: users.id,
          emailVerifiedAt: users.emailVerifiedAt,
          practiceCreatedAt: practices.createdAt,
          recoveryHold: practices.recoveryHold,
        })
        .from(users)
        .innerJoin(
          practices,
          and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
        )
        .where(
          and(
            eq(users.id, session.user.id),
            eq(users.practiceId, session.user.practiceId),
            isNull(users.deletedAt),
          ),
        )
        .limit(1),
  );

  return activeUser
    ? {
        ...session,
        user: {
          ...session.user,
          emailVerifiedAt: activeUser.emailVerifiedAt,
          practiceCreatedAt: activeUser.practiceCreatedAt,
          recoveryHold: activeUser.recoveryHold,
        },
      }
    : null;
}

export async function createTRPCContext(opts?: {
  req?: Request;
}): Promise<TRPCContext> {
  await assertHostedRlsRoleOnce();
  const rawSession = hasBlankConfiguredNextAuthSecret()
    ? null
    : ((await getServerSession(authOptions)) as AppSession | null);
  const session = await activeSessionOrNull(db, rawSession);
  return {
    db,
    session,
    ip: clientIp(opts?.req),
    portalSessionToken: portalSessionTokenFromCookie(
      opts?.req?.headers.get("cookie"),
    ),
    requestOrigin: opts?.req?.headers.get("origin") ?? null,
    requestUrlOrigin: opts?.req
      ? externallyVisibleRequestOrigin(opts.req)
      : null,
  };
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createRouter = t.router;

const HOSTED_READ_ONLY_MUTATION_ALLOWLIST = new Set([
  "auth.resendVerification",
  "settings.requestAccountDeletion",
  "settings.setMarketingEmailPreference",
  "subscription.createCheckout",
  "subscription.openBillingPortal",
  // Platform-operator tooling must keep working even when the operator's own
  // practice trial has lapsed; the procedure itself gates on the
  // PLATFORM_ADMIN_EMAILS allowlist.
  "admin.extendTrial",
  "admin.saveClinicPilot",
  "admin.submitMessagingBrand",
  "admin.submitMessagingCampaign",
  "admin.assignMessagingNumbers",
  "admin.inspectMessagingProfile",
  "admin.setMessagingProfileEnabled",
  "admin.attachMessagingProviderIds",
  "admin.clearStaleMessagingSubmissionLock",
  "admin.reconcileMessagingRegistration",
  "admin.reconcileSmsSendAttempt",
  "admin.resendSmsSendAttempt",
  "admin.reconcileSmsDeliveryEvent",
]);

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

function postgresErrorDetails(error: unknown): {
  code?: unknown;
  constraintName?: unknown;
  message?: unknown;
} {
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return {};
    if (visited.has(current)) return {};
    visited.add(current);

    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return {
        code: candidate.code,
        constraintName: candidate.constraint_name,
        message: candidate.message,
      };
    }
    current = candidate.cause;
  }

  return {};
}

function patientMergeDatabaseError(error: unknown): TRPCError | null {
  const { code, constraintName, message } = postgresErrorDetails(error);

  if (code === "40001") {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "Patient records changed during the merge. Refresh both charts and retry.",
    });
  }

  if (
    code === "23505" &&
    (constraintName === "patient_merge_events_operation_uq" ||
      constraintName === "patient_merge_events_source_uq")
  ) {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "This patient merge conflicts with another completed operation. Refresh both charts before continuing.",
    });
  }

  if (
    code === "23514" &&
    ((typeof constraintName === "string" &&
      constraintName.startsWith("patient_merge_events_")) ||
      message ===
        "A canonical patient with incoming merge history cannot be retired." ||
      message ===
        "A patient already recorded as a merge alias cannot be a merge target.")
  ) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    });
  }

  if (
    code === "23503" &&
    message ===
      "Patient merge source and target must belong to the recorded client."
  ) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    });
  }

  return null;
}

/**
 * Public / pre-auth endpoints (registration, the token-based client portal).
 * They have no tenant session and do their own scoping (tokens, email, rate
 * limits), so they run in a system DB context that bypasses tenant RLS.
 */
export const publicProcedure = t.procedure.use(
  async ({ ctx, next, type, path }) => {
    const effects: PostCommitEffect[] = [];
    const result = await withSystem(ctx.db, (tx) =>
      next({
        ctx: {
          ...ctx,
          db: tx,
          postCommitEffect: (effect: PostCommitEffect) => {
            if (type !== "mutation") {
              throw new Error("Post-commit effects are mutation-only.");
            }
            effects.push(effect);
          },
        },
      }),
    );
    if (result.ok) {
      await runPostCommitEffects(ctx.db, effects, path);
    }
    return result;
  },
);

/**
 * Requires a revocable portal browser session. The opaque cookie is resolved
 * inside the system-scoped transaction, then every router query still applies
 * explicit practice/client predicates as defense in depth.
 */
export const portalProcedure = publicProcedure.use(
  async ({ ctx, next, type }) => {
    const portalSession =
      ctx.portalClient && ctx.portalSessionId
        ? { client: ctx.portalClient, sessionId: ctx.portalSessionId }
        : await resolvePortalSession(ctx.db, ctx.portalSessionToken);
    if (!portalSession) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Portal session expired",
      });
    }
    if (
      type === "mutation" &&
      ctx.requestOrigin &&
      ctx.requestUrlOrigin &&
      ctx.requestOrigin !== ctx.requestUrlOrigin
    ) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Invalid request origin" });
    }
    return next({
      ctx: {
        ...ctx,
        portalClient: portalSession.client as PortalSessionClient,
        portalSessionId: portalSession.sessionId,
      },
    });
  },
);

/** Requires an authenticated session */
export const protectedProcedure = t.procedure.use(
  async ({ ctx, next, type, path, getRawInput }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    // Global read-only guard: viewers can run any query but no mutation. This
    // makes the role enforceable everywhere without touching each router.
    if (type === "mutation" && ctx.session.user.role === "viewer") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your account has read-only (viewer) access.",
      });
    }
    if (type === "mutation" && ctx.session.user.recoveryHold === true) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "This clinic is in protected data review mode. Changes remain paused until the recovery hold is released through the audited recovery process.",
      });
    }
    const user = ctx.session.user;
    // Run the whole request in a tenant DB context so Postgres RLS scopes every
    // query to this practice (defense-in-depth behind the app-layer filters).
    const effects: PostCommitEffect[] = [];
    const result = await withTenant(
      ctx.db,
      user.practiceId,
      async (tx) => {
        // Hosted read-only guard: block mutations unless the practice has an
        // active trial or subscription. This MUST run inside withTenant (via tx),
        // not on the raw connection — under the least-privilege production role
        // RLS only returns the practices row when app.current_practice_id is set,
        // so a context-less lookup returns zero rows and would wrongly read-only
        // every tenant (the owner role used in dev bypasses RLS and hid this).
        if (
          type === "mutation" &&
          billingEnforced() &&
          !HOSTED_READ_ONLY_MUTATION_ALLOWLIST.has(path)
        ) {
          const [practice] = await tx
            .select({
              tier: practices.subscriptionTier,
              billingStatus: practices.billingStatus,
              trialEndsAt: practices.trialEndsAt,
            })
            .from(practices)
            .where(
              and(
                eq(practices.id, user.practiceId),
                isNull(practices.deletedAt),
              ),
            )
            .limit(1);
          if (!practice) {
            throw practiceNotFound();
          }
          if (
            !hasHostedFullAccess(
              practice.tier,
              practice.billingStatus,
              practice.trialEndsAt,
            )
          ) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "OpenVPM Cloud is read-only until your trial or subscription is active. You can still manage billing and export your data.",
            });
          }
        }

        const result = await next({
          ctx: {
            session: ctx.session,
            user,
            practiceId: user.practiceId,
            ip: ctx.ip,
            db: tx,
            postCommitEffect: (effect: PostCommitEffect) => {
              if (type !== "mutation") {
                throw new Error("Post-commit effects are mutation-only.");
              }
              effects.push(effect);
            },
          },
        });

        if (path === "patients.merge" && !result.ok) {
          // tRPC represents resolver exceptions as error results. Rethrowing
          // here keeps the outer tenant transaction fail-closed and exposes
          // the wrapped PostgreSQL cause to the narrow merge error mapper.
          throw result.error;
        }

        if (type === "mutation" && result.ok) {
          // Surface deferred clinical invariants while this transaction can
          // still return a truthful procedure error. The audit is scheduled
          // only after withTenant confirms the commit succeeded.
          await tx.execute(sql`set constraints all immediate`);
        }

        return result;
      },
      path === "patients.merge"
        ? { isolationLevel: "serializable" }
        : undefined,
    ).catch((error: unknown) => {
      if (path === "patients.merge") {
        const mapped = patientMergeDatabaseError(error);
        if (mapped) throw mapped;
      }
      if (
        type === "mutation" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514" &&
        "constraint_name" in error &&
        error.constraint_name === "soap_notes_appointment_invariant"
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Clinical documentation changed in another session. Refresh and retry.",
        });
      }
      throw error;
    });
    // Audit every successful mutation after the tenant transaction committed.
    // Runs in its own system-context tx and never blocks or fails the request.
    if (type === "mutation" && result.ok) {
      const rawInput = await getRawInput().catch(() => undefined);
      void withSystem(db, (sysTx) =>
        recordAuditLog(sysTx, {
          practiceId: user.practiceId,
          userId: user.id,
          ip: ctx.ip,
          path,
          rawInput,
          resultData: (result as { data?: unknown }).data,
        }),
      ).catch(() => {});
    }
    if (result.ok) {
      await runPostCommitEffects(ctx.db, effects, path);
    }
    return result;
  },
);

/**
 * Requires the practice's plan to include a premium feature.
 *
 * No-op on self-host: when HOSTED_BILLING_ENABLED is unset, billingEnforced()
 * is false and this allows everything (and skips the DB lookup entirely), so
 * the OSS edition is never gated. Only the managed hosted service enforces it.
 */
export function requireFeature(feature: Feature) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    if (billingEnforced()) {
      if (feature === "agent") {
        const access = await readHostedAiAccess(
          ctx.db,
          ctx.session.user.practiceId,
          { enforced: true },
        );
        if (!access) {
          throw practiceNotFound();
        }
        if (!access.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: access.message ?? "OpenVPM AI is not available.",
          });
        }
        return next({
          ctx: {
            session: ctx.session,
            user: ctx.session.user,
            practiceId: ctx.session.user.practiceId,
          },
        });
      }

      const [practice] = await ctx.db
        .select({
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(
          and(
            eq(practices.id, ctx.session.user.practiceId),
            isNull(practices.deletedAt),
          ),
        )
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }
      const tier = effectiveTier(
        practice.tier,
        practice.billingStatus,
        practice.trialEndsAt,
      );
      if (!isEntitled(tier, feature, true)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Your plan doesn't include this feature. Upgrade to unlock it.`,
        });
      }
    }
    return next({
      ctx: {
        session: ctx.session,
        user: ctx.session.user,
        practiceId: ctx.session.user.practiceId,
      },
    });
  });
}

/** Requires specific roles */
export function requireRole(...roles: UserRole[]) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    if (!roles.includes(ctx.session.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Requires one of: ${roles.join(", ")}`,
      });
    }
    return next({
      ctx: {
        session: ctx.session,
        user: ctx.session.user,
        practiceId: ctx.session.user.practiceId,
      },
    });
  });
}
