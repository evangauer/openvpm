import { z } from "zod";
import { hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { users, practices, locations } from "@openpims/db";
import { rateLimit } from "@/lib/rate-limit";
import { seedPractice, seedDemoData } from "@/lib/onboarding/defaults";
import {
  billingEnforced,
  cloudCheckoutPriceIds,
  cloudMeteredPriceIds,
  noCardTrialEnabled,
  trialEndsAtFrom,
  TRIAL_DAYS,
} from "@/lib/billing/plans";
import { createAuthToken, consumeAuthToken } from "@/lib/auth-tokens";
import { PASSWORD_HASH_COST } from "@/lib/auth-hashing";
import { authPasswordInput } from "@/lib/auth-password";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
} from "@/lib/email";
import { appBaseUrl, exposeAuthLinksForPreview } from "@/lib/app-url";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import { createSubscriptionCheckoutSession } from "@/lib/stripe";
import {
  AUTH_EMAIL_MAX_LENGTH,
  AUTH_LOCATION_NAME_MAX_LENGTH,
  AUTH_NAME_MAX_LENGTH,
  AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH,
  AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH,
  AUTH_PRACTICE_NAME_MAX_LENGTH,
} from "@/lib/auth-input-policy";
import { ACQUISITION_VALUE_MAX_LENGTH } from "@/lib/acquisition";
import { recordRegistration } from "@/lib/funnel-events-server";

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

function normalizeAuthEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function assertPreAuthRateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
  message: string;
  logContext: string;
}) {
  try {
    const { success } = await rateLimit({
      key: input.key,
      limit: input.limit,
      windowMs: input.windowMs,
    });
    if (success) return;
  } catch (err) {
    console.error(`[auth.${input.logContext}] rate limit failed:`, err);
  }

  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: input.message,
  });
}

const authEmailInput = z
  .string()
  .trim()
  .email()
  .max(AUTH_EMAIL_MAX_LENGTH)
  .transform((email) => email.toLowerCase());

const authTextInput = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters.`)
    .max(max, `${label} must be at most ${max} characters.`);

const onboardingTeamMemberSchema = z.object({
  name: authTextInput(
    "Team member name",
    1,
    AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH
  ),
  email: authEmailInput,
  role: z.enum(["veterinarian", "technician", "front_desk", "viewer"]),
});

const onboardingDraftSchema = z.object({
  logoName: authTextInput(
    "Logo name",
    1,
    AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH
  ).optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  teamMembers: z.array(onboardingTeamMemberSchema).max(8).optional(),
});

const acquisitionValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACQUISITION_VALUE_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9._:/-]+$/);

const signupAcquisitionSchema = z
  .object({
    source: acquisitionValueSchema.optional(),
    medium: acquisitionValueSchema.optional(),
    campaign: acquisitionValueSchema.optional(),
    funnelId: z.string().uuid().optional(),
  })
  .strict();

const authTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Invalid or expired link.");

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
        name: authTextInput("Name", 2, AUTH_NAME_MAX_LENGTH).optional(),
        email: authEmailInput,
        password: authPasswordInput,
        practiceName: authTextInput(
          "Practice name",
          2,
          AUTH_PRACTICE_NAME_MAX_LENGTH
        ),
        locationName: authTextInput(
          "Location name",
          2,
          AUTH_LOCATION_NAME_MAX_LENGTH
        ).optional(),
        onboardingDraft: onboardingDraftSchema.optional(),
        acquisition: signupAcquisitionSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const email = normalizeAuthEmail(input.email);
      // Rate limit by email: 5 registrations per hour
      await assertPreAuthRateLimit({
        key: `register:${email}`,
        limit: 5,
        windowMs: 3600000,
        message: "Too many registration attempts. Please try again later.",
        logContext: "register",
      });

      // Check if email already exists
      const [existing] = await ctx.db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email already registered",
        });
      }

      const onboardingDraft = cleanOnboardingDraft(input.onboardingDraft);
      const hostedBilling = billingEnforced();
      // Card-free trial: skip the Stripe Checkout wall at signup and grant a
      // `trialing` window directly, so the clinic lands in the product and only
      // adds a card to convert. Access gating keys off the practice's trial
      // columns (see hasHostedFullAccess), independent of any Stripe object.
      const noCardTrial = hostedBilling && noCardTrialEnabled();
      const trialEndsAt = noCardTrial ? trialEndsAtFrom() : undefined;
      let hostedCheckoutLineItems:
        | Array<{
            priceId: string;
            quantity?: number;
            metered?: boolean;
          }>
        | undefined;

      if (hostedBilling && !noCardTrial) {
        const { locationPriceId } = cloudCheckoutPriceIds();
        if (!locationPriceId) {
          throw new TRPCError({
            code: "SERVICE_UNAVAILABLE",
            message:
              "Hosted billing is not configured. Please contact support to finish signup.",
          });
        }

        // Checkout shows the single per-location price so the clinic sees one
        // clean product; the metered overage items (AI + SMS) are attached to
        // the subscription server-side after creation (subscription sync).
        hostedCheckoutLineItems = [{ priceId: locationPriceId, quantity: 1 }];
      }

      const passwordHash = await hash(input.password, PASSWORD_HASH_COST);

      const { practice, location, user, checkoutUrl } =
        await ctx.db.transaction(async (tx) => {
          const [createdPractice] = await tx
            .insert(practices)
            .values({
              name: input.practiceName.trim(),
              email,
              // Card-free trial grants Cloud access immediately with no Stripe
              // subscription; the trial-lifecycle sweep lapses it at expiry.
              ...(noCardTrial
                ? {
                    subscriptionTier: "cloud",
                    billingStatus: "trialing",
                    trialEndsAt,
                  }
                : {}),
            })
            .returning();

          if (!createdPractice) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Account setup failed.",
            });
          }

          const [createdLocation] = await tx
            .insert(locations)
            .values({
              practiceId: createdPractice.id,
              name: input.locationName?.trim() || "Main Location",
              isPrimary: true,
            })
            .returning();

          if (!createdLocation) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Account setup failed.",
            });
          }

          const [createdUser] = await tx
            .insert(users)
            .values({
              email,
              passwordHash,
              name: deriveName(input.name, email),
              role: "admin",
              practiceId: createdPractice.id,
            })
            .returning();

          if (!createdUser) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Account setup failed.",
            });
          }

          let createdCheckoutUrl: string | undefined;
          if (hostedCheckoutLineItems) {
            try {
              const base = appBaseUrl();
              const checkout = await createSubscriptionCheckoutSession({
                lineItems: hostedCheckoutLineItems,
                practiceId: createdPractice.id,
                customerEmail: email,
                trialPeriodDays: TRIAL_DAYS,
                successUrl: `${base}/login?checkout=success`,
                cancelUrl: `${base}/login?checkout=cancelled`,
              });
              const checkoutUrl = checkout?.url;
              createdCheckoutUrl = isSafeCheckoutRedirectUrl(checkoutUrl)
                ? checkoutUrl
                : undefined;
            } catch (err) {
              console.error("[register] subscription checkout failed:", err);
              throw new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message:
                  "Could not start hosted billing checkout. Please try again.",
              });
            }

            if (!createdCheckoutUrl) {
              throw new TRPCError({
                code: "SERVICE_UNAVAILABLE",
                message:
                  "Could not start hosted billing checkout. Please try again.",
              });
            }
          }

          return {
            practice: createdPractice,
            location: createdLocation,
            user: createdUser,
            checkoutUrl: createdCheckoutUrl,
          };
        });

      // Seed sensible defaults (appointment types, rooms, starter services) so
      // the new practice is usable immediately. Non-fatal: a seed hiccup must
      // not block signup — the practice still works, just emptier.
      try {
        await seedPractice(ctx.db, {
          practiceId: practice.id,
          locationId: location?.id ?? null,
        });
      } catch (err) {
        console.error("[register] practice seeding failed:", err);
      }

      // On the hosted service, seed demo data + start onboarding so the trial
      // lands on a lively dashboard. Non-fatal. Self-host skips this.
      const practiceSettings: Record<string, unknown> = {};
      if (input.acquisition) {
        practiceSettings.acquisition = {
          ...input.acquisition,
          capturedAt: new Date().toISOString(),
        };
      }
      if (onboardingDraft) {
        practiceSettings.onboardingDraft = onboardingDraft;
      }
      if (hostedBilling) {
        practiceSettings.onboardingCompletedAt = null;
        try {
          const demoData = await seedDemoData(ctx.db, { practiceId: practice.id });
          practiceSettings.demoData = demoData;
        } catch (err) {
          console.error("[register] demo seeding failed:", err);
        }
      }
      if (Object.keys(practiceSettings).length) {
        await ctx.db
          .update(practices)
          .set({ settings: practiceSettings })
          .where(eq(practices.id, practice.id));
      }

      // Durable, privacy-safe registration stage. Non-fatal so telemetry can
      // never turn a successful account creation into a failed signup.
      try {
        await recordRegistration(ctx.db, practice.id);
      } catch (err) {
        console.error("[register] funnel event failed:", err);
      }

      // On the hosted service, request email verification without blocking the
      // trial. Issue a token + send the email; the in-app banner follows up.
      // Non-fatal: signup still succeeds. Self-host skips this.
      let verificationRequired = false;
      let verificationUrl: string | undefined;
      let verificationEmailSent: boolean | undefined;
      if (hostedBilling) {
        verificationRequired = true;
        try {
          const token = await createAuthToken({
            userId: user.id,
            email: user.email,
            type: "email_verify",
            db: ctx.db,
          });
          verificationUrl = `${appBaseUrl()}/verify-email?token=${token}`;
          const result = await sendVerificationEmail({
            to: user.email,
            name: user.name,
            verifyUrl: verificationUrl,
          });
          verificationEmailSent = result.success;
        } catch (err) {
          console.error("[register] verification email failed:", err);
          verificationEmailSent = false;
        }
      }

      // Send a branded welcome email (hosted only). Non-fatal — signup succeeds
      // regardless of delivery.
      if (hostedBilling) {
        try {
          await sendWelcomeEmail({
            to: user.email,
            practiceName: input.practiceName.trim(),
            trialDays: TRIAL_DAYS,
          });
        } catch (err) {
          console.error("[register] welcome email failed:", err);
        }
      }

      return {
        id: user.id,
        email: user.email,
        verificationRequired,
        verificationEmailSent,
        verificationUrl: exposeAuthLinksForPreview() ? verificationUrl : undefined,
        checkoutUrl,
        // Hosted signups (no-card trial) land in the first-run onboarding wizard
        // instead of the bare dashboard.
        onboardingRequired: noCardTrial,
      };
    }),

  /** Confirm an email-verification token (hosted). */
  verifyEmail: publicProcedure
    .input(z.object({ token: authTokenSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "email_verify", {
        db: ctx.db,
      });
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This verification link is invalid or has expired.",
        });
      }
      const [updated] = await ctx.db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(users.id, result.userId), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (!updated) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This verification link is invalid or has expired.",
        });
      }
      return { ok: true };
    }),

  /** Resend the email-verification link. Generic response (no enumeration). */
  resendVerification: publicProcedure
    .input(z.object({ email: authEmailInput }))
    .mutation(async ({ ctx, input }) => {
      const email = normalizeAuthEmail(input.email);
      await assertPreAuthRateLimit({
        key: `verifyresend:${email}`,
        limit: 5,
        windowMs: 3600000,
        message: "Too many requests. Please try again later.",
        logContext: "resendVerification",
      });

      const [user] = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)))
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
    .input(z.object({ email: authEmailInput }))
    .mutation(async ({ ctx, input }) => {
      const email = normalizeAuthEmail(input.email);
      await assertPreAuthRateLimit({
        key: `pwreset:${email}`,
        limit: 5,
        windowMs: 3600000,
        message: "Too many requests. Please try again later.",
        logContext: "requestPasswordReset",
      });

      const [user] = await ctx.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)))
        .limit(1);

      if (user) {
        try {
          const token = await createAuthToken({
            userId: user.id,
            email: user.email,
            type: "password_reset",
            db: ctx.db,
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
        token: authTokenSchema,
        password: authPasswordInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "password_reset", {
        db: ctx.db,
      });
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This reset link is invalid or has expired.",
        });
      }
      const passwordHash = await hash(input.password, PASSWORD_HASH_COST);
      const [updated] = await ctx.db
        .update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, result.userId), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (!updated) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This reset link is invalid or has expired.",
        });
      }
      return { ok: true };
    }),

  /** Accept a staff invite: set the user's password + verify their email. */
  acceptInvite: publicProcedure
    .input(
      z.object({
        token: authTokenSchema,
        password: authPasswordInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await consumeAuthToken(input.token, "invite", {
        db: ctx.db,
      });
      if (!result) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This invite link is invalid or has expired.",
        });
      }
      const passwordHash = await hash(input.password, PASSWORD_HASH_COST);
      const [updated] = await ctx.db
        .update(users)
        .set({ passwordHash, emailVerifiedAt: new Date() })
        .where(and(eq(users.id, result.userId), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (!updated) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This invite link is invalid or has expired.",
        });
      }
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
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return {
      ...user,
      // Soft email-verification nudge: only relevant on the hosted service.
      emailVerified: Boolean(user?.emailVerifiedAt),
      verificationEnabled: billingEnforced(),
    };
  }),
});
