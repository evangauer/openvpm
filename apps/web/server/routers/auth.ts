import { z } from "zod";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { users, practices, locations } from "@openpims/db";
import { rateLimit } from "@/lib/rate-limit";
import { seedPractice, seedDemoData } from "@/lib/onboarding/defaults";
import { billingEnforced, TRIAL_DAYS } from "@/lib/billing/plans";
import { createAuthToken, consumeAuthToken } from "@/lib/auth-tokens";
import { sendVerificationEmail, sendPasswordResetEmail } from "@/lib/email";
import { appBaseUrl, exposeAuthLinksForPreview } from "@/lib/app-url";

/** Display name from explicit input, else derived from the email local-part. */
function deriveName(name: string | undefined, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const local = email.split("@")[0] ?? "";
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.join(" ") || "Practice Owner";
}

const onboardingTeamMemberSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(255),
  role: z.enum(["veterinarian", "technician", "front_desk", "viewer"]),
});

const onboardingDraftSchema = z.object({
  logoName: z.string().min(1).max(120).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  teamMembers: z.array(onboardingTeamMemberSchema).max(8).optional(),
});

function cleanOnboardingDraft(
  draft: z.infer<typeof onboardingDraftSchema> | undefined
): Record<string, unknown> | undefined {
  if (!draft) return undefined;

  const clean: Record<string, unknown> = {};
  if (draft.logoName?.trim()) clean.logoName = draft.logoName.trim();
  if (draft.brandColor) clean.brandColor = draft.brandColor.toLowerCase();
  const teamMembers = draft.teamMembers
    ?.map((member) => ({
      name: member.name.trim(),
      email: member.email.trim().toLowerCase(),
      role: member.role,
    }))
    .filter((member) => member.name && member.email);
  if (teamMembers?.length) clean.teamMembers = teamMembers;

  return Object.keys(clean).length ? clean : undefined;
}

export const authRouter = createRouter({
  register: publicProcedure
    .input(
      z.object({
        // Lean signup collects only practice + email + password. `name` is
        // optional and derived from the email when omitted.
        name: z.string().min(2).optional(),
        email: z.string().email(),
        password: z.string().min(8),
        practiceName: z.string().min(2),
        locationName: z.string().min(2).max(255).optional(),
        onboardingDraft: onboardingDraftSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Rate limit by email: 5 registrations per hour
      const { success } = rateLimit({
        key: `register:${input.email}`,
        limit: 5,
        windowMs: 3600000,
      });

      if (!success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many registration attempts. Please try again later.",
        });
      }

      // Check if email already exists
      const [existing] = await ctx.db
        .select()
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);

      if (existing) {
        throw new Error("Email already registered");
      }

      const passwordHash = await hash(input.password, 10);
      const onboardingDraft = cleanOnboardingDraft(input.onboardingDraft);

      // On the hosted service, start a full-featured trial so the new practice
      // is immediately usable before entering payment. Self-host ignores this.
      const trial = billingEnforced()
        ? {
            billingStatus: "trialing" as const,
            trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
          }
        : {};

      // Create practice
      const [practice] = await ctx.db
        .insert(practices)
        .values({
          name: input.practiceName.trim(),
          email: input.email.trim().toLowerCase(),
          ...trial,
        })
        .returning();

      // Create default location
      const [location] = await ctx.db
        .insert(locations)
        .values({
          practiceId: practice!.id,
          name: input.locationName?.trim() || "Main Location",
          isPrimary: true,
        })
        .returning();

      // Create admin user
      const [user] = await ctx.db
        .insert(users)
        .values({
          email: input.email.trim().toLowerCase(),
          passwordHash,
          name: deriveName(input.name, input.email),
          role: "admin",
          practiceId: practice!.id,
        })
        .returning();

      // Seed sensible defaults (appointment types, rooms, starter services) so
      // the new practice is usable immediately. Non-fatal: a seed hiccup must
      // not block signup — the practice still works, just emptier.
      try {
        await seedPractice(ctx.db, {
          practiceId: practice!.id,
          locationId: location?.id ?? null,
        });
      } catch (err) {
        console.error("[register] practice seeding failed:", err);
      }

      // On the hosted service, seed demo data + start onboarding so the trial
      // lands on a lively dashboard. Non-fatal. Self-host skips this.
      const practiceSettings: Record<string, unknown> = {};
      if (onboardingDraft) {
        practiceSettings.onboardingDraft = onboardingDraft;
      }
      if (billingEnforced()) {
        practiceSettings.onboardingCompletedAt = null;
        try {
          const demoData = await seedDemoData(ctx.db, { practiceId: practice!.id });
          practiceSettings.demoData = demoData;
        } catch (err) {
          console.error("[register] demo seeding failed:", err);
        }
      }
      if (Object.keys(practiceSettings).length) {
        await ctx.db
          .update(practices)
          .set({ settings: practiceSettings })
          .where(eq(practices.id, practice!.id));
      }

      // On the hosted service, require email verification before login. Issue a
      // token + send the email. Non-fatal: signup still succeeds. Self-host
      // skips this (frictionless).
      let verificationRequired = false;
      let verificationUrl: string | undefined;
      let verificationEmailSent: boolean | undefined;
      if (billingEnforced()) {
        verificationRequired = true;
        try {
          const token = await createAuthToken({
            userId: user!.id,
            email: user!.email,
            type: "email_verify",
            db: ctx.db,
          });
          verificationUrl = `${appBaseUrl()}/verify-email?token=${token}`;
          const result = await sendVerificationEmail({
            to: user!.email,
            name: user!.name,
            verifyUrl: verificationUrl,
          });
          verificationEmailSent = result.success;
        } catch (err) {
          console.error("[register] verification email failed:", err);
          verificationEmailSent = false;
        }
      }

      return {
        id: user!.id,
        email: user!.email,
        verificationRequired,
        verificationEmailSent,
        verificationUrl: exposeAuthLinksForPreview() ? verificationUrl : undefined,
      };
    }),

  /** Confirm an email-verification token (hosted). */
  verifyEmail: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "email_verify");
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This verification link is invalid or has expired.",
        });
      }
      await ctx.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, result.userId));
      return { ok: true };
    }),

  /** Resend the email-verification link. Generic response (no enumeration). */
  resendVerification: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const { success } = rateLimit({
        key: `verifyresend:${input.email}`,
        limit: 5,
        windowMs: 3600000,
      });
      if (!success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Please try again later.",
        });
      }

      const [user] = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, input.email.trim().toLowerCase()))
        .limit(1);

      // Only send for an existing, not-yet-verified account. Respond the same
      // either way so the endpoint can't be used to probe for accounts.
      if (user && !user.emailVerifiedAt) {
        try {
          const token = await createAuthToken({
            userId: user.id,
            email: user.email,
            type: "email_verify",
            db: ctx.db,
          });
          await sendVerificationEmail({
            to: user.email,
            name: user.name,
            verifyUrl: `${appBaseUrl()}/verify-email?token=${token}`,
          });
        } catch (err) {
          console.error("[resendVerification] email failed:", err);
        }
      }
      return { ok: true };
    }),

  /** Request a password-reset email. Always succeeds (no account enumeration). */
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const { success } = rateLimit({
        key: `pwreset:${input.email}`,
        limit: 5,
        windowMs: 3600000,
      });
      if (!success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Please try again later.",
        });
      }

      const [user] = await ctx.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);

      if (user) {
        try {
          const token = await createAuthToken({
            userId: user.id,
            email: user.email,
            type: "password_reset",
          });
          await sendPasswordResetEmail({
            to: user.email,
            name: user.name,
            resetUrl: `${appBaseUrl()}/reset-password?token=${token}`,
          });
        } catch (err) {
          console.error("[requestPasswordReset] email failed:", err);
        }
      }
      // Generic response regardless of whether the email exists.
      return { ok: true };
    }),

  /** Complete a password reset with a valid token. */
  resetPassword: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        password: z.string().min(8),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "password_reset");
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This reset link is invalid or has expired.",
        });
      }
      const passwordHash = await hash(input.password, 10);
      await ctx.db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, result.userId));
      return { ok: true };
    }),

  /** Accept a staff invite: set the user's password + verify their email. */
  acceptInvite: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        password: z.string().min(8),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "invite");
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This invite link is invalid or has expired.",
        });
      }
      const passwordHash = await hash(input.password, 10);
      await ctx.db
        .update(users)
        .set({ passwordHash, emailVerifiedAt: new Date() })
        .where(eq(users.id, result.userId));
      return { ok: true };
    }),

  me: protectedProcedure.query(async ({ ctx }) => {
    const [user] = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        practiceId: users.practiceId,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return user;
  }),
});
