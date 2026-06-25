import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { withTenant, withSystem } from "@/lib/tenant-db";
import { practices } from "@openpims/db";
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
};

function clientIp(req?: Request): string | null {
  if (!req) return null;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim().slice(0, 45);
  return req.headers.get("x-real-ip")?.slice(0, 45) ?? null;
}

export async function createTRPCContext(opts?: {
  req?: Request;
}): Promise<TRPCContext> {
  const session = (await getServerSession(authOptions)) as AppSession | null;
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
  "subscription.createCheckout",
  "subscription.openBillingPortal",
]);

/**
 * Public / pre-auth endpoints (registration, the token-based client portal).
 * They have no tenant session and do their own scoping (tokens, email, rate
 * limits), so they run in a system DB context that bypasses tenant RLS.
 */
export const publicProcedure = t.procedure.use(async ({ ctx, next }) => {
  return withSystem(ctx.db, (tx) =>
    next({ ctx: { ...ctx, db: tx } })
  );
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
    return withTenant(ctx.db, user.practiceId, async (tx) => {
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
          .where(eq(practices.id, user.practiceId))
          .limit(1);
        if (
          !hasHostedFullAccess(
            practice?.tier,
            practice?.billingStatus,
            practice?.trialEndsAt
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
        ctx: { session: ctx.session, user, practiceId: user.practiceId, db: tx },
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
          })
        ).catch(() => {});
      }

      return result;
    });
  }
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
        .where(eq(practices.id, ctx.session.user.practiceId))
        .limit(1);
      const tier = effectiveTier(
        practice?.tier,
        practice?.billingStatus,
        practice?.trialEndsAt
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
