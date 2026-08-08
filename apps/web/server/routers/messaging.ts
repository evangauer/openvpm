import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  locations,
  locationMessaging,
  messagingRegistrations,
  clients,
  smsSuppressions,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { usageForPractice, currentPeriodMonth } from "@/lib/billing/usage";
import { getPlan } from "@/lib/billing/plans";
import { normalizeE164 } from "@/lib/messaging";
import { summarizeInboxSmsStatus } from "@/lib/messaging/inbox-status";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import {
  MESSAGING_AREA_CODE_LENGTH,
  MESSAGING_PHONE_MAX_LENGTH,
  MESSAGING_PHONE_MIN_LENGTH,
  MESSAGING_SEARCH_LIMIT_MAX,
} from "@/lib/messaging/policy";
import { sendSms } from "@/lib/sms";
import {
  searchAvailableNumbers,
  checkHostedEligibility,
  createMessagingProfile,
  buyNumber,
  createHostedOrder,
  TelnyxNotConfiguredError,
} from "@/lib/messaging/telnyx-provisioning";
import { appBaseUrl, normalizeAppBaseUrl } from "@/lib/app-url";
import {
  encryptRegistrationTaxId,
  MessagingRegistrationEncryptionError,
} from "@/lib/messaging/registration-crypto";
import { messagingProgramUrls } from "@/lib/messaging/public-program";

const adminOnly = protectedProcedure.use(requireRole("admin"));
const MESSAGING_REGISTRATION_PENDING_DETAIL =
  "Carrier registration (A2P 10DLC) in progress — required before messages can send; typically 1–2 weeks.";

const messagingPhoneInput = z
  .string()
  .trim()
  .min(
    MESSAGING_PHONE_MIN_LENGTH,
    `Phone number must be at least ${MESSAGING_PHONE_MIN_LENGTH} characters.`
  )
  .max(
    MESSAGING_PHONE_MAX_LENGTH,
    `Phone number must be at most ${MESSAGING_PHONE_MAX_LENGTH} characters.`
  )
  .transform((value, ctx) => {
    const e164 = normalizeE164(value);
    if (!e164) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Phone number must be a valid SMS-capable number.",
      });
      return z.NEVER;
    }
    return e164;
  });

const httpsUrlInput = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Use a public HTTPS URL.",
  });

const optionalHttpsUrlInput = z
  .union([httpsUrlInput, z.literal("")])
  .optional();

const registrationDisplayNameInput = z.string().trim().min(2).max(100);
const registrationContactNameInput = z.string().trim().min(1).max(100);
const registrationContactEmailInput = z.string().trim().email().max(100);
const registrationWebsiteInput = httpsUrlInput.refine(
  (value) => value.length <= 100,
  {
    message: "Website URL must be 100 characters or fewer.",
  }
);

const a2pRegistrationInput = z.object({
  entityType: z.enum(["PRIVATE_PROFIT", "NON_PROFIT"]),
  displayName: registrationDisplayNameInput,
  legalName: z.string().trim().min(2).max(100),
  taxId: z
    .string()
    .trim()
    .regex(/^(?:\d[ -]?){8}\d$/, "Enter a valid 9-digit US tax ID.")
    .transform((value) => value.replace(/\D/g, ""))
    .optional(),
  contactFirstName: registrationContactNameInput,
  contactLastName: registrationContactNameInput,
  contactEmail: registrationContactEmailInput,
  businessPhone: messagingPhoneInput,
  street: z.string().trim().min(3).max(100),
  city: z.string().trim().min(2).max(100),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter US state code.")
    .transform((value) => value.toUpperCase()),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/, "Enter a valid US ZIP code."),
  website: registrationWebsiteInput,
  privacyPolicyUrl: optionalHttpsUrlInput,
  termsUrl: optionalHttpsUrlInput,
  certifyAccuracyAndConsent: z.literal(true),
});

/** Map a thrown provisioning error to a tRPC error the UI can show. */
function provisioningError(e: unknown): TRPCError {
  if (e instanceof TelnyxNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
  }
  return new TRPCError({
    code: "BAD_GATEWAY",
    message: e instanceof Error ? e.message : "Messaging provider request failed",
  });
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

/**
 * Platform kill-switch for number provisioning. Numbers cost real money and
 * cannot send until the platform's carrier registration (10DLC) is approved,
 * so provisioning stays off until ops flips MESSAGING_PROVISIONING_ENABLED.
 * The Telnyx key alone being present must not open the purchase path.
 */
function assertProvisioningEnabled(): void {
  const flag = process.env.MESSAGING_PROVISIONING_ENABLED?.trim().toLowerCase();
  if (flag !== "true" && flag !== "1") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Texting setup is almost ready. We are finishing carrier registration; check back soon.",
    });
  }
}

function telnyxWebhookUrl(): string {
  const rawBase = configuredWebhookBaseUrl();
  if (!rawBase) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to your public HTTPS app URL before provisioning texting.",
    });
  }

  const normalized = normalizeAppBaseUrl(rawBase);
  if (!normalized) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to a valid public HTTPS app URL before provisioning texting.",
    });
  }

  const baseUrl = new URL(normalized);
  const hostname = baseUrl.hostname.toLowerCase();
  const localHostnames = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
  ]);
  if (
    baseUrl.protocol !== "https:" ||
    localHostnames.has(hostname) ||
    hostname.endsWith(".local")
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to your public HTTPS app URL before provisioning texting.",
    });
  }

  return new URL("/api/webhooks/telnyx", baseUrl).toString();
}

function configuredWebhookBaseUrl(): string {
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (publicUrl) return publicUrl;
  const authUrl = process.env.NEXTAUTH_URL?.trim();
  if (authUrl) return authUrl;
  return "";
}

function splitContactName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    contactFirstName: parts.shift() ?? "",
    contactLastName: parts.join(" "),
  };
}

function stringDefault(
  schema: z.ZodType<string>,
  value: string | null | undefined
): string {
  const parsed = schema.safeParse(value ?? "");
  return parsed.success ? parsed.data : "";
}

export const messagingRouter = createRouter({
  /** Redacted clinic-entered A2P details. Raw/encrypted tax IDs never leave DB. */
  getRegistration: adminOnly.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const [registration] = await ctx.db
      .select({
        entityType: messagingRegistrations.entityType,
        displayName: messagingRegistrations.displayName,
        legalName: messagingRegistrations.legalName,
        hasTaxId: sql<boolean>`${messagingRegistrations.taxIdEncrypted} <> ''`,
        taxIdLast4: messagingRegistrations.taxIdLast4,
        contactFirstName: messagingRegistrations.contactFirstName,
        contactLastName: messagingRegistrations.contactLastName,
        contactEmail: messagingRegistrations.contactEmail,
        businessPhone: messagingRegistrations.businessPhone,
        street: messagingRegistrations.street,
        city: messagingRegistrations.city,
        state: messagingRegistrations.state,
        postalCode: messagingRegistrations.postalCode,
        website: messagingRegistrations.website,
        privacyPolicyUrl: messagingRegistrations.privacyPolicyUrl,
        termsUrl: messagingRegistrations.termsUrl,
        status: messagingRegistrations.status,
        statusDetail: messagingRegistrations.statusDetail,
        providerBrandStatus: messagingRegistrations.providerBrandStatus,
        providerCampaignStatus: messagingRegistrations.providerCampaignStatus,
        lastSyncedAt: messagingRegistrations.lastSyncedAt,
      })
      .from(messagingRegistrations)
      .where(
        and(
          eq(messagingRegistrations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(messagingRegistrations.deletedAt)
        )
      )
      .limit(1);
    return registration ?? null;
  }),

  /** Prefill non-legal fields and provide hosted SMS policy URLs. */
  getRegistrationDefaults: adminOnly.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const [practice] = await ctx.db
      .select({
        name: practices.name,
        email: practices.email,
        phone: practices.phone,
        website: practices.website,
        primaryLocationPhone: locations.phone,
      })
      .from(practices)
      .leftJoin(
        locations,
        and(
          eq(locations.practiceId, practices.id),
          eq(locations.isPrimary, true),
          isNull(locations.deletedAt)
        )
      )
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);

    if (!practice) throw practiceNotFound();
    const policyUrls = messagingProgramUrls(ctx.practiceId, appBaseUrl());
    const contactName = splitContactName(ctx.user.name);

    return {
      displayName: stringDefault(registrationDisplayNameInput, practice.name),
      contactFirstName: stringDefault(
        registrationContactNameInput,
        contactName.contactFirstName
      ),
      contactLastName: stringDefault(
        registrationContactNameInput,
        contactName.contactLastName
      ),
      contactEmail:
        stringDefault(registrationContactEmailInput, practice.email) ||
        stringDefault(registrationContactEmailInput, ctx.user.email),
      businessPhone: stringDefault(
        messagingPhoneInput,
        practice.phone || practice.primaryLocationPhone
      ),
      website: stringDefault(registrationWebsiteInput, practice.website),
      ...policyUrls,
    };
  }),

  /**
   * Save legal/contact/consent details without contacting Telnyx. Submitted
   * registrations become immutable so clinic edits cannot diverge from TCR.
   */
  saveRegistration: adminOnly
    .input(a2pRegistrationInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [existing] = await ctx.db
        .select({
          taxIdEncrypted: messagingRegistrations.taxIdEncrypted,
          taxIdLast4: messagingRegistrations.taxIdLast4,
          providerBrandId: messagingRegistrations.providerBrandId,
          providerCampaignId: messagingRegistrations.providerCampaignId,
        })
        .from(messagingRegistrations)
        .where(
          and(
            eq(messagingRegistrations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(messagingRegistrations.deletedAt)
          )
        )
        .limit(1);

      if (existing?.providerBrandId || existing?.providerCampaignId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Carrier registration has been submitted. Contact OpenVPM support before changing legal details.",
        });
      }
      if (!existing && !input.taxId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A 9-digit US tax ID is required for initial registration.",
        });
      }

      let taxIdEncrypted = existing?.taxIdEncrypted;
      let taxIdLast4 = existing?.taxIdLast4;
      if (input.taxId) {
        try {
          taxIdEncrypted = encryptRegistrationTaxId(input.taxId);
        } catch (error) {
          if (error instanceof MessagingRegistrationEncryptionError) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Secure carrier registration storage is not configured. Contact OpenVPM support.",
            });
          }
          throw error;
        }
        taxIdLast4 = input.taxId.slice(-4);
      }
      if (!taxIdEncrypted || !taxIdLast4) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Secure tax ID storage is incomplete. Contact OpenVPM support.",
        });
      }

      const hostedPolicyUrls =
        !input.privacyPolicyUrl || !input.termsUrl
          ? messagingProgramUrls(ctx.practiceId, appBaseUrl())
          : null;
      const { taxId: _taxId, ...fields } = input;
      const { certifyAccuracyAndConsent: _attestation, ...registrationFields } =
        fields;
      const completedRegistrationFields = {
        ...registrationFields,
        privacyPolicyUrl:
          input.privacyPolicyUrl || hostedPolicyUrls!.privacyPolicyUrl,
        termsUrl: input.termsUrl || hostedPolicyUrls!.termsUrl,
      };
      await ctx.db
        .insert(messagingRegistrations)
        .values({
          practiceId: ctx.practiceId,
          ...completedRegistrationFields,
          taxIdEncrypted,
          taxIdLast4,
          complianceAttestedAt: new Date(),
          complianceAttestedBy: ctx.user.id,
          provider: "telnyx",
          campaignUsecase: "MIXED",
          status: "not_started",
          statusDetail: "Ready for OpenVPM carrier review.",
        })
        .onConflictDoUpdate({
          target: messagingRegistrations.practiceId,
          set: {
            ...completedRegistrationFields,
            taxIdEncrypted,
            taxIdLast4,
            complianceAttestedAt: new Date(),
            complianceAttestedBy: ctx.user.id,
            status: "not_started",
            statusDetail: "Ready for OpenVPM carrier review.",
            lastError: null,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

      return { ok: true, taxIdLast4 };
    }),

  /**
   * Safe, lightweight messaging state for the shared inbox. Unlike the Settings
   * status endpoint, this is visible to all authenticated staff so they can see
   * why SMS is available, pending, or disabled before composing.
   */
  getInboxStatus: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const locs = await ctx.db
      .select({
        locationId: locations.id,
        name: locations.name,
        provider: locationMessaging.provider,
        senderE164: locationMessaging.senderE164,
        messagingProfileId: locationMessaging.messagingProfileId,
        registrationStatus: locationMessaging.registrationStatus,
        enabled: locationMessaging.enabled,
      })
      .from(locations)
      .leftJoin(
        locationMessaging,
        and(
          eq(locationMessaging.locationId, locations.id),
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt)
        )
      )
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locations.deletedAt)
        )
      );

    const locationsForSummary = locs.map((l) => ({
      locationId: l.locationId,
      name: l.name,
      messaging: l.provider
        ? {
            senderE164: l.senderE164,
            messagingProfileId: l.messagingProfileId,
            registrationStatus: l.registrationStatus ?? "not_started",
            enabled: l.enabled ?? false,
          }
        : null,
    }));

    return {
      canManage: ctx.user.role === "admin",
      locations: locationsForSummary,
      summary: summarizeInboxSmsStatus(locationsForSummary),
    };
  }),

  /**
   * Per-location messaging status + this month's SMS usage + consent stats.
   * Drives the Settings → Messaging tab.
   */
  getStatus: adminOnly.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const locs = await ctx.db
      .select({
        locationId: locations.id,
        name: locations.name,
        isPrimary: locations.isPrimary,
        existingPhone: locations.phone,
        provider: locationMessaging.provider,
        senderE164: locationMessaging.senderE164,
        messagingProfileId: locationMessaging.messagingProfileId,
        numberSource: locationMessaging.numberSource,
        registrationStatus: locationMessaging.registrationStatus,
        registrationDetail: locationMessaging.registrationDetail,
        enabled: locationMessaging.enabled,
      })
      .from(locations)
      .leftJoin(
        locationMessaging,
        and(
          eq(locationMessaging.locationId, locations.id),
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt)
        )
      )
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locations.deletedAt)
        )
      );

    const period = currentPeriodMonth();
    const smsUsed = await usageForPractice(ctx.practiceId, "sms", period);

    const [practice] = await ctx.db
      .select({ tier: practices.subscriptionTier })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const includedSms = getPlan(practice.tier ?? "free")?.includedSmsPerMonth ?? null;

    const [consentRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          eq(clients.smsConsent, true),
          isNull(clients.deletedAt)
        )
      );
    const [suppressedRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId)
        )
      );

    return {
      locations: locs.map((l) => ({
        locationId: l.locationId,
        name: l.name,
        isPrimary: l.isPrimary,
        existingPhone: l.existingPhone,
        messaging: l.provider
          ? {
              provider: l.provider,
              senderE164: l.senderE164,
              messagingProfileId: l.messagingProfileId,
              numberSource: l.numberSource,
              registrationStatus: l.registrationStatus,
              registrationDetail: l.registrationDetail,
              enabled: l.enabled,
            }
          : null,
      })),
      usage: { period, smsUsed, includedSms },
      consent: {
        optedIn: consentRow?.n ?? 0,
        suppressed: suppressedRow?.n ?? 0,
      },
    };
  }),

  /**
   * Lightweight messaging state for the activation checklist: whether a number
   * is provisioned at all, and whether texting is live (active + enabled).
   */
  activationSummary: adminOnly.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const rows = await ctx.db
      .select({
        registrationStatus: locationMessaging.registrationStatus,
        enabled: locationMessaging.enabled,
        senderE164: locationMessaging.senderE164,
      })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt)
        )
      );
    return {
      hasAnyNumber: rows.some((r) => !!r.senderE164),
      hasActiveNumber: rows.some(
        (r) => r.registrationStatus === "active" && r.enabled
      ),
    };
  }),

  /** Search purchasable local SMS numbers, optionally by US area code. */
  searchNumbers: adminOnly
    .input(
      z.object({
        areaCode: z
          .string()
          .regex(
            new RegExp(`^\\d{${MESSAGING_AREA_CODE_LENGTH}}$`),
            `Area code must be ${MESSAGING_AREA_CODE_LENGTH} digits`
          )
          .optional(),
        limit: z.number().int().min(1).max(MESSAGING_SEARCH_LIMIT_MAX).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      assertProvisioningEnabled();
      await assertActivePractice(ctx);
      try {
        return await searchAvailableNumbers(input);
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /** Can this location's existing number be text-enabled (hosted SMS, no port)? */
  checkEligibility: adminOnly
    .input(z.object({ locationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ phone: locations.phone })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }
      const e164 = normalizeE164(loc.phone);
      if (!e164) {
        return {
          eligible: false,
          detail:
            "Add a valid phone number to this location before checking eligibility.",
        };
      }
      try {
        return await checkHostedEligibility(e164);
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /**
   * Stand up a texting number for a location: create a messaging profile (with
   * our inbound webhook), then either text-enable the location's existing number
   * (host) or buy a new local number, and save the config. Leaves the location
   * disabled + registration pending (carrier A2P approval precedes sending).
   */
  provisionNumber: adminOnly
    .input(
      z.object({
        locationId: z.string().uuid(),
        mode: z.enum(["host", "buy"]),
        // Required for "buy"; for "host" we use the location's existing number.
        phoneNumber: messagingPhoneInput.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertProvisioningEnabled();
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ id: locations.id, name: locations.name, phone: locations.phone })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      const e164 = normalizeE164(
        input.mode === "host" ? loc.phone : input.phoneNumber
      );
      if (!e164) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.mode === "host"
              ? "Add a valid phone number to this location before text-enabling it."
              : "Select a valid number to purchase.",
        });
      }

      const webhookUrl = telnyxWebhookUrl();

      try {
        const profile = await createMessagingProfile({
          name: `${loc.name} — OpenVPM`,
          webhookUrl,
        });
        const numberSource = input.mode === "host" ? "hosted" : "purchased";
        if (input.mode === "host") {
          await createHostedOrder({ phoneNumber: e164, messagingProfileId: profile.id });
        } else {
          await buyNumber({ phoneNumber: e164, messagingProfileId: profile.id });
        }

        await ctx.db
          .insert(locationMessaging)
          .values({
            practiceId: ctx.practiceId,
            locationId: loc.id,
            provider: "telnyx",
            messagingProfileId: profile.id,
            senderE164: e164,
            numberSource,
            registrationStatus: "pending",
            registrationDetail: MESSAGING_REGISTRATION_PENDING_DETAIL,
            enabled: false,
          })
          .onConflictDoUpdate({
            target: locationMessaging.locationId,
            set: {
              provider: "telnyx",
              messagingProfileId: profile.id,
              senderE164: e164,
              numberSource,
              registrationStatus: "pending",
              registrationDetail: MESSAGING_REGISTRATION_PENDING_DETAIL,
              enabled: false,
              deletedAt: null,
              updatedAt: new Date(),
            },
          });

        return { ok: true, senderE164: e164, numberSource };
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /** Turn sending on/off for a location (independent of registration state). */
  setEnabled: adminOnly
    .input(z.object({ locationId: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      if (input.enabled) {
        const [readySender] = await ctx.db
          .select({ locationId: locationMessaging.locationId })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.locationId, input.locationId),
              eq(locationMessaging.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locationMessaging.deletedAt),
              eq(locationMessaging.registrationStatus, "active"),
              hasNonBlankMessagingSender()
            )
          )
          .limit(1);

        if (!readySender) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Carrier registration must be active before enabling SMS sending.",
          });
        }
      }

      const updateConditions = [
        eq(locationMessaging.locationId, input.locationId),
        eq(locationMessaging.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locationMessaging.deletedAt),
      ];
      if (input.enabled) {
        updateConditions.push(
          eq(locationMessaging.registrationStatus, "active"),
          hasNonBlankMessagingSender()
        );
      }

      const [updated] = await ctx.db
        .update(locationMessaging)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(and(...updateConditions))
        .returning();
      if (!updated) {
        if (input.enabled) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Messaging sender changed while enabling. Refresh and try again.",
          });
        }
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Set up a number for this location first.",
        });
      }
      return { ok: true, enabled: updated.enabled };
    }),

  /** Send a test SMS to a staff number from the location's sender. */
  testSend: adminOnly
    .input(z.object({ locationId: z.string().uuid(), to: messagingPhoneInput }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      const [sender] = await ctx.db
        .select({ locationId: locationMessaging.locationId })
        .from(locationMessaging)
        .innerJoin(
          locations,
          and(
            eq(locations.id, locationMessaging.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt)
          )
        )
        .where(
          and(
            eq(locationMessaging.locationId, input.locationId),
            eq(locationMessaging.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locationMessaging.deletedAt),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt),
            eq(locationMessaging.enabled, true),
            eq(locationMessaging.registrationStatus, "active"),
            hasNonBlankMessagingSender()
          )
        )
        .limit(1);
      if (!sender) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Set up and enable an active texting number first.",
        });
      }

      const result = await sendSms({
        to: input.to,
        body: "OpenVPM test message — your texting is set up correctly.",
        practiceId: ctx.practiceId,
        locationId: input.locationId,
      });
      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.error ?? "Test send failed.",
        });
      }
      return { ok: true, id: result.sid };
    }),
});
