import { z } from "zod";
import { hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { users, practices, locations } from "@openpims/db";
import type { Database } from "@openpims/db/client";
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
  sendPasswordResetEmail,
  sendWelcomeEmail,
  type EmailProvider,
} from "@/lib/email";
import { sendTrackedVerificationEmail } from "@/lib/auth-email-delivery";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
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
import { regionDefaults } from "@/lib/locale/format";
import {
  CLINIC_REGION_CODES,
  explicitJurisdictionState,
} from "@/lib/locale/clinic-regions";
import {
  CLINIC_MODELS,
  FIRST_GOALS,
  onboardingIntentForGoal,
} from "@/lib/onboarding/clinic-profile";

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
    AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH,
  ),
  email: authEmailInput,
  role: z.enum(["veterinarian", "technician", "front_desk", "viewer"]),
});

const onboardingDraftSchema = z
  .object({
    logoName: authTextInput(
      "Logo name",
      1,
      AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH,
    ).optional(),
    brandColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    teamMembers: z.array(onboardingTeamMemberSchema).max(8).optional(),
    clinicModel: z.enum(CLINIC_MODELS).optional(),
    firstGoal: z.enum(FIRST_GOALS).optional(),
  })
  .superRefine((draft, ctx) => {
    if (Boolean(draft.clinicModel) !== Boolean(draft.firstGoal)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Clinic model and first goal must be selected together.",
      });
    }
    if (draft.firstGoal === "self_host" && draft.clinicModel !== "exploring") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Self-hosting evaluation is available from the explore path.",
      });
    }
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
  draft: z.infer<typeof onboardingDraftSchema> | undefined,
): Record<string, unknown> | undefined {
  if (!draft) return undefined;

  const clean: Record<string, unknown> = {};
  if (draft.logoName?.trim()) clean.logoName = draft.logoName.trim();
  if (draft.brandColor) clean.brandColor = draft.brandColor.toLowerCase();
  if (draft.clinicModel && draft.firstGoal) {
    clean.clinicModel = draft.clinicModel;
    clean.firstGoal = draft.firstGoal;
  }
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
          AUTH_PRACTICE_NAME_MAX_LENGTH,
        ),
        country: z.enum(CLINIC_REGION_CODES),
        locationName: authTextInput(
          "Location name",
          2,
          AUTH_LOCATION_NAME_MAX_LENGTH,
        ).optional(),
        onboardingDraft: onboardingDraftSchema.optional(),
        acquisition: signupAcquisitionSchema.optional(),
      }),
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
      await assertPreAuthRateLimit({
        key: `register:ip:${ctx.ip ?? "unknown"}`,
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
      const registrationProfile =
        input.onboardingDraft?.clinicModel && input.onboardingDraft.firstGoal
          ? {
              clinicModel: input.onboardingDraft.clinicModel,
              firstGoal: input.onboardingDraft.firstGoal,
            }
          : null;
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
      const registeredAt = new Date().toISOString();
      const defaults = regionDefaults(input.country);
      const onboardingState: Record<string, unknown> = {
        ...explicitJurisdictionState(
          input.country,
          "registration",
          registeredAt,
        ),
      };
      if (registrationProfile) {
        Object.assign(onboardingState, {
          onboardingIntent: onboardingIntentForGoal(
            registrationProfile.firstGoal,
          ),
          onboardingIntentSelectedAt: registeredAt,
          clinicModel: registrationProfile.clinicModel,
          clinicModelSelectedAt: registeredAt,
          firstGoal: registrationProfile.firstGoal,
          firstGoalSelectedAt: registeredAt,
          journeyStepId: "basics",
          journeyLastProgressAt: registeredAt,
          journeyDismissed: false,
        });
      }
      const practiceSettings: Record<string, unknown> = { onboardingState };
      if (input.acquisition) {
        practiceSettings.acquisition = {
          ...input.acquisition,
          capturedAt: registeredAt,
        };
      }
      if (onboardingDraft) {
        practiceSettings.onboardingDraft = onboardingDraft;
      }
      if (hostedBilling) {
        practiceSettings.onboardingCompletedAt = null;
      }

      const { practice, user, checkoutUrl } = await ctx.db.transaction(
        async (tx) => {
          const [createdPractice] = await tx
            .insert(practices)
            .values({
              name: input.practiceName.trim(),
              email,
              country: input.country,
              currency: defaults.currency,
              taxRatePercent: defaults.taxRatePercent,
              timezone: defaults.timezone,
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
              locationId: createdLocation.id,
            })
            .returning();

          if (!createdUser) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Account setup failed.",
            });
          }

          // A clinic account must never commit with a partial starter catalog
          // or untracked sample rows. Seed and persist provenance inside the
          // same transaction as the practice, location, and owner.
          try {
            await seedPractice(tx as unknown as Database, {
              practiceId: createdPractice.id,
              locationId: createdLocation.id,
            });
            if (hostedBilling) {
              practiceSettings.demoData = await seedDemoData(
                tx as unknown as Database,
                { practiceId: createdPractice.id },
              );
            }
            if (Object.keys(practiceSettings).length > 0) {
              await tx
                .update(practices)
                .set({ settings: practiceSettings })
                .where(eq(practices.id, createdPractice.id));
            }
          } catch (err) {
            console.error("[register] clinic initialization failed:", err);
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Account setup failed. Please retry.",
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
                billingCadence: "month",
                source: "signup",
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
            user: createdUser,
            checkoutUrl: createdCheckoutUrl,
          };
        },
      );

      // Durable, privacy-safe registration stage. Non-fatal so telemetry can
      // never turn a successful account creation into a failed signup.
      try {
        await recordRegistration(ctx.db, practice.id);
      } catch (err) {
        console.error(
          "[register] conversion milestone projection failed:",
          err,
        );
      }

      // On the hosted service, request email verification without blocking the
      // trial. Issue a token + send the email; the in-app banner follows up.
      // Non-fatal: signup still succeeds. Self-host skips this.
      let verificationRequired = false;
      let verificationUrl: string | undefined;
      let verificationDispatch:
        | { to: string; name: string; verifyUrl: string }
        | undefined;
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
          verificationDispatch = {
            to: user.email,
            name: user.name,
            verifyUrl: verificationUrl,
          };
        } catch {
          console.error("[register] verification token preparation failed");
        }
      }

      const response = {
        id: user.id,
        email: user.email,
        verificationRequired,
        verificationEmailSent: hostedBilling ? false : undefined,
        verificationEmailPossiblySent: hostedBilling ? false : undefined,
        verificationEmailPreviewed: hostedBilling ? false : undefined,
        verificationEmailProvider: hostedBilling
          ? (null as EmailProvider | null)
          : undefined,
        verificationUrl: exposeAuthLinksForPreview()
          ? verificationUrl
          : undefined,
        checkoutUrl,
        // Hosted signups (no-card trial) land in the first-run onboarding wizard
        // instead of the bare dashboard.
        onboardingRequired: noCardTrial,
      };

      if (verificationDispatch && ctx.postCommitEffect) {
        ctx.postCommitEffect(async (rootDb) => {
          try {
            const result = await sendTrackedVerificationEmail({
              practiceId: practice.id,
              userId: user.id,
              source: "registration",
              ...verificationDispatch,
              db: rootDb,
            });
            response.verificationEmailProvider = result.provider;
            response.verificationEmailSent =
              result.outcome === "accepted" && result.provider === "resend";
            response.verificationEmailPossiblySent =
              result.outcome === "outcome_unknown";
            response.verificationEmailPreviewed =
              result.outcome === "accepted" && result.provider === "console";
          } catch {
            // Signup is already committed. Keep verification soft and do not
            // log the auth link or recipient embedded in the closure.
            console.error(
              "[register] post-commit verification dispatch failed",
            );
          }
        });
      }

      // Welcome/setup guidance is optional platform email. It shares the
      // strict post-commit boundary, checks recipient consent before claiming,
      // and records provider evidence for global complaint/bounce handling.
      if (hostedBilling && ctx.postCommitEffect) {
        ctx.postCommitEffect(async () => {
          try {
            await sendOptionalPlatformEmail({
              practiceId: practice.id,
              to: user.email,
              emailType: "welcome",
              dedupeKey: `lc:welcome:${practice.id}:${user.id}`,
              send: () =>
                sendWelcomeEmail({
                  to: user.email,
                  practiceName: input.practiceName.trim(),
                  trialDays: TRIAL_DAYS,
                }),
            });
          } catch {
            console.error("[register] post-commit welcome email failed");
          }
        });
      }

      return response;
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

  /**
   * Resend verification for the signed-in user and report delivery failures.
   * This procedure can be truthful because the session already proves which
   * account is making the request; there is no logged-out email resend route.
   */
  resendVerification: protectedProcedure.mutation(async ({ ctx }) => {
    const [user] = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(
        and(
          eq(users.id, ctx.user.id),
          eq(users.practiceId, ctx.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Account not found." });
    }
    if (user.emailVerifiedAt) {
      return {
        ok: true,
        alreadyVerified: true,
        verificationEmailSent: false,
        possiblySent: false,
        verificationEmailPreviewed: false,
        verificationEmailProvider: null as EmailProvider | null,
        message: "Your email is already verified.",
      };
    }

    await assertPreAuthRateLimit({
      key: `verifyresend:${normalizeAuthEmail(user.email)}`,
      limit: 5,
      windowMs: 3600000,
      message: "Too many requests. Please try again later.",
      logContext: "resendVerification",
    });

    const token = await createAuthToken({
      userId: user.id,
      email: user.email,
      type: "email_verify",
      db: ctx.db,
    });
    const response = {
      ok: true,
      alreadyVerified: false,
      verificationEmailSent: false,
      possiblySent: false,
      verificationEmailPreviewed: false,
      verificationEmailProvider: null as EmailProvider | null,
      message: "Verification email is being prepared.",
    };

    if (!ctx.postCommitEffect) {
      response.message =
        "We couldn't prepare the verification email. Please try again later.";
      return response;
    }

    ctx.postCommitEffect(async (rootDb) => {
      try {
        const result = await sendTrackedVerificationEmail({
          practiceId: ctx.practiceId,
          userId: user.id,
          source: "authenticated_resend",
          to: user.email,
          name: user.name,
          verifyUrl: `${appBaseUrl()}/verify-email?token=${token}`,
          db: rootDb,
        });
        response.verificationEmailProvider = result.provider;
        if (result.outcome === "accepted") {
          if (result.provider === "console") {
            response.verificationEmailPreviewed = true;
            response.message =
              "Verification email preview generated in the server console. No email was sent.";
          } else {
            response.verificationEmailSent = true;
            response.message =
              "Verification email sent. Check your inbox and spam folder.";
          }
        } else if (result.outcome === "outcome_unknown") {
          response.possiblySent = true;
          response.message =
            "The verification email may have been sent. Check your inbox and spam folder before requesting another.";
        } else {
          response.message =
            "The email provider did not accept the verification email. Please try again later.";
        }
      } catch {
        // A post-provider failure is conservatively reported as possibly sent
        // so the user is never encouraged to create an immediate duplicate.
        response.possiblySent = true;
        response.message =
          "The verification email may have been sent. Check your inbox and spam folder before requesting another.";
        console.error("[resendVerification] post-commit dispatch failed");
      }
    });

    return response;
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
      }),
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
      }),
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
