import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";
import { recordAuditLog } from "@/lib/audit";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { withTenant, withSystem } from "@/lib/tenant-db";
import { assertHostedRlsRoleOnce } from "@/lib/rls-assertion";
import { clientIpFromRequest } from "@/lib/request-ip";
import { practices, users } from "@openpims/db";
import {
  billingEnforced,
  hasHostedFullAccess,
  isEntitled,
  effectiveTier,
  type Feature,
} from "@/lib/billing/plans";

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
  };
}

export type TRPCContext = {
  db: Database;
  session: AppSession | null;
  ip?: string | null;
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
        .select({ id: users.id })
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

  return activeUser ? session : null;
}

export async function createTRPCContext(opts?: {
  req?: Request;
}): Promise<TRPCContext> {
  await assertHostedRlsRoleOnce();
  const rawSession = hasBlankConfiguredNextAuthSecret()
    ? null
    : ((await getServerSession(authOptions)) as AppSession | null);
  const session = await activeSessionOrNull(db, rawSession);
  return { db, session, ip: clientIp(opts?.req) };
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
  "subscription.createCheckout",
  "subscription.openBillingPortal",
  // Platform-operator tooling must keep working even when the operator's own
  // practice trial has lapsed; the procedure itself gates on the
  // PLATFORM_ADMIN_EMAILS allowlist.
  "admin.extendTrial",
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

/**
 * Public / pre-auth endpoints (registration, the token-based client portal).
 * They have no tenant session and do their own scoping (tokens, email, rate
 * limits), so they run in a system DB context that bypasses tenant RLS.
 */
export const publicProcedure = t.procedure.use(async ({ ctx, next, type, path }) => {
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
});

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
    const user = ctx.session.user;
    // Run the whole request in a tenant DB context so Postgres RLS scopes every
    // query to this practice (defense-in-depth behind the app-layer filters).
    const effects: PostCommitEffect[] = [];
    const result = await withTenant(ctx.db, user.practiceId, async (tx) => {
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
            and(eq(practices.id, user.practiceId), isNull(practices.deletedAt)),
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
          db: tx,
          postCommitEffect: (effect: PostCommitEffect) => {
            if (type !== "mutation") {
              throw new Error("Post-commit effects are mutation-only.");
            }
            effects.push(effect);
          },
        },
      });

      // Audit every successful mutation: who changed what, when, from where.
      // Runs in its own system-context tx so it's independent of this request's
      // transaction lifecycle and never blocks or fails the request.
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

      return result;
    });
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
