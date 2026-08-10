import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import {
  asc,
  desc,
  eq,
  and,
  or,
  isNull,
  inArray,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { hash } from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  practices,
  users,
  appointmentTypes,
  rooms,
  staffSchedules,
  appointmentWaitlist,
  clients,
  patients,
  appointments,
  invoices,
  products,
  locations,
  locationMessaging,
  migrationRuns,
  visitCloseouts,
  bookingPages,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { regionDefaults } from "@/lib/locale/format";
import { alertOps } from "@/lib/alerts";
import { syncPracticeSubscriptionQuantities } from "@/lib/billing/subscription-sync";
import {
  clearSeededDemoData,
  hasLiveDemoData,
  reseedSampleClinic,
  type DemoDataProvenance,
} from "@/lib/onboarding/demo-data-lifecycle";
import { createAuthToken } from "@/lib/auth-tokens";
import { PASSWORD_HASH_COST } from "@/lib/auth-hashing";
import { authPasswordInput } from "@/lib/auth-password";
import {
  ACCOUNT_DELETION_REASON_MAX_LENGTH,
  APPOINTMENT_TYPE_DURATION_MAX_MINUTES,
  APPOINTMENT_TYPE_DURATION_MIN_MINUTES,
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
  PRACTICE_NAME_MAX_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  SETTINGS_ADDRESS_MAX_LENGTH,
  SETTINGS_EMAIL_MAX_LENGTH,
  SETTINGS_PHONE_MAX_LENGTH,
  SETTINGS_TIMEZONE_MAX_LENGTH,
  SETTINGS_VAT_NUMBER_MAX_LENGTH,
  SETTINGS_WEBSITE_MAX_LENGTH,
  STAFF_LICENSE_NUMBER_MAX_LENGTH,
  STAFF_NAME_MAX_LENGTH,
  isValidSettingsTaxRate,
  isSupportedPracticeTimezone,
} from "@/lib/settings-policy";
import { sendStaffInviteEmail } from "@/lib/email";
import { appBaseUrl, exposeAuthLinksForPreview } from "@/lib/app-url";
import {
  ONBOARDING_INTENTS,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
import { isValidMigrationSource } from "@/lib/import/sources";
import { parseBookingPageConfig } from "@/lib/booking/page-config";
import { takeAppointmentSchedulingLock } from "@/lib/scheduling/location";
import { billingContactEmail } from "@/lib/billing/contact";
import {
  marketingEmailEnabledForRecipient,
  PlatformEmailPreferenceBlockedError,
  setMarketingEmailPreferenceForRecipient,
} from "@/lib/platform-email-preferences";

const adminProcedure = protectedProcedure.use(requireRole("admin"));

const requiredTrimmedString = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);
const optionalTrimmedString = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .optional();
const emailInput = z
  .string()
  .trim()
  .email()
  .max(SETTINGS_EMAIL_MAX_LENGTH)
  .transform((value) => value.toLowerCase());
const optionalEmailInput = emailInput.optional();
const countryInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Country must be a two-letter ISO country code")
  .transform((value) => value.toUpperCase());
const currencyInput = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Currency must be a three-letter ISO currency code")
  .transform((value) => value.toLowerCase());
const phoneInput = optionalTrimmedString("Phone", SETTINGS_PHONE_MAX_LENGTH);
const addressInput = optionalTrimmedString(
  "Address",
  SETTINGS_ADDRESS_MAX_LENGTH,
);
const timezoneInput = z
  .string()
  .trim()
  .min(1, "Timezone is required")
  .max(
    SETTINGS_TIMEZONE_MAX_LENGTH,
    `Timezone must be at most ${SETTINGS_TIMEZONE_MAX_LENGTH} characters`,
  )
  .refine(
    isSupportedPracticeTimezone,
    "Timezone must be a valid IANA timezone",
  );
const practiceNameInput = requiredTrimmedString(
  "Practice name",
  PRACTICE_NAME_MAX_LENGTH,
);
const locationNameInput = requiredTrimmedString(
  "Location name",
  LOCATION_NAME_MAX_LENGTH,
);
const staffNameInput = requiredTrimmedString(
  "Staff name",
  STAFF_NAME_MAX_LENGTH,
);
const licenseNumberInput = optionalTrimmedString(
  "License number",
  STAFF_LICENSE_NUMBER_MAX_LENGTH,
);
const appointmentTypeNameInput = requiredTrimmedString(
  "Appointment type name",
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
);
const roomNameInput = requiredTrimmedString("Room name", ROOM_NAME_MAX_LENGTH);
const providerScheduleTimeInput = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: "Provider hours must use 24-hour HH:MM time.",
  });
const providerScheduleWindowsInput = z
  .array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      startTime: providerScheduleTimeInput,
      endTime: providerScheduleTimeInput,
    }),
  )
  .max(21, "A provider can have at most three working windows per day.")
  .superRefine((windows, validation) => {
    const byDay = new Map<number, typeof windows>();
    for (const window of windows) {
      if (window.startTime >= window.endTime) {
        validation.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each provider working window must end after it starts.",
        });
      }
      const day = byDay.get(window.dayOfWeek) ?? [];
      day.push(window);
      byDay.set(window.dayOfWeek, day);
    }

    for (const day of byDay.values()) {
      if (day.length > 3) {
        validation.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A provider can have at most three working windows per day.",
        });
      }
      const ordered = [...day].sort((a, b) =>
        a.startTime.localeCompare(b.startTime),
      );
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index]!.startTime < ordered[index - 1]!.endTime) {
          validation.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provider working windows cannot overlap.",
          });
        }
      }
    }
  });

type ProviderScheduleRevisionRow = {
  id: string;
  locationId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

function providerScheduleRevision(
  timezone: string,
  primaryLocationId: string | null,
  providerLocationId: string | null,
  rows: ProviderScheduleRevisionRow[],
) {
  const schedule = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id,
      locationId: row.locationId,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime.slice(0, 5),
      endTime: row.endTime.slice(0, 5),
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        timezone,
        primaryLocationId,
        providerLocationId,
        schedule,
      }),
    )
    .digest("hex");
}
const activeSchedulingStatuses = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
] as const;
const tourStepIdInput = z
  .string()
  .trim()
  .max(128, "Tour step must be at most 128 characters")
  .nullish();

const journeyStepIdInput = z
  .string()
  .trim()
  .max(64, "Journey step must be at most 64 characters")
  .nullish();
const onboardingIntentInput = z.enum(ONBOARDING_INTENTS);

/**
 * At or above this many patients a practice counts as established, so the
 * first-run wizard never auto-opens for it. Hosted first-run demo data seeds
 * exactly 3 patients, keeping fresh signups safely below the bar.
 */
export const ESTABLISHED_PRACTICE_PATIENT_THRESHOLD = 5;

/**
 * Atomic JSONB patches for practices.settings. Wizard mutations land
 * concurrently (finishing fires while the step cursor is still persisting);
 * read-modify-write of the whole JSON loses whichever write commits first,
 * so patches must merge in-database against the current row.
 */
function settingsMergePatch(patch: Record<string, unknown>) {
  return sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

function onboardingStateMergePatch(patch: Record<string, unknown>) {
  return sql`jsonb_set(
    coalesce(${practices.settings}, '{}'::jsonb),
    '{onboardingState}',
    coalesce(${practices.settings}->'onboardingState', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
  )`;
}

/**
 * Selects (and may later change) the clinic's setup path without rewriting the
 * first time setup actually began. That timestamp is cohort evidence, not a
 * last-updated field.
 */
function onboardingIntentStatePatch(intent: OnboardingIntent, now: string) {
  return sql`jsonb_set(
    coalesce(${practices.settings}, '{}'::jsonb),
    '{onboardingState}',
    coalesce(${practices.settings}->'onboardingState', '{}'::jsonb) ||
      jsonb_build_object(
        'onboardingIntent', ${intent},
        'onboardingIntentSelectedAt', coalesce(
          nullif(${practices.settings}->'onboardingState'->>'onboardingIntentSelectedAt', ''),
          ${now}
        ),
        'journeyLastProgressAt', ${now},
        'journeyDismissed', false
      )
  )`;
}

/** Keep setup completion first-write-wins while recording fresh activity. */
function onboardingCompletionPatch(now: string) {
  return sql`jsonb_set(
    jsonb_set(
      coalesce(${practices.settings}, '{}'::jsonb),
      '{onboardingCompletedAt}',
      to_jsonb(coalesce(
        nullif(${practices.settings}->>'onboardingCompletedAt', ''),
        ${now}
      )::text)
    ),
    '{onboardingState}',
    coalesce(${practices.settings}->'onboardingState', '{}'::jsonb) ||
      jsonb_build_object('journeyLastProgressAt', ${now})
  )`;
}

function staffAdminRosterLockKey(practiceId: string) {
  return `settings:staff-admin-roster:${practiceId}`;
}

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: {
  db: Pick<Database, "select">;
  practiceId: string;
}) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function assertProviderHasNoActiveAppointments(ctx: {
  db: Pick<Database, "select">;
  practiceId: string;
  userId: string;
}) {
  const [activeAppointment] = await ctx.db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, ctx.userId),
        eq(appointments.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(appointments.deletedAt),
        inArray(appointments.status, activeSchedulingStatuses),
      ),
    )
    .limit(1);

  if (activeAppointment) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Reassign active appointments before removing veterinarian provider access.",
    });
  }

  const [activeSchedule] = await ctx.db
    .select({ id: staffSchedules.id })
    .from(staffSchedules)
    .where(
      and(
        eq(staffSchedules.userId, ctx.userId),
        eq(staffSchedules.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(staffSchedules.deletedAt),
      ),
    )
    .limit(1);
  if (activeSchedule) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Clear this provider's working hours before removing veterinarian provider access.",
    });
  }
}

async function assertPrimaryLocationCanChange(ctx: {
  db: Pick<Database, "select">;
  practiceId: string;
  nextPrimaryLocationId?: string;
}) {
  const [activeHours] = await ctx.db
    .select({ id: staffSchedules.id })
    .from(staffSchedules)
    .where(
      and(
        eq(staffSchedules.practiceId, ctx.practiceId),
        isNull(staffSchedules.deletedAt),
        sql`exists (
          select 1
          from ${locations}
          where ${locations.id} = ${staffSchedules.locationId}
            and ${locations.practiceId} = ${ctx.practiceId}
            and ${locations.isPrimary} = true
            and ${locations.deletedAt} is null
            ${ctx.nextPrimaryLocationId ? sql`and ${locations.id} <> ${ctx.nextPrimaryLocationId}` : sql``}
        )`,
      ),
    )
    .limit(1);
  if (activeHours) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Clear provider working hours at the current primary location before changing the primary location.",
    });
  }
}

async function syncBillingAfterStaffChange(
  db: Parameters<typeof syncPracticeSubscriptionQuantities>[0]["db"],
  practiceId: string,
): Promise<void> {
  try {
    await syncPracticeSubscriptionQuantities({ db, practiceId });
  } catch (err) {
    await alertOps(
      "Staff billing sync crashed",
      `practice=${practiceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function syncBillingAfterLocationChange(
  db: Parameters<typeof syncPracticeSubscriptionQuantities>[0]["db"],
  practiceId: string,
): Promise<void> {
  try {
    await syncPracticeSubscriptionQuantities({ db, practiceId });
  } catch (err) {
    await alertOps(
      "Location billing sync crashed",
      `practice=${practiceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface PracticeSettings {
  onboardingCompletedAt?: string | null;
  demoData?: DemoDataProvenance;
  onboardingDraft?: {
    logoName?: string;
    brandColor?: string;
    teamMembers?: Array<{
      name: string;
      email: string;
      role: "veterinarian" | "technician" | "front_desk" | "viewer";
    }>;
  };
  /** Live brand accent color (set in settings; logo lives in practices.logoUrl). */
  brandColor?: string;
  /** In-app value tour + finish-setup card progress. */
  onboardingState?: {
    tourStatus?: "not_started" | "in_progress" | "completed" | "skipped";
    lastStepId?: string | null;
    setupDismissed?: boolean;
    /** Adoption pathway selected on the first guided-setup step. */
    onboardingIntent?: OnboardingIntent;
    onboardingIntentSelectedAt?: string;
    /** Resume cursor for the "Make it yours" setup wizard (step id, not index). */
    journeyStepId?: string | null;
    /** Last successfully persisted journey action, used for stall recovery. */
    journeyLastProgressAt?: string;
    /** "I'll finish later" — suppresses auto-open without completing onboarding. */
    journeyDismissed?: boolean;
    /** Sticky marker: a reviewed migration committed real clinic data. */
    migrationHasCommittedChanges?: boolean;
    migrationLastCommittedAt?: string;
    /** Latest source and completed modes are derived from migration_runs. */
    migrationSource?: string | null;
    migrationSourceHasCommittedChanges?: boolean;
    migrationCompletedModes?: Array<
      "clients" | "patients" | "vaccinations" | "soapNotes"
    >;
    /** A clinic-admin request for an OpenVPM-assisted first setup session. */
    setupHelpRequestedAt?: string;
    setupHelpRequestedByUserId?: string;
    setupHelpRequestedByEmail?: string;
  };
  accountDeletionRequest?: {
    status: "requested";
    requestedAt: string;
    requestedByUserId: string;
    requestedByEmail: string;
    requestedByName?: string | null;
    contactEmail: string;
    reason?: string | null;
    retentionReviewRequired: true;
  } | null;
  [k: string]: unknown;
}

export const settingsRouter = createRouter({
  // ── Practice ──────────────────────────────────────────────

  getPractice: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select()
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    return practice;
  }),

  getMarketingEmailPreference: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ email: practices.email })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) throw practiceNotFound();

    const recipientEmail = billingContactEmail(practice.email);
    if (!recipientEmail) {
      return { enabled: true, configurable: false, recipientEmail: null };
    }
    let enabled: boolean;
    try {
      enabled = await marketingEmailEnabledForRecipient(recipientEmail);
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Email preferences are temporarily unavailable.",
      });
    }
    return {
      enabled,
      configurable: true,
      recipientEmail,
    };
  }),

  /**
   * The workspace owner keeps administrative authorization independently from
   * clinical provider status. This lets a solo veterinarian schedule and sign
   * visits without creating a second login or giving up the only admin seat.
   */
  getMyClinicalProfile: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const [user] = await ctx.db
      .select({
        id: users.id,
        isVeterinarian: users.isVeterinarian,
        licenseNumber: users.licenseNumber,
        locationId: users.locationId,
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
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    return user;
  }),

  updateMyClinicalProfile: adminProcedure
    .input(
      z.object({
        isVeterinarian: z.boolean(),
        licenseNumber: licenseNumberInput,
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
            ctx.practiceId,
          )}::text))`,
        );
        await assertActivePractice({ db: tx, practiceId: ctx.practiceId });
        const [user] = await tx
          .select({
            id: users.id,
            isVeterinarian: users.isVeterinarian,
            locationId: users.locationId,
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
          throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        }

        if (user.isVeterinarian && !input.isVeterinarian) {
          await assertProviderHasNoActiveAppointments({
            db: tx,
            practiceId: ctx.practiceId,
            userId: user.id,
          });
        }

        let locationId = user.locationId;
        if (!locationId) {
          const [primaryLocation] = await tx
            .select({ id: locations.id })
            .from(locations)
            .where(
              and(
                eq(locations.practiceId, ctx.practiceId),
                eq(locations.isPrimary, true),
                isNull(locations.deletedAt),
              ),
            )
            .limit(1);
          locationId = primaryLocation?.id ?? null;
        }

        const [updated] = await tx
          .update(users)
          .set({
            isVeterinarian: input.isVeterinarian,
            licenseNumber: input.licenseNumber ?? null,
            ...(locationId ? { locationId } : {}),
          })
          .where(
            and(
              eq(users.id, ctx.user.id),
              eq(users.practiceId, ctx.practiceId),
              isNull(users.deletedAt),
            ),
          )
          .returning({
            id: users.id,
            isVeterinarian: users.isVeterinarian,
            licenseNumber: users.licenseNumber,
            locationId: users.locationId,
          });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Your clinical profile changed. Refresh and retry.",
          });
        }
        return updated;
      }),
    ),

  updatePractice: adminProcedure
    .input(
      z.object({
        name: practiceNameInput.optional(),
        address: addressInput,
        phone: phoneInput,
        email: optionalEmailInput,
        website: optionalTrimmedString("Website", SETTINGS_WEBSITE_MAX_LENGTH),
        timezone: timezoneInput.optional(),
        // Region/locale (Phase 2). country is ISO 3166-1 alpha-2; currency is
        // ISO 4217 lowercase; taxRatePercent is a percent string e.g. "20.00".
        country: countryInput.optional(),
        currency: currencyInput.optional(),
        taxRatePercent: z
          .string()
          .trim()
          .refine(
            isValidSettingsTaxRate,
            "Tax rate must be between 0 and 100 with at most two decimals",
          )
          .optional(),
        vatNumber: optionalTrimmedString(
          "VAT number",
          SETTINGS_VAT_NUMBER_MAX_LENGTH,
        ),
        // Branding. logoUrl is a real column; brandColor lives in settings.
        logoUrl: optionalTrimmedString("Logo URL", 512),
        brandColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.transaction(async (tx) => {
        if (input.timezone !== undefined) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
              ctx.practiceId,
            )}::text))`,
          );
          const [currentPractice] = await tx
            .select({ timezone: practices.timezone })
            .from(practices)
            .where(activePracticeWhere(ctx.practiceId))
            .limit(1);
          if (!currentPractice) throw practiceNotFound();
          if (currentPractice.timezone !== input.timezone) {
            const [activeHours] = await tx
              .select({ id: staffSchedules.id })
              .from(staffSchedules)
              .where(
                and(
                  eq(staffSchedules.practiceId, ctx.practiceId),
                  isNull(staffSchedules.deletedAt),
                ),
              )
              .limit(1);
            if (activeHours) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message:
                  "Clear provider working hours before changing the practice timezone, then recreate them in the new timezone.",
              });
            }
          }
        }

        // brandColor isn't a column — merge it into practices.settings without
        // clobbering other keys.
        const { brandColor, ...columns } = input;
        const patch: Record<string, unknown> = { ...columns };
        // When the country changes, fill in any region fields the caller didn't
        // explicitly set (currency/tax) with that country's sensible defaults.
        if (input.country) {
          const defaults = regionDefaults(input.country);
          patch.country = input.country.toUpperCase();
          if (input.currency === undefined) patch.currency = defaults.currency;
          if (input.taxRatePercent === undefined)
            patch.taxRatePercent = defaults.taxRatePercent;
        }
        if (typeof patch.currency === "string") {
          patch.currency = (patch.currency as string).toLowerCase();
        }
        if (brandColor !== undefined) {
          patch.settings = settingsMergePatch({
            brandColor: brandColor.toLowerCase(),
          });
        }
        const [updated] = await tx
          .update(practices)
          .set(patch)
          .where(activePracticeWhere(ctx.practiceId))
          .returning();
        if (!updated) {
          throw practiceNotFound();
        }
        return updated!;
      }),
    ),

  setMarketingEmailPreference: adminProcedure
    .input(z.object({ enabled: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      const [practice] = await ctx.db
        .select({ email: practices.email })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) throw practiceNotFound();

      const recipientEmail = billingContactEmail(practice.email);
      if (!recipientEmail) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Add a valid practice email before changing this setting.",
        });
      }
      try {
        await setMarketingEmailPreferenceForRecipient({
          email: recipientEmail,
          enabled: input.enabled,
          source: "settings",
          updatedByUserId: ctx.user.id,
        });
      } catch (error) {
        if (error instanceof PlatformEmailPreferenceBlockedError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This address cannot be re-enabled from clinic Settings after unsubscribing or a delivery suppression. Use another verified practice email.",
          });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Email preferences are temporarily unavailable.",
        });
      }
      return {
        enabled: input.enabled,
        configurable: true,
        recipientEmail,
      };
    }),

  // ── Account Lifecycle ─────────────────────────────────────

  getAccountDeletionRequest: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const settings = (practice.settings ?? {}) as PracticeSettings;
    return settings.accountDeletionRequest ?? null;
  }),

  requestAccountDeletion: adminProcedure
    .input(
      z.object({
        contactEmail: emailInput,
        reason: optionalTrimmedString(
          "Deletion reason",
          ACCOUNT_DELETION_REASON_MAX_LENGTH,
        ),
        confirmExportDownloaded: z.literal(true),
        confirmManualReview: z.literal(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [practice] = await ctx.db
        .select({ name: practices.name, settings: practices.settings })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);
      if (!practice) {
        throw practiceNotFound();
      }

      const settings = (practice.settings ?? {}) as PracticeSettings;
      if (settings.accountDeletionRequest?.status === "requested") {
        return settings.accountDeletionRequest;
      }

      const reason = input.reason?.trim();
      const request = {
        status: "requested" as const,
        requestedAt: new Date().toISOString(),
        requestedByUserId: ctx.user.id,
        requestedByEmail: ctx.user.email,
        requestedByName: ctx.user.name ?? null,
        contactEmail: input.contactEmail,
        reason: reason ? reason : null,
        retentionReviewRequired: true as const,
      };

      await ctx.db
        .update(practices)
        .set({
          settings: settingsMergePatch({ accountDeletionRequest: request }),
        })
        .where(activePracticeWhere(ctx.practiceId));

      await alertOps(
        "Account deletion requested",
        [
          `practice=${ctx.practiceId}`,
          `practiceName=${practice.name}`,
          `requestedBy=${ctx.user.email}`,
          `contact=${request.contactEmail}`,
          "manualRetentionReviewRequired=true",
        ].join(" "),
      );

      return request;
    }),

  // ── Branding ──────────────────────────────────────────────

  /** Practice name, logo, and accent color — readable by any authenticated role. */
  getBranding: protectedProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({
        name: practices.name,
        logoUrl: practices.logoUrl,
        settings: practices.settings,
      })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const settings = (practice.settings ?? {}) as PracticeSettings;
    return {
      name: practice.name,
      logoUrl: practice.logoUrl ?? null,
      brandColor: settings.brandColor ?? null,
    };
  }),

  // ── Locations ─────────────────────────────────────────────

  listLocations: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select({
        id: locations.id,
        name: locations.name,
        address: locations.address,
        phone: locations.phone,
        isPrimary: locations.isPrimary,
        createdAt: locations.createdAt,
      })
      .from(locations)
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locations.deletedAt),
        ),
      );
  }),

  createLocation: adminProcedure
    .input(
      z.object({
        name: locationNameInput,
        address: addressInput,
        phone: phoneInput,
        isPrimary: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.transaction(async (tx) => {
        await assertActivePractice({ db: tx, practiceId: ctx.practiceId });
        if (input.isPrimary) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
              ctx.practiceId,
            )}::text))`,
          );
          await assertPrimaryLocationCanChange({
            db: tx,
            practiceId: ctx.practiceId,
          });
          await tx
            .update(locations)
            .set({ isPrimary: false })
            .where(
              and(
                eq(locations.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(locations.deletedAt),
              ),
            );
        }

        const [inserted] = await tx
          .insert(locations)
          .values({
            practiceId: ctx.practiceId,
            name: input.name,
            address: input.address,
            phone: input.phone,
            isPrimary: input.isPrimary ?? false,
          })
          .returning();
        return inserted!;
      });

      await syncBillingAfterLocationChange(ctx.db, ctx.practiceId);
      return created;
    }),

  updateLocation: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: locationNameInput.optional(),
        address: addressInput,
        phone: phoneInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [updated] = await ctx.db
        .update(locations)
        .set(data)
        .where(
          and(
            eq(locations.id, id),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt),
          ),
        )
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
      }

      return updated;
    }),

  setPrimaryLocation: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
            ctx.practiceId,
          )}::text))`,
        );
        await assertPrimaryLocationCanChange({
          db: tx,
          practiceId: ctx.practiceId,
          nextPrimaryLocationId: input.id,
        });

        const [target] = await tx
          .update(locations)
          .set({ isPrimary: true })
          .where(
            and(
              eq(locations.id, input.id),
              eq(locations.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locations.deletedAt),
            ),
          )
          .returning();

        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Location not found",
          });
        }

        await tx
          .update(locations)
          .set({ isPrimary: false })
          .where(
            and(
              eq(locations.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locations.deletedAt),
              ne(locations.id, input.id),
            ),
          );

        return target;
      });

      return updated;
    }),

  deleteLocation: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        await takeAppointmentSchedulingLock(
          tx as unknown as Database,
          ctx.practiceId,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
            ctx.practiceId,
          )}::text))`,
        );

        const activeLocations = await tx
          .select({ id: locations.id, isPrimary: locations.isPrimary })
          .from(locations)
          .where(
            and(
              eq(locations.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locations.deletedAt),
            ),
          );
        const target = activeLocations.find((loc) => loc.id === input.id);
        if (!target) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Location not found",
          });
        }
        if (activeLocations.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A practice must keep at least one active location",
          });
        }

        const [activeRoom] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(
            and(
              eq(rooms.locationId, input.id),
              eq(rooms.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(rooms.deletedAt),
            ),
          )
          .limit(1);
        if (activeRoom) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a location with active rooms.",
          });
        }

        const [activeUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.locationId, input.id),
              eq(users.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);
        if (activeUser) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a location assigned to active staff.",
          });
        }

        const [activeProduct] = await tx
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.locationId, input.id),
              eq(products.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(products.deletedAt),
            ),
          )
          .limit(1);
        if (activeProduct) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a location with active inventory products.",
          });
        }

        const [activeSchedule] = await tx
          .select({ id: staffSchedules.id })
          .from(staffSchedules)
          .where(
            and(
              eq(staffSchedules.locationId, input.id),
              eq(staffSchedules.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(staffSchedules.deletedAt),
            ),
          )
          .limit(1);
        if (activeSchedule) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a location with active staff schedules.",
          });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.locationId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeSchedulingStatuses),
            ),
          )
          .limit(1);
        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a location used by active appointments.",
          });
        }

        const [deleted] = await tx
          .update(locations)
          .set({ deletedAt: new Date(), isPrimary: false })
          .where(
            and(
              eq(locations.id, input.id),
              eq(locations.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locations.deletedAt),
            ),
          )
          .returning({ id: locations.id });

        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Location not found",
          });
        }

        await tx
          .update(locationMessaging)
          .set({ enabled: false })
          .where(
            and(
              eq(locationMessaging.locationId, input.id),
              eq(locationMessaging.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
            ),
          );

        if (target.isPrimary) {
          const replacement = activeLocations.find(
            (loc) => loc.id !== input.id,
          );
          if (replacement) {
            const [promoted] = await tx
              .update(locations)
              .set({ isPrimary: true })
              .where(
                and(
                  eq(locations.id, replacement.id),
                  eq(locations.practiceId, ctx.practiceId),
                  activePracticePredicate(ctx.practiceId),
                  isNull(locations.deletedAt),
                ),
              )
              .returning({ id: locations.id });

            if (!promoted) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "Location state changed; try again.",
              });
            }
          }
        }
      });

      await syncBillingAfterLocationChange(ctx.db, ctx.practiceId);
      return { success: true };
    }),

  // ── Onboarding ────────────────────────────────────────────

  /** Onboarding state for the first-run wizard / dashboard banner. */
  onboardingStatus: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const settings = (practice.settings ?? {}) as PracticeSettings;
    // A practice that already runs on real data (e.g. seeded demo, or a
    // self-host upgrading into the wizard feature) must not be greeted like
    // a brand-new signup, even though it never recorded a completion date.
    const demoAppointmentIds = settings.demoData?.appointmentIds ?? [];
    const realAppointmentFilter =
      demoAppointmentIds.length > 0
        ? notInArray(appointments.id, demoAppointmentIds)
        : undefined;
    const [
      existingPatients,
      firstRealAppointment,
      completedRealAppointment,
      completedRealVisit,
      nextRealAppointment,
    ] = await Promise.all([
      ctx.db
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .limit(ESTABLISHED_PRACTICE_PATIENT_THRESHOLD),
      ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt),
            realAppointmentFilter,
          ),
        )
        .limit(1),
      ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            eq(appointments.status, "checked_out"),
            isNull(appointments.deletedAt),
            realAppointmentFilter,
          ),
        )
        .limit(1),
      ctx.db
        .select({ id: visitCloseouts.id })
        .from(visitCloseouts)
        .innerJoin(
          appointments,
          and(
            eq(appointments.id, visitCloseouts.appointmentId),
            eq(appointments.practiceId, ctx.practiceId),
            isNull(appointments.deletedAt),
            realAppointmentFilter,
          ),
        )
        .where(
          and(
            eq(visitCloseouts.practiceId, ctx.practiceId),
            eq(visitCloseouts.status, "completed"),
            isNull(visitCloseouts.deletedAt),
          ),
        )
        .limit(1),
      ctx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            inArray(appointments.status, activeSchedulingStatuses),
            isNull(appointments.deletedAt),
            realAppointmentFilter,
          ),
        )
        .orderBy(
          sql`case ${appointments.status}
              when 'in_exam' then 0
              when 'checked_in' then 1
              when 'confirmed' then 2
              when 'scheduled' then 3
              else 4
            end`,
          asc(appointments.startTime),
          asc(appointments.id),
        )
        .limit(1),
    ]);
    const demoPatientIds = new Set(settings.demoData?.patientIds ?? []);
    return {
      completedAt: settings.onboardingCompletedAt ?? null,
      hasDemoData: hasLiveDemoData(settings.demoData),
      // A secondary-PIMS buyer reaches a real-data milestone without having to
      // delete the sample clinic first. This also keeps the checklist honest
      // when real and demo patients intentionally coexist during evaluation.
      hasRealData: existingPatients.some(
        (patient) => !demoPatientIds.has(patient.id),
      ),
      // Scheduling a real appointment is the first operational commitment in
      // the clinic-ready path. Demo appointments must never complete it.
      hasRealAppointment: firstRealAppointment.length > 0,
      // Checked out is the first durable signal that the practice has run the
      // legacy workflow, rather than merely exploring the calendar.
      hasCompletedRealAppointment: completedRealAppointment.length > 0,
      // The clinic-ready activation gate is stronger: the closeout constraint
      // proves clinical finalization, owner handoff, and an attributable
      // paid/AR/no-charge disposition for a real tenant-owned appointment.
      hasCompletedRealVisit: completedRealVisit.length > 0,
      // Resume the most advanced nonterminal visit without adding another
      // client request. Stable status/time/id ordering keeps the CTA durable.
      nextRealAppointmentId: nextRealAppointment[0]?.id ?? null,
      onboardingDraft: settings.onboardingDraft ?? null,
      establishedPractice:
        existingPatients.length >= ESTABLISHED_PRACTICE_PATIENT_THRESHOLD,
    };
  }),

  /**
   * Data the welcome guides need, readable by ANY authenticated role (the
   * welcome surface greets invited staff too, unlike the admin-only wizard).
   * Prefers the seeded demo client/patient while they are alive, then falls
   * back to the practice's first real client so guides degrade gracefully
   * after demo data is cleared.
   */
  welcomeContext: protectedProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ name: practices.name, settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const settings = (practice.settings ?? {}) as PracticeSettings;
    const demo = settings.demoData;

    let portalClient: {
      id: string;
      firstName: string;
      lastName: string;
    } | null = null;
    const demoClientId = demo?.clientIds?.[0];
    if (demoClientId) {
      const [row] = await ctx.db
        .select({
          id: clients.id,
          firstName: clients.firstName,
          lastName: clients.lastName,
        })
        .from(clients)
        .where(
          and(
            eq(clients.id, demoClientId),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .limit(1);
      portalClient = row ?? null;
    }
    if (!portalClient) {
      const [row] = await ctx.db
        .select({
          id: clients.id,
          firstName: clients.firstName,
          lastName: clients.lastName,
        })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        )
        .limit(1);
      portalClient = row ?? null;
    }

    let demoPatientName: string | null = null;
    let demoPatientId: string | null = null;
    const candidatePatientId = demo?.patientIds?.[0];
    if (candidatePatientId) {
      const [row] = await ctx.db
        .select({ id: patients.id, name: patients.name })
        .from(patients)
        .where(
          and(
            eq(patients.id, candidatePatientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .limit(1);
      demoPatientName = row?.name ?? null;
      demoPatientId = row?.id ?? null;
    }

    // A live sample invoice lets the welcome tour open a real bill.
    let demoInvoiceId: string | null = null;
    const candidateInvoiceId = demo?.invoiceIds?.[0];
    if (candidateInvoiceId) {
      const [row] = await ctx.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, candidateInvoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1);
      demoInvoiceId = row?.id ?? null;
    }

    return {
      practiceName: practice.name,
      hasDemoData: hasLiveDemoData(demo),
      portalClient,
      demoPatientName,
      demoPatientId,
      demoInvoiceId,
    };
  }),

  /** Mark onboarding complete. */
  completeOnboarding: adminProcedure.mutation(async ({ ctx }) => {
    const completedAt = new Date().toISOString();
    const [updated] = await ctx.db
      .update(practices)
      .set({
        settings: onboardingCompletionPatch(completedAt),
      })
      .where(activePracticeWhere(ctx.practiceId))
      .returning({ id: practices.id });
    if (!updated) {
      throw practiceNotFound();
    }
    return { ok: true };
  }),

  /** Read the in-app value-tour + finish-setup progress. */
  getOnboardingState: adminProcedure.query(async ({ ctx }) => {
    const [practiceRows, committedRuns] = await Promise.all([
      ctx.db
        .select({ settings: practices.settings })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1),
      ctx.db
        .select({
          mode: migrationRuns.mode,
          source: migrationRuns.source,
          importedCount: migrationRuns.importedCount,
          reconciledCount: migrationRuns.reconciledCount,
          committedAt: migrationRuns.committedAt,
        })
        .from(migrationRuns)
        .where(
          and(
            eq(migrationRuns.practiceId, ctx.practiceId),
            eq(migrationRuns.status, "committed"),
            isNull(migrationRuns.deletedAt),
          ),
        )
        .orderBy(desc(migrationRuns.committedAt), desc(migrationRuns.id)),
    ]);
    const practice = practiceRows[0];
    if (!practice) {
      throw practiceNotFound();
    }
    const settings = (practice.settings ?? {}) as PracticeSettings;
    const savedState = settings.onboardingState ?? {};
    const latestCommittedRun = committedRuns[0];
    const latestMigrationSource = isValidMigrationSource(
      latestCommittedRun?.source,
    )
      ? latestCommittedRun.source
      : null;
    const completedModes = Array.from(
      new Set(
        committedRuns
          .filter((run) => run.source === latestMigrationSource)
          .map((run) =>
            run.mode === "soap_notes" ? ("soapNotes" as const) : run.mode,
          ),
      ),
    );
    const ledgerHasCommittedChanges = committedRuns.some(
      (run) => run.importedCount + run.reconciledCount > 0,
    );
    const latestSourceHasCommittedChanges = committedRuns.some(
      (run) =>
        run.source === latestMigrationSource &&
        run.importedCount + run.reconciledCount > 0,
    );
    const defaults = {
      tourStatus: "not_started" as const,
      lastStepId: null,
      setupDismissed: false,
      onboardingIntent: null,
      onboardingIntentSelectedAt: null,
      journeyStepId: null,
      journeyLastProgressAt: null,
      journeyDismissed: false,
      migrationHasCommittedChanges: false,
      migrationLastCommittedAt: null,
      migrationSource: null as string | null,
      migrationSourceHasCommittedChanges: false,
      migrationCompletedModes: [] as Array<
        "clients" | "patients" | "vaccinations" | "soapNotes"
      >,
    };
    return {
      ...defaults,
      ...savedState,
      // migration_runs is authoritative for reviewed imports. The settings
      // marker remains only as a fallback for compatibility-window commits
      // that predate the run ledger.
      migrationHasCommittedChanges:
        ledgerHasCommittedChanges ||
        savedState.migrationHasCommittedChanges === true,
      migrationLastCommittedAt:
        latestCommittedRun?.committedAt?.toISOString() ??
        savedState.migrationLastCommittedAt ??
        null,
      migrationSource: latestMigrationSource,
      migrationSourceHasCommittedChanges: latestSourceHasCommittedChanges,
      migrationCompletedModes: completedModes,
    };
  }),

  /** Persist tour progress (resume / skip / complete). */
  setTourStatus: adminProcedure
    .input(
      z.object({
        status: z.enum(["not_started", "in_progress", "completed", "skipped"]),
        lastStepId: tourStepIdInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = { tourStatus: input.status };
      if (input.lastStepId != null) patch.lastStepId = input.lastStepId;

      const [updated] = await ctx.db
        .update(practices)
        .set({ settings: onboardingStateMergePatch(patch) })
        .where(activePracticeWhere(ctx.practiceId))
        .returning({ id: practices.id });
      if (!updated) {
        throw practiceNotFound();
      }
      return { ok: true };
    }),

  /** Persist the selected adoption path for tailored setup and funnel review. */
  setOnboardingIntent: adminProcedure
    .input(z.object({ intent: onboardingIntentInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date().toISOString();
      const [updated] = await ctx.db
        .update(practices)
        .set({
          settings: onboardingIntentStatePatch(input.intent, now),
        })
        .where(activePracticeWhere(ctx.practiceId))
        .returning({ id: practices.id });
      if (!updated) {
        throw practiceNotFound();
      }
      return { ok: true };
    }),

  /**
   * Persist "Make it yours" setup-wizard progress. `stepId` is the resume
   * cursor; `dismissed: true` records "I'll finish later" (suppresses auto-open
   * without marking onboarding complete). Mirrors setTourStatus.
   */
  setJourneyProgress: adminProcedure
    .input(
      z.object({
        stepId: journeyStepIdInput,
        dismissed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Record<string, unknown> = {
        journeyLastProgressAt: new Date().toISOString(),
      };
      if (input.stepId != null) patch.journeyStepId = input.stepId;
      if (input.dismissed !== undefined)
        patch.journeyDismissed = input.dismissed;

      const [updated] = await ctx.db
        .update(practices)
        .set({ settings: onboardingStateMergePatch(patch) })
        .where(activePracticeWhere(ctx.practiceId))
        .returning({ id: practices.id });
      if (!updated) {
        throw practiceNotFound();
      }
      return { ok: true };
    }),

  /**
   * Let a stalled clinic ask for hands-on setup without leaving the product.
   * The durable marker makes retries idempotent and keeps the request visible
   * even if the optional ops-alert webhook is temporarily unavailable.
   */
  requestOnboardingHelp: adminProcedure.mutation(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ name: practices.name, settings: practices.settings })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }

    const settings = (practice.settings ?? {}) as PracticeSettings;
    const existingRequestedAt = settings.onboardingState?.setupHelpRequestedAt;
    if (existingRequestedAt) {
      return { requestedAt: existingRequestedAt };
    }

    const requestedAt = new Date().toISOString();
    const [updated] = await ctx.db
      .update(practices)
      .set({
        settings: onboardingStateMergePatch({
          setupHelpRequestedAt: requestedAt,
          setupHelpRequestedByUserId: ctx.user.id,
          setupHelpRequestedByEmail: ctx.user.email,
        }),
      })
      .where(activePracticeWhere(ctx.practiceId))
      .returning({ id: practices.id });
    if (!updated) {
      throw practiceNotFound();
    }

    await alertOps(
      "Hands-on onboarding requested",
      [
        `practice=${ctx.practiceId}`,
        `practiceName=${practice.name}`,
        `requestedBy=${ctx.user.email}`,
        `requestedAt=${requestedAt}`,
      ].join(" "),
    );

    return { requestedAt };
  }),

  /** Dismiss the dashboard "finish setup" card. */
  dismissSetup: adminProcedure.mutation(async ({ ctx }) => {
    const [updated] = await ctx.db
      .update(practices)
      .set({ settings: onboardingStateMergePatch({ setupDismissed: true }) })
      .where(activePracticeWhere(ctx.practiceId))
      .returning({ id: practices.id });
    if (!updated) {
      throw practiceNotFound();
    }
    return { ok: true };
  }),

  /** Remove the seeded demo clients/patients/appointments (soft delete). */
  clearDemoData: adminProcedure.mutation(async ({ ctx }) => {
    const result = await clearSeededDemoData(ctx.db, ctx.practiceId);
    if (!result.found) throw practiceNotFound();
    return { ok: true, alreadyCleared: result.alreadyCleared };
  }),

  /** Add the sample clients, pets, and visits back. No-op if already present. */
  reseedDemoData: adminProcedure.mutation(async ({ ctx }) => {
    const result = await reseedSampleClinic(ctx.db, ctx.practiceId);
    if (!result.found) throw practiceNotFound();
    return { ok: true, alreadyPresent: result.alreadyPresent };
  }),

  // ── Staff / Users ─────────────────────────────────────────

  listUsers: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isVeterinarian: users.isVeterinarian,
        locationId: users.locationId,
        phone: users.phone,
        licenseNumber: users.licenseNumber,
        createdAt: users.createdAt,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(
        and(
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt),
        ),
      );
  }),

  /** Weekly veterinarian hours by clinic location, in the practice timezone. */
  providerScheduleSetup: adminProcedure.query(async ({ ctx }) => {
    const [practice] = await ctx.db
      .select({ timezone: practices.timezone })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) throw practiceNotFound();

    const activeLocations = await ctx.db
      .select({
        id: locations.id,
        name: locations.name,
        isPrimary: locations.isPrimary,
      })
      .from(locations)
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          isNull(locations.deletedAt),
        ),
      )
      .orderBy(
        desc(locations.isPrimary),
        asc(locations.name),
        asc(locations.id),
      );
    const primaryLocation = activeLocations.find(
      (location) => location.isPrimary,
    );

    const providers = await ctx.db
      .select({
        id: users.id,
        name: users.name,
        locationId: users.locationId,
      })
      .from(users)
      .where(
        and(
          eq(users.practiceId, ctx.practiceId),
          eq(users.isVeterinarian, true),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(asc(users.name), asc(users.id));

    const scheduleRows = await ctx.db
      .select({
        id: staffSchedules.id,
        userId: staffSchedules.userId,
        locationId: staffSchedules.locationId,
        dayOfWeek: staffSchedules.dayOfWeek,
        startTime: staffSchedules.startTime,
        endTime: staffSchedules.endTime,
      })
      .from(staffSchedules)
      .where(
        and(
          eq(staffSchedules.practiceId, ctx.practiceId),
          isNull(staffSchedules.deletedAt),
        ),
      )
      .orderBy(
        asc(staffSchedules.userId),
        asc(staffSchedules.dayOfWeek),
        asc(staffSchedules.startTime),
        asc(staffSchedules.id),
      );

    return {
      timezone: practice.timezone,
      primaryLocation: primaryLocation ?? null,
      providers: providers.map((provider) => {
        const providerRows = scheduleRows.filter(
          (row) => row.userId === provider.id,
        );
        return {
          ...provider,
          unspecifiedWindowCount: providerRows.filter(
            (row) => row.locationId === null,
          ).length,
          revision: providerScheduleRevision(
            practice.timezone,
            primaryLocation?.id ?? null,
            provider.locationId,
            providerRows,
          ),
          locationSchedules: activeLocations.map((location) => ({
            locationId: location.id,
            windows: providerRows
              .filter((row) => row.locationId === location.id)
              .map((row) => ({
                dayOfWeek: row.dayOfWeek,
                startTime: row.startTime.slice(0, 5),
                endTime: row.endTime.slice(0, 5),
              })),
          })),
        };
      }),
      locations: activeLocations,
    };
  }),

  replaceProviderSchedule: adminProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        locationId: z.string().uuid().optional(),
        windows: providerScheduleWindowsInput,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        // Retained briefly so a client loaded before this release fails safe
        // instead of failing validation during the deployment window.
        moveToPrimaryLocation: z.boolean().optional(),
        replaceOtherLocationHours: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
            ctx.practiceId,
          )}::text))`,
        );

        const activeLocations = await tx
          .select({
            id: locations.id,
            name: locations.name,
            isPrimary: locations.isPrimary,
            timezone: practices.timezone,
          })
          .from(locations)
          .innerJoin(
            practices,
            and(
              eq(practices.id, locations.practiceId),
              eq(practices.id, ctx.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .where(
            and(
              eq(locations.practiceId, ctx.practiceId),
              isNull(locations.deletedAt),
            ),
          )
          .orderBy(asc(locations.createdAt), asc(locations.id))
          .for("share");
        const primaryLocation = activeLocations.find(
          (location) => location.isPrimary,
        );
        const targetLocation = input.locationId
          ? activeLocations.find((location) => location.id === input.locationId)
          : primaryLocation;
        if (!targetLocation) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: input.locationId
              ? "Choose an active clinic location before saving provider hours."
              : "Set a primary location before adding provider hours.",
          });
        }

        const [provider] = await tx
          .select({
            id: users.id,
            locationId: users.locationId,
            isVeterinarian: users.isVeterinarian,
          })
          .from(users)
          .where(
            and(
              eq(users.id, input.userId),
              eq(users.practiceId, ctx.practiceId),
              eq(users.isVeterinarian, true),
              isNull(users.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!provider) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Active veterinarian provider not found.",
          });
        }

        const currentRows = await tx
          .select({
            id: staffSchedules.id,
            locationId: staffSchedules.locationId,
            dayOfWeek: staffSchedules.dayOfWeek,
            startTime: staffSchedules.startTime,
            endTime: staffSchedules.endTime,
          })
          .from(staffSchedules)
          .where(
            and(
              eq(staffSchedules.practiceId, ctx.practiceId),
              eq(staffSchedules.userId, provider.id),
              isNull(staffSchedules.deletedAt),
            ),
          )
          .orderBy(asc(staffSchedules.id))
          .for("update");

        if (
          providerScheduleRevision(
            targetLocation.timezone,
            primaryLocation?.id ?? null,
            provider.locationId,
            currentRows,
          ) !== input.expectedRevision
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Provider hours changed; refresh and try again.",
          });
        }

        await tx
          .update(staffSchedules)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(staffSchedules.practiceId, ctx.practiceId),
              eq(staffSchedules.userId, provider.id),
              eq(staffSchedules.locationId, targetLocation.id),
              isNull(staffSchedules.deletedAt),
            ),
          );

        const orderedWindows = [...input.windows].sort(
          (left, right) =>
            left.dayOfWeek - right.dayOfWeek ||
            left.startTime.localeCompare(right.startTime),
        );
        if (orderedWindows.length > 0) {
          await tx.insert(staffSchedules).values(
            orderedWindows.map((window) => ({
              practiceId: ctx.practiceId,
              userId: provider.id,
              locationId: targetLocation.id,
              dayOfWeek: window.dayOfWeek,
              startTime: window.startTime,
              endTime: window.endTime,
            })),
          );
        }

        return {
          userId: provider.id,
          locationId: targetLocation.id,
          windowCount: orderedWindows.length,
        };
      });
    }),

  createUser: adminProcedure
    .input(
      z.object({
        name: staffNameInput,
        email: emailInput,
        password: authPasswordInput,
        role: z.enum([
          "admin",
          "veterinarian",
          "technician",
          "front_desk",
          "viewer",
        ]),
        phone: phoneInput,
        licenseNumber: licenseNumberInput,
        isVeterinarian: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const { password, isVeterinarian, ...rest } = input;
      const [existing] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, rest.email))
        .limit(1);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with that email already exists.",
        });
      }

      const passwordHash = await hash(password, PASSWORD_HASH_COST);
      const [user] = await ctx.db
        .insert(users)
        .values({
          ...rest,
          isVeterinarian:
            rest.role === "veterinarian" || isVeterinarian === true,
          passwordHash,
          practiceId: ctx.practiceId,
        })
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          isVeterinarian: users.isVeterinarian,
        });
      await syncBillingAfterStaffChange(ctx.db, ctx.practiceId);
      return user!;
    }),

  /**
   * Invite a staff member by email. Creates the user with an unguessable
   * placeholder password (passwordHash is NOT NULL) and an unverified email,
   * then emails an "invite" link to set their password via /accept-invite.
   */
  inviteStaff: adminProcedure
    .input(
      z.object({
        email: emailInput,
        name: optionalTrimmedString("Staff name", STAFF_NAME_MAX_LENGTH),
        role: z.enum([
          "admin",
          "veterinarian",
          "technician",
          "front_desk",
          "viewer",
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const email = input.email.trim().toLowerCase();

      const [practice] = await ctx.db
        .select({ name: practices.name })
        .from(practices)
        .where(activePracticeWhere(ctx.practiceId))
        .limit(1);

      if (!practice) {
        throw practiceNotFound();
      }

      const [existing] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A user with that email already exists.",
        });
      }

      // Derive a display name from the email local-part when not provided.
      const name =
        input.name?.trim() ||
        (() => {
          const local = email.split("@")[0] ?? "";
          const words = local
            .split(/[._-]+/)
            .filter(Boolean)
            .map((w) => w[0]!.toUpperCase() + w.slice(1));
          return words.join(" ") || "Team Member";
        })();

      // Unguessable placeholder — replaced when the invite is accepted.
      const passwordHash = await hash(
        `invite:${randomUUID()}:${randomUUID()}`,
        PASSWORD_HASH_COST,
      );

      const [user] = await ctx.db
        .insert(users)
        .values({
          email,
          name,
          role: input.role,
          isVeterinarian: input.role === "veterinarian",
          passwordHash,
          emailVerifiedAt: null,
          practiceId: ctx.practiceId,
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          isVeterinarian: users.isVeterinarian,
        });

      const token = await createAuthToken({
        userId: user!.id,
        email: user!.email,
        type: "invite",
        db: ctx.db,
      });
      const inviteUrl = `${appBaseUrl()}/accept-invite?token=${token}`;

      try {
        await sendStaffInviteEmail({
          to: user!.email,
          inviterName: ctx.user.name,
          practiceName: practice.name,
          inviteUrl,
        });
      } catch (err) {
        console.error("[inviteStaff] email failed:", err);
      }

      await syncBillingAfterStaffChange(ctx.db, ctx.practiceId);

      return {
        ok: true,
        inviteUrl: exposeAuthLinksForPreview() ? inviteUrl : undefined,
      };
    }),

  updateUser: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: staffNameInput.optional(),
        role: z
          .enum(["admin", "veterinarian", "technician", "front_desk", "viewer"])
          .optional(),
        phone: phoneInput,
        licenseNumber: licenseNumberInput,
        isVeterinarian: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...requestedData } = input;
      if (
        requestedData.role === "veterinarian" &&
        requestedData.isVeterinarian === false
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A veterinarian staff role must remain a veterinarian provider.",
        });
      }
      const data = {
        ...requestedData,
        ...(requestedData.role === "veterinarian"
          ? { isVeterinarian: true }
          : {}),
      };
      if (
        (data.role !== undefined && data.role !== "admin") ||
        data.isVeterinarian === false
      ) {
        return ctx.db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
              ctx.practiceId,
            )}::text))`,
          );

          const [targetUser] = await tx
            .select({
              id: users.id,
              role: users.role,
              isVeterinarian: users.isVeterinarian,
            })
            .from(users)
            .where(
              and(
                eq(users.id, id),
                eq(users.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(users.deletedAt),
              ),
            )
            .limit(1);

          if (!targetUser) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "User not found",
            });
          }

          if (
            data.role !== undefined &&
            data.role !== "admin" &&
            targetUser.role === "admin"
          ) {
            const [otherAdmin] = await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.practiceId, ctx.practiceId),
                  eq(users.role, "admin"),
                  ne(users.id, id),
                  activePracticePredicate(ctx.practiceId),
                  isNull(users.deletedAt),
                ),
              )
              .limit(1);

            if (!otherAdmin) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "A practice must keep at least one active admin user.",
              });
            }
          }

          if (targetUser.isVeterinarian && data.isVeterinarian === false) {
            await assertProviderHasNoActiveAppointments({
              db: tx,
              practiceId: ctx.practiceId,
              userId: targetUser.id,
            });
          }

          const [updated] = await tx
            .update(users)
            .set(data)
            .where(
              and(
                eq(users.id, id),
                eq(users.practiceId, ctx.practiceId),
                eq(users.role, targetUser.role),
                activePracticePredicate(ctx.practiceId),
                isNull(users.deletedAt),
              ),
            )
            .returning();

          if (!updated) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Staff member changed. Refresh and try again.",
            });
          }

          return updated;
        });
      }

      const [updated] = await ctx.db
        .update(users)
        .set(data)
        .where(
          and(
            eq(users.id, id),
            eq(users.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(users.deletedAt),
          ),
        )
        .returning();
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }
      return updated;
    }),

  deactivateUser: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot deactivate your own user account.",
        });
      }

      await ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${staffAdminRosterLockKey(
            ctx.practiceId,
          )}::text))`,
        );

        const [targetUser] = await tx
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(
            and(
              eq(users.id, input.id),
              eq(users.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(users.deletedAt),
            ),
          )
          .limit(1);

        if (!targetUser) {
          throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        }

        if (targetUser.role === "admin") {
          const [otherAdmin] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.practiceId, ctx.practiceId),
                eq(users.role, "admin"),
                ne(users.id, input.id),
                activePracticePredicate(ctx.practiceId),
                isNull(users.deletedAt),
              ),
            )
            .limit(1);

          if (!otherAdmin) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A practice must keep at least one active admin user.",
            });
          }
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.doctorId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeSchedulingStatuses),
            ),
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot deactivate a staff member assigned to active appointments.",
          });
        }

        const [activeSchedule] = await tx
          .select({ id: staffSchedules.id })
          .from(staffSchedules)
          .where(
            and(
              eq(staffSchedules.userId, input.id),
              eq(staffSchedules.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(staffSchedules.deletedAt),
            ),
          )
          .limit(1);

        if (activeSchedule) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot deactivate a staff member with an active staff schedule.",
          });
        }

        const [updated] = await tx
          .update(users)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(users.id, input.id),
              eq(users.practiceId, ctx.practiceId),
              eq(users.role, targetUser.role),
              activePracticePredicate(ctx.practiceId),
              isNull(users.deletedAt),
            ),
          )
          .returning({ id: users.id });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Staff member changed. Refresh and try again.",
          });
        }
      });
      await syncBillingAfterStaffChange(ctx.db, ctx.practiceId);
      return { success: true };
    }),

  restoreUser: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(users)
        .set({ deletedAt: null })
        .where(
          and(
            eq(users.id, input.id),
            eq(users.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
          ),
        )
        .returning({ id: users.id });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }
      await syncBillingAfterStaffChange(ctx.db, ctx.practiceId);
      return { success: true };
    }),

  // ── Appointment Types ─────────────────────────────────────

  listAppointmentTypes: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(appointmentTypes)
      .where(
        and(
          eq(appointmentTypes.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointmentTypes.deletedAt),
        ),
      );
  }),

  createAppointmentType: adminProcedure
    .input(
      z.object({
        name: appointmentTypeNameInput,
        durationMinutes: z
          .number()
          .int()
          .min(APPOINTMENT_TYPE_DURATION_MIN_MINUTES)
          .max(APPOINTMENT_TYPE_DURATION_MAX_MINUTES),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        requiresDoctor: z.number().int().min(0).max(1).default(1),
        defaultRoomType: z
          .enum(["exam", "surgery", "treatment", "boarding"])
          .default("exam"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [type] = await ctx.db
        .insert(appointmentTypes)
        .values({ ...input, practiceId: ctx.practiceId })
        .returning();
      return type!;
    }),

  updateAppointmentType: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: appointmentTypeNameInput.optional(),
        durationMinutes: z
          .number()
          .int()
          .min(APPOINTMENT_TYPE_DURATION_MIN_MINUTES)
          .max(APPOINTMENT_TYPE_DURATION_MAX_MINUTES)
          .optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        requiresDoctor: z.number().int().min(0).max(1).optional(),
        defaultRoomType: z
          .enum(["exam", "surgery", "treatment", "boarding"])
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const [updated] = await ctx.db
        .update(appointmentTypes)
        .set(data)
        .where(
          and(
            eq(appointmentTypes.id, id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointmentTypes.deletedAt),
          ),
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Appointment type not found",
        });
      }
      return updated;
    }),

  deleteAppointmentType: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [type] = await tx
          .select({ id: appointmentTypes.id })
          .from(appointmentTypes)
          .where(
            and(
              eq(appointmentTypes.id, input.id),
              eq(appointmentTypes.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointmentTypes.deletedAt),
            ),
          )
          .for("update");

        if (!type) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Appointment type not found",
          });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.typeId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeSchedulingStatuses),
            ),
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete an appointment type used by active appointments.",
          });
        }

        const [waitingEntry] = await tx
          .select({ id: appointmentWaitlist.id })
          .from(appointmentWaitlist)
          .where(
            and(
              eq(appointmentWaitlist.typeId, input.id),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(appointmentWaitlist.status, "waiting"),
              isNull(appointmentWaitlist.deletedAt),
            ),
          )
          .limit(1);

        if (waitingEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete an appointment type used by waiting appointment requests.",
          });
        }

        const [publishedPage] = await tx
          .select({ config: bookingPages.config })
          .from(bookingPages)
          .where(
            and(
              eq(bookingPages.practiceId, ctx.practiceId),
              eq(bookingPages.published, true),
              isNull(bookingPages.deletedAt),
            ),
          )
          .limit(1);

        if (
          publishedPage &&
          parseBookingPageConfig(publishedPage.config).bookableTypeIds.includes(
            input.id,
          )
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Unpublish the appointment request page or remove this visit type from it before deleting the type.",
          });
        }

        const [deleted] = await tx
          .update(appointmentTypes)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(appointmentTypes.id, input.id),
              eq(appointmentTypes.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointmentTypes.deletedAt),
            ),
          )
          .returning({ id: appointmentTypes.id });
        if (!deleted) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Appointment type not found",
          });
        }
      });
      return { success: true };
    }),

  // ── Rooms ─────────────────────────────────────────────────

  listRooms: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(rooms.deletedAt),
        ),
      );
  }),

  createRoom: adminProcedure
    .input(
      z.object({
        name: roomNameInput,
        type: z.enum(["exam", "surgery", "treatment", "boarding"]),
        locationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await assertActivePractice({ db: tx, practiceId: ctx.practiceId });
        const [location] = await tx
          .select({ id: locations.id })
          .from(locations)
          .where(
            and(
              eq(locations.id, input.locationId),
              eq(locations.practiceId, ctx.practiceId),
              isNull(locations.deletedAt),
            ),
          )
          .limit(1)
          .for("share");
        if (!location) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Location not found",
          });
        }
        const [room] = await tx
          .insert(rooms)
          .values({ ...input, practiceId: ctx.practiceId })
          .returning();
        return room!;
      });
    }),

  deleteRoom: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        await takeAppointmentSchedulingLock(
          tx as unknown as Database,
          ctx.practiceId,
        );
        const [room] = await tx
          .select({ id: rooms.id })
          .from(rooms)
          .where(
            and(
              eq(rooms.id, input.id),
              eq(rooms.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(rooms.deletedAt),
            ),
          )
          .limit(1);

        if (!room) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.roomId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeSchedulingStatuses),
            ),
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a room used by active appointments.",
          });
        }

        const [deleted] = await tx
          .update(rooms)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(rooms.id, input.id),
              eq(rooms.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(rooms.deletedAt),
            ),
          )
          .returning({ id: rooms.id });
        if (!deleted) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Room not found" });
        }
      });
      return { success: true };
    }),
});
