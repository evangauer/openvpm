import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
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
import { billingEnforced, getPlan } from "@/lib/billing/plans";
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
  findAvailableNumberQuotes,
  createMessagingProfile,
  buyNumber,
  deleteMessagingProfile,
  findMessagingProfilesByName,
  findOwnedPhoneNumbers,
  findNumberOrdersByCustomerReference,
  getMessagingProfile,
  messagingProfileSafetyIssues,
  TelnyxError,
  TelnyxMutationUncertainError,
  TelnyxNotConfiguredError,
} from "@/lib/messaging/telnyx-provisioning";
import { appBaseUrl } from "@/lib/app-url";
import { publicTelnyxWebhookUrl } from "@/lib/messaging/public-webhook";
import {
  encryptRegistrationTaxId,
  MessagingRegistrationEncryptionError,
} from "@/lib/messaging/registration-crypto";
import { messagingProgramUrls } from "@/lib/messaging/public-program";
import {
  releaseMessagingProfileAttempt,
  reserveMessagingProfileAttempt,
} from "@/lib/messaging/provisioning-attempt-gate";
import {
  hostedMessagingLaunchBlockMessage,
  hostedMessagingLaunchDecision,
} from "@/lib/messaging/launch-gate";
import {
  clinicMessagingRegistrationActor,
  recordMessagingRegistrationEvent,
} from "@/lib/messaging/registration-events";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { alertOps } from "@/lib/alerts";

const adminOnly = protectedProcedure.use(requireRole("admin"));
const MESSAGING_NUMBER_ORDERED_DETAIL =
  "Number order accepted. The provider may still be activating it, and sending is off. Complete the clinic carrier details; OpenVPM will review them before registration submission.";
const MESSAGING_PROVISIONING_FAILED_DETAIL =
  "Number setup did not finish. No sending was enabled. Reconcile the saved provider setup from this location, or contact OpenVPM support.";
const MESSAGING_PROVISIONING_PREPARED_DETAIL =
  "Number setup is reserved but not complete. No sending was enabled. Reconcile this saved setup; OpenVPM will not create another provider profile or purchase another number automatically.";
const EXISTING_NUMBER_UNAVAILABLE_DETAIL =
  "Texting from your clinic's existing phone number is not supported yet. OpenVPM has not ported or changed that number. Choose a new local texting number instead.";
const INCONCLUSIVE_ORDER_DETAIL =
  "OpenVPM could not conclusively reconcile the earlier number order. No additional purchase was attempted. Contact OpenVPM support before trying another number.";
const HOSTED_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;
const appointmentReminderLeadHoursInput = z.union([
  z.literal(24),
  z.literal(48),
  z.literal(72),
]);

const providerPriceInput = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/, "A complete provider price is required.")
  .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0, {
    message: "A valid non-negative provider price is required.",
  });

const selectedQuoteInput = z.object({
  upfrontCost: providerPriceInput,
  monthlyCost: providerPriceInput,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/),
});

const messagingPhoneInput = z
  .string()
  .trim()
  .min(
    MESSAGING_PHONE_MIN_LENGTH,
    `Phone number must be at least ${MESSAGING_PHONE_MIN_LENGTH} characters.`,
  )
  .max(
    MESSAGING_PHONE_MAX_LENGTH,
    `Phone number must be at most ${MESSAGING_PHONE_MAX_LENGTH} characters.`,
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const httpsUrlInput = z
  .string()
  .trim()
  .url()
  .max(500)
  // Refinements still run after an earlier Zod string issue. Keep this check
  // total so an empty clinic default becomes "no prefill" instead of a 500.
  .refine(isHttpsUrl, {
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
  },
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
  if (e instanceof TRPCError) return e;
  if (e instanceof TelnyxNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
  }
  if (e instanceof TelnyxMutationUncertainError) {
    return new TRPCError({ code: "BAD_GATEWAY", message: e.message });
  }
  if (e instanceof TelnyxError) {
    return new TRPCError({ code: "BAD_GATEWAY", message: e.message });
  }
  console.error("Unexpected messaging provisioning failure", e);
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Texting setup could not be completed safely. No additional purchase was attempted. Retry reconciliation or contact OpenVPM support.",
  });
}

function quotesMatch(
  selected: z.infer<typeof selectedQuoteInput>,
  current: z.infer<typeof selectedQuoteInput>,
): boolean {
  return (
    selected.currency === current.currency &&
    Number(selected.upfrontCost) === Number(current.upfrontCost) &&
    Number(selected.monthlyCost) === Number(current.monthlyCost)
  );
}

function isFailedOrderStatus(status: string): boolean {
  return ["failure", "failed", "cancelled", "canceled", "deleted"].includes(
    status.toLowerCase(),
  );
}

function isRecoverableOrderStatus(status: string): boolean {
  return ["pending", "success"].includes(status.toLowerCase());
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
function provisioningEnabled(): boolean {
  const flag = process.env.MESSAGING_PROVISIONING_ENABLED?.trim().toLowerCase();
  return flag === "true" || flag === "1";
}

function assertProvisioningEnabled(): void {
  if (!provisioningEnabled()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Texting setup is almost ready. We are finishing carrier registration; check back soon.",
    });
  }
}

/**
 * Number orders can incur immediate and recurring provider charges.
 * During controlled rollout, require an explicit tenant allowlist in addition
 * to the global kill-switch. Self-hosters retain the switch-only path.
 */
function provisioningPracticeAllowed(practiceId: string): boolean {
  if (!billingEnforced()) return true;
  const allowed = new Set(
    (process.env.MESSAGING_PROVISIONING_PRACTICE_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowed.has(practiceId);
}

function assertProvisioningPracticeAllowed(practiceId: string): void {
  if (!provisioningPracticeAllowed(practiceId)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Texting number setup is available only to approved pilot clinics. Contact OpenVPM support.",
    });
  }
}

function provisioningAvailableForPractice(practiceId: string): boolean {
  return provisioningEnabled() && provisioningPracticeAllowed(practiceId);
}

function assertHostedSendingAllowed(practiceId: string, locationId: string) {
  if (!billingEnforced()) return;
  const decision = hostedMessagingLaunchDecision({ practiceId, locationId });
  if (!decision.allowed) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: hostedMessagingLaunchBlockMessage(decision.reason),
    });
  }
}

function hostedLaunchEligibleLocationIds(
  practiceId: string,
  locationIds: string[],
): ReadonlySet<string> {
  if (!billingEnforced()) return new Set(locationIds);
  const eligible = locationIds.filter(
    (locationId) =>
      hostedMessagingLaunchDecision({ practiceId, locationId }).allowed,
  );
  // A hosted pilot is intentionally one location per practice. An operator
  // allowlisting multiple clinic locations is ambiguous and fails closed.
  return eligible.length === 1 ? new Set(eligible) : new Set();
}

function provisioningOperationReference(
  practiceId: string,
  locationId: string,
): string {
  return `openvpm:${practiceId}:${locationId}`;
}

function provisioningProfileName(locationId: string): string {
  return `OpenVPM provision ${locationId}`;
}

function provisioningConflict(message: string): TRPCError {
  return new TRPCError({ code: "CONFLICT", message });
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

  const webhookUrl = publicTelnyxWebhookUrl(rawBase);
  if (!webhookUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to your public HTTPS app URL before provisioning texting.",
    });
  }
  return webhookUrl;
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
  value: string | null | undefined,
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
          isNull(messagingRegistrations.deletedAt),
        ),
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
          isNull(locations.deletedAt),
        ),
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
        contactName.contactFirstName,
      ),
      contactLastName: stringDefault(
        registrationContactNameInput,
        contactName.contactLastName,
      ),
      contactEmail:
        stringDefault(registrationContactEmailInput, practice.email) ||
        stringDefault(registrationContactEmailInput, ctx.user.email),
      businessPhone: stringDefault(
        messagingPhoneInput,
        practice.phone || practice.primaryLocationPhone,
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
          submissionLockId: messagingRegistrations.submissionLockId,
          status: messagingRegistrations.status,
        })
        .from(messagingRegistrations)
        .where(
          and(
            eq(messagingRegistrations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(messagingRegistrations.deletedAt),
          ),
        )
        .limit(1);

      // Do not collect new legal/contact/EIN data for clinics outside the
      // controlled provisioning scope. Existing registrations or sender rows
      // remain editable so an already-started pilot can be reconciled safely.
      if (!existing && !provisioningAvailableForPractice(ctx.practiceId)) {
        const [existingSender] = await ctx.db
          .select({ locationId: locationMessaging.locationId })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locationMessaging.deletedAt),
            ),
          )
          .limit(1);
        if (!existingSender) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: billingEnforced()
              ? "Carrier registration is available only to approved texting pilot clinics. Contact OpenVPM support."
              : "Carrier registration is disabled by this OpenVPM deployment.",
          });
        }
      }

      if (existing?.providerBrandId || existing?.providerCampaignId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Carrier registration has been submitted. Contact OpenVPM support before changing legal details.",
        });
      }
      if (existing?.submissionLockId) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Carrier registration is being processed. Wait for the current provider operation to finish before changing legal details.",
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
      let savedRegistrationId: string | null = null;
      await ctx.db.transaction(async (tx) => {
        const [registration] = await tx
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
            setWhere: and(
              eq(
                messagingRegistrations.status,
                existing?.status ?? "not_started",
              ),
              isNull(messagingRegistrations.providerBrandId),
              isNull(messagingRegistrations.providerCampaignId),
              isNull(messagingRegistrations.submissionLockId),
            ),
          })
          .returning();
        if (!registration) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Carrier registration changed while saving.",
          });
        }
        savedRegistrationId = registration.id;
        await recordMessagingRegistrationEvent(tx as unknown as Database, {
          registration,
          eventType: "details_saved",
          operation: "registration_details",
          statusBefore: existing?.status ?? null,
          operationId: randomUUID(),
          reasonCode: "clinic_registration_saved",
          actor: clinicMessagingRegistrationActor(ctx.user),
        });
      });

      // The registration row is the durable work item. Notify only when that
      // work item is first created, after commit, and never include legal,
      // contact, address, or tax data in the operator alert.
      if (!existing && savedRegistrationId) {
        await alertOps(
          "SMS registration ready for carrier review",
          `practice=${ctx.practiceId} registration=${savedRegistrationId} action=review_saved_registration`,
        );
      }

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
        providerProfileReady: locationMessaging.providerProfileReady,
      })
      .from(locations)
      .leftJoin(
        locationMessaging,
        and(
          eq(locationMessaging.locationId, locations.id),
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locations.deletedAt),
        ),
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
            providerProfileReady: l.providerProfileReady ?? false,
            provider: l.provider,
          }
        : null,
    }));
    const launchEligibleLocationIds = hostedLaunchEligibleLocationIds(
      ctx.practiceId,
      locs.map((location) => location.locationId),
    );
    const locationsWithLaunchState = locationsForSummary.map((location) => ({
      ...location,
      messaging: location.messaging
        ? {
            ...location.messaging,
            providerProfileReadyRequired: billingEnforced(),
            launchEligible:
              launchEligibleLocationIds.has(location.locationId) &&
              (!billingEnforced() || location.messaging.provider === "telnyx"),
          }
        : null,
    }));

    return {
      canManage: ctx.user.role === "admin",
      locations: locationsWithLaunchState,
      summary: summarizeInboxSmsStatus(locationsWithLaunchState),
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
        providerProfileReady: locationMessaging.providerProfileReady,
        providerProfileSyncedAt: locationMessaging.providerProfileSyncedAt,
        enabled: locationMessaging.enabled,
      })
      .from(locations)
      .leftJoin(
        locationMessaging,
        and(
          eq(locationMessaging.locationId, locations.id),
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .where(
        and(
          eq(locations.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locations.deletedAt),
        ),
      );

    const period = currentPeriodMonth();
    const smsUsed = await usageForPractice(ctx.practiceId, "sms", period);

    const [practice] = await ctx.db
      .select({
        tier: practices.subscriptionTier,
        appointmentRemindersEnabled: practices.appointmentRemindersEnabled,
        appointmentReminderLeadHours: practices.appointmentReminderLeadHours,
      })
      .from(practices)
      .where(activePracticeWhere(ctx.practiceId))
      .limit(1);
    if (!practice) {
      throw practiceNotFound();
    }
    const includedSms =
      getPlan(practice.tier ?? "free")?.includedSmsPerMonth ?? null;
    const launchEligibleLocationIds = hostedLaunchEligibleLocationIds(
      ctx.practiceId,
      locs.map((location) => location.locationId),
    );

    const [consentRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          eq(clients.smsConsent, true),
          isNull(clients.deletedAt),
        ),
      );
    const [suppressedRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
        ),
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
              providerProfileReady: l.providerProfileReady,
              providerProfileSyncedAt: l.providerProfileSyncedAt,
              providerProfileAttestationFresh:
                !billingEnforced() ||
                (l.providerProfileReady === true &&
                  l.providerProfileSyncedAt !== null &&
                  l.providerProfileSyncedAt.getTime() >=
                    Date.now() -
                      HOSTED_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS),
              enabled: l.enabled,
              launchEligible:
                launchEligibleLocationIds.has(l.locationId) &&
                (!billingEnforced() || l.provider === "telnyx"),
            }
          : null,
      })),
      usage: { period, smsUsed, includedSms },
      consent: {
        optedIn: consentRow?.n ?? 0,
        suppressed: suppressedRow?.n ?? 0,
      },
      appointmentReminders: {
        enabled: practice.appointmentRemindersEnabled,
        leadHours: practice.appointmentReminderLeadHours,
      },
      launch: {
        hosted: billingEnforced(),
        setupAvailable: provisioningAvailableForPractice(ctx.practiceId),
        pilotEnabled: !billingEnforced() || launchEligibleLocationIds.size > 0,
        testSendAllowed: !billingEnforced(),
      },
    };
  }),

  /**
   * Clinic-controlled automated appointment reminder policy. Reminders are
   * default-off in the database and can only be enabled by a clinic admin.
   */
  setAppointmentReminderSettings: adminOnly
    .input(
      z.object({
        enabled: z.boolean(),
        leadHours: appointmentReminderLeadHoursInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [updated] = await ctx.db
        .update(practices)
        .set({
          appointmentRemindersEnabled: input.enabled,
          appointmentReminderLeadHours: input.leadHours,
          updatedAt: new Date(),
        })
        .where(activePracticeWhere(ctx.practiceId))
        .returning({
          enabled: practices.appointmentRemindersEnabled,
          leadHours: practices.appointmentReminderLeadHours,
        });

      if (!updated) {
        throw practiceNotFound();
      }
      return updated;
    }),

  /**
   * Lightweight messaging state for the activation checklist: whether a number
   * is provisioned at all, and whether texting is live (active + enabled).
   */
  activationSummary: adminOnly.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const rows = await ctx.db
      .select({
        locationId: locationMessaging.locationId,
        provider: locationMessaging.provider,
        registrationStatus: locationMessaging.registrationStatus,
        enabled: locationMessaging.enabled,
        senderE164: locationMessaging.senderE164,
      })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt),
        ),
      );
    const launchEligibleLocationIds = hostedLaunchEligibleLocationIds(
      ctx.practiceId,
      rows.map((row) => row.locationId),
    );
    return {
      setupAvailable: provisioningAvailableForPractice(ctx.practiceId),
      hasAnyNumber: rows.some(
        (r) => !!r.senderE164 && r.registrationStatus !== "failed",
      ),
      hasActiveNumber: rows.some(
        (r) =>
          r.registrationStatus === "active" &&
          r.enabled &&
          launchEligibleLocationIds.has(r.locationId) &&
          (!billingEnforced() || r.provider === "telnyx"),
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
            `Area code must be ${MESSAGING_AREA_CODE_LENGTH} digits`,
          )
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MESSAGING_SEARCH_LIMIT_MAX)
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertProvisioningEnabled();
      await assertActivePractice(ctx);
      assertProvisioningPracticeAllowed(ctx.practiceId);
      try {
        return await searchAvailableNumbers(input);
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /** Existing-number hosting is intentionally closed until it works end-to-end. */
  checkEligibility: adminOnly
    .input(z.object({ locationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt),
          ),
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
      }
      return {
        eligible: false,
        detail: EXISTING_NUMBER_UNAVAILABLE_DETAIL,
      };
    }),

  /**
   * Stand up a new texting number for a location. A location-scoped PostgreSQL
   * advisory lock serializes clicks, while a deterministic provider profile
   * name and customer reference let retries reconcile an interrupted attempt.
   * Sending stays disabled until carrier approval.
   */
  provisionNumber: adminOnly
    .input(
      z.union([
        z.object({
          locationId: z.string().uuid(),
          mode: z.literal("host"),
        }),
        z.object({
          locationId: z.string().uuid(),
          mode: z.literal("buy"),
          action: z.literal("start"),
          phoneNumber: messagingPhoneInput,
          quote: selectedQuoteInput,
          confirmProviderCharges: z.literal(true),
        }),
        z.object({
          locationId: z.string().uuid(),
          mode: z.literal("buy"),
          action: z.literal("resume"),
        }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.mode === "host") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: EXISTING_NUMBER_UNAVAILABLE_DETAIL,
        });
      }
      assertProvisioningEnabled();
      assertProvisioningPracticeAllowed(ctx.practiceId);
      await assertActivePractice(ctx);
      if (!(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: RECOVERY_HOLD_BLOCK_MESSAGE,
        });
      }

      const webhookUrl = telnyxWebhookUrl();
      const profileName = provisioningProfileName(input.locationId);
      const customerReference = provisioningOperationReference(
        ctx.practiceId,
        input.locationId,
      );
      let profileId: string | null = null;
      let profileCreated = false;
      let profileMutationAttempted = false;
      let profileCreationDefinitivelyRejected = false;
      let conclusiveEmptyProfileState = false;
      let orderMutationAttempted = false;
      let orderDefinitivelyRejected = false;
      let purchaseOutcomeUncertain = false;
      let failureRecordAllowed = false;
      let preparedThisRequest = false;
      let e164: string | null =
        input.action === "start" ? normalizeE164(input.phoneNumber) : null;

      try {
        if (input.action === "start") {
          if (!e164) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Select a valid number to purchase.",
            });
          }
          // Commit a durable, disabled gate before the first provider profile
          // POST. A timeout, 5xx, malformed response, or process exit can then
          // never look like a fresh attempt: every later request sees this row
          // and must use the read-only resume/reconciliation path.
          preparedThisRequest = await reserveMessagingProfileAttempt({
            practiceId: ctx.practiceId,
            locationId: input.locationId,
            senderE164: e164,
            customerReference,
            detail: MESSAGING_PROVISIONING_PREPARED_DETAIL,
          });
          failureRecordAllowed = preparedThisRequest;
        }

        return await ctx.db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${customerReference}, 0))`,
          );
          // A request may have waited on the lock. Re-check immediately before
          // every possible provider mutation, not only at request entry.
          assertProvisioningEnabled();
          assertProvisioningPracticeAllowed(ctx.practiceId);

          const [loc] = await tx
            .select({ id: locations.id })
            .from(locations)
            .where(
              and(
                eq(locations.id, input.locationId),
                eq(locations.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(locations.deletedAt),
              ),
            )
            .limit(1);
          if (!loc) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Location not found",
            });
          }

          const [existing] = await tx
            .select({
              provider: locationMessaging.provider,
              messagingProfileId: locationMessaging.messagingProfileId,
              senderE164: locationMessaging.senderE164,
              numberSource: locationMessaging.numberSource,
              registrationStatus: locationMessaging.registrationStatus,
            })
            .from(locationMessaging)
            .where(
              and(
                eq(locationMessaging.locationId, input.locationId),
                eq(locationMessaging.practiceId, ctx.practiceId),
                isNull(locationMessaging.deletedAt),
              ),
            )
            .limit(1);

          if (input.action === "start" && !existing && !preparedThisRequest) {
            throw provisioningConflict(
              "OpenVPM could not reserve a durable texting setup attempt. No provider profile or number was created; refresh and try again.",
            );
          }

          if (input.action === "resume") {
            if (
              !existing ||
              existing.provider !== "telnyx" ||
              existing.numberSource !== "purchased" ||
              existing.registrationStatus !== "failed" ||
              !existing.senderE164
            ) {
              throw provisioningConflict(
                "There is no failed number setup to reconcile for this location. Start a new setup or contact OpenVPM support.",
              );
            }
            e164 = existing.senderE164;
          }
          if (!e164) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Select a valid number to purchase.",
            });
          }

          let isThisRequestPreparedGate = false;
          if (existing) {
            isThisRequestPreparedGate = Boolean(
              input.action === "start" && preparedThisRequest,
            );
            if (
              existing.provider !== "telnyx" ||
              (existing.numberSource &&
                existing.numberSource !== "purchased") ||
              (existing.senderE164 && existing.senderE164 !== e164)
            ) {
              throw provisioningConflict(
                "This location already has a different texting setup. Contact OpenVPM support before changing numbers.",
              );
            }
            if (
              existing.messagingProfileId &&
              existing.senderE164 === e164 &&
              existing.registrationStatus !== "failed"
            ) {
              return {
                ok: true,
                senderE164: e164,
                numberSource: "purchased" as const,
                recovered: true,
              };
            }
            if (input.action === "start" && !isThisRequestPreparedGate) {
              throw provisioningConflict(
                "This location has an incomplete number setup. Use Reconcile provider setup; OpenVPM will not purchase another number automatically.",
              );
            }
            profileId = existing.messagingProfileId;
          }
          failureRecordAllowed ||= Boolean(existing);

          const profiles = await findMessagingProfilesByName(profileName);
          if (profiles.length > 1) {
            throw provisioningConflict(
              "OpenVPM found more than one incomplete provider setup for this location. No number was purchased; contact support to reconcile it.",
            );
          }
          const recoveredProfile = profiles[0];
          if (
            recoveredProfile &&
            (recoveredProfile.webhookUrl !== webhookUrl ||
              recoveredProfile.enabled !== false)
          ) {
            throw provisioningConflict(
              "OpenVPM found an incomplete provider profile with unsafe settings. No number was purchased; contact support to reconcile it.",
            );
          }
          if (
            profileId &&
            recoveredProfile &&
            recoveredProfile.id !== profileId
          ) {
            throw provisioningConflict(
              "The saved provider identity does not match the recoverable setup. No number was purchased; contact support to reconcile it.",
            );
          }
          profileId = recoveredProfile?.id ?? profileId;
          failureRecordAllowed ||= Boolean(recoveredProfile);

          const orders =
            await findNumberOrdersByCustomerReference(customerReference);
          if (orders.length > 1) {
            throw provisioningConflict(
              "OpenVPM found duplicate provider orders for this location. No additional purchase was attempted; contact support to reconcile them.",
            );
          }
          const recoveredOrder = orders[0];

          if (
            input.action === "resume" &&
            !recoveredProfile &&
            !recoveredOrder
          ) {
            throw provisioningConflict(
              "The earlier provider profile outcome is still uncertain. OpenVPM will not create another profile automatically; review the carrier account before retrying.",
            );
          }

          if (recoveredOrder) {
            if (
              !profileId ||
              recoveredOrder.customerReference !== customerReference ||
              recoveredOrder.messagingProfileId !== profileId ||
              recoveredOrder.phoneNumbers.length !== 1 ||
              recoveredOrder.phoneNumbers[0] !== e164
            ) {
              throw provisioningConflict(INCONCLUSIVE_ORDER_DETAIL);
            }
            if (isFailedOrderStatus(recoveredOrder.status)) {
              throw provisioningConflict(
                "The earlier provider order is in a failed or cancelled state. No additional purchase was attempted; contact OpenVPM support.",
              );
            }
            if (!isRecoverableOrderStatus(recoveredOrder.status)) {
              throw provisioningConflict(INCONCLUSIVE_ORDER_DETAIL);
            }
          }

          if (!profileId) {
            if (recoveredOrder || input.action === "resume") {
              throw provisioningConflict(INCONCLUSIVE_ORDER_DETAIL);
            }
            // Exact profile and order reads both completed with no matching
            // state. Until the profile POST begins, failures such as a changed
            // quote are definitively mutation-free and may release the gate.
            conclusiveEmptyProfileState = Boolean(
              preparedThisRequest && !recoveredProfile && !recoveredOrder,
            );
            const currentQuotes = await findAvailableNumberQuotes(e164);
            if (
              currentQuotes.length !== 1 ||
              !quotesMatch(input.quote, currentQuotes[0]!)
            ) {
              throw provisioningConflict(
                "The selected number or its price changed before purchase. No charge was made. Search again and review the current price.",
              );
            }
            assertProvisioningEnabled();
            assertProvisioningPracticeAllowed(ctx.practiceId);
            profileMutationAttempted = true;
            let profile: Awaited<ReturnType<typeof createMessagingProfile>>;
            try {
              profile = await createMessagingProfile({
                name: profileName,
                webhookUrl,
              });
            } catch (error) {
              profileCreationDefinitivelyRejected =
                error instanceof TelnyxError &&
                !(error instanceof TelnyxMutationUncertainError);
              throw error;
            }
            profileId = profile.id;
            profileCreated = true;
            failureRecordAllowed = true;
          }
          const activeProfileId = profileId;
          if (!activeProfileId) {
            throw new Error(
              "The provider setup did not return a durable profile identity. Retry setup or contact OpenVPM support.",
            );
          }

          const verifiedProfile = await getMessagingProfile(activeProfileId);
          const profileIssues = messagingProfileSafetyIssues(verifiedProfile, {
            id: activeProfileId,
            name: profileName,
            webhookUrl,
          });
          if (profileIssues.length > 0 || verifiedProfile.enabled !== false) {
            throw new TelnyxError(
              `The provider messaging profile is not safe for number purchase: ${[
                ...profileIssues,
                ...(verifiedProfile.enabled === false
                  ? []
                  : ["profile is not disabled"]),
              ].join("; ")}.`,
              409,
            );
          }

          const ownedNumbers = await findOwnedPhoneNumbers(e164);
          if (ownedNumbers.length > 1) {
            throw provisioningConflict(
              "The provider returned duplicate ownership records for this number. No new purchase was made; contact support to reconcile it.",
            );
          }
          const ownedNumber = ownedNumbers[0];
          if (
            ownedNumber &&
            ["deleted", "failed", "cancelled", "canceled"].some((status) =>
              ownedNumber.status?.toLowerCase().includes(status),
            )
          ) {
            throw provisioningConflict(
              "The provider reports this number in a failed or released state. No new purchase was made; search again or contact support.",
            );
          }
          if (
            ownedNumber &&
            ownedNumber.messagingProfileId !== activeProfileId
          ) {
            throw provisioningConflict(
              "This number is already owned under a different provider setup. No new purchase was made; contact support before reassigning it.",
            );
          }

          if (!ownedNumber && !recoveredOrder) {
            if (
              input.action === "resume" ||
              recoveredProfile ||
              (existing && !isThisRequestPreparedGate)
            ) {
              throw provisioningConflict(INCONCLUSIVE_ORDER_DETAIL);
            }
            assertProvisioningEnabled();
            assertProvisioningPracticeAllowed(ctx.practiceId);
            let order: Awaited<ReturnType<typeof buyNumber>>;
            try {
              orderMutationAttempted = true;
              order = await buyNumber({
                phoneNumber: e164,
                messagingProfileId: activeProfileId,
                customerReference,
              });
            } catch (error) {
              purchaseOutcomeUncertain =
                error instanceof TelnyxMutationUncertainError;
              orderDefinitivelyRejected =
                error instanceof TelnyxError &&
                !(error instanceof TelnyxMutationUncertainError);
              throw error;
            }
            if (
              !order.orderId ||
              !order.status ||
              !isRecoverableOrderStatus(order.status)
            ) {
              purchaseOutcomeUncertain = true;
              throw new TelnyxMutationUncertainError(
                "The provider returned an inconclusive order status. No second purchase will be attempted automatically.",
              );
            }
          }

          await tx
            .insert(locationMessaging)
            .values({
              practiceId: ctx.practiceId,
              locationId: loc.id,
              provider: "telnyx",
              messagingProfileId: activeProfileId,
              senderE164: e164,
              numberSource: "purchased",
              registrationStatus: "not_started",
              registrationDetail: MESSAGING_NUMBER_ORDERED_DETAIL,
              providerProfileReady: false,
              providerProfileSyncedAt: null,
              enabled: false,
            })
            .onConflictDoUpdate({
              target: locationMessaging.locationId,
              set: {
                provider: "telnyx",
                messagingProfileId: activeProfileId,
                senderE164: e164,
                numberSource: "purchased",
                registrationStatus: "not_started",
                registrationDetail: MESSAGING_NUMBER_ORDERED_DETAIL,
                providerProfileReady: false,
                providerProfileSyncedAt: null,
                enabled: false,
                deletedAt: null,
                updatedAt: new Date(),
              },
            });

          return {
            ok: true,
            senderE164: e164,
            numberSource: "purchased" as const,
            recovered: Boolean(ownedNumber || recoveredOrder),
          };
        });
      } catch (e) {
        if (
          preparedThisRequest &&
          e164 &&
          (!profileMutationAttempted || profileCreationDefinitivelyRejected) &&
          (e instanceof TelnyxNotConfiguredError || conclusiveEmptyProfileState)
        ) {
          try {
            const released = await releaseMessagingProfileAttempt({
              practiceId: ctx.practiceId,
              locationId: input.locationId,
              senderE164: e164,
              customerReference,
              detail: MESSAGING_PROVISIONING_PREPARED_DETAIL,
            });
            if (released) failureRecordAllowed = false;
          } catch (releaseError) {
            // Fail closed by retaining the gate if its exact release cannot be
            // confirmed. Never mask the original setup error.
            console.error(
              "Unable to release untouched messaging profile attempt",
              releaseError,
            );
          }
        }
        if (failureRecordAllowed && e164) {
          const failureE164 = e164;
          try {
            await ctx.db.transaction(async (tx) => {
              // Serialize compensation with a retry. If the retry won the lock
              // and completed first, its durable sender owns the resources and
              // must never be deleted or overwritten by this older attempt.
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${customerReference}, 0))`,
              );
              const [current] = await tx
                .select({
                  provider: locationMessaging.provider,
                  messagingProfileId: locationMessaging.messagingProfileId,
                  senderE164: locationMessaging.senderE164,
                  numberSource: locationMessaging.numberSource,
                  registrationStatus: locationMessaging.registrationStatus,
                  registrationDetail: locationMessaging.registrationDetail,
                  enabled: locationMessaging.enabled,
                })
                .from(locationMessaging)
                .where(
                  and(
                    eq(locationMessaging.locationId, input.locationId),
                    eq(locationMessaging.practiceId, ctx.practiceId),
                    isNull(locationMessaging.deletedAt),
                  ),
                )
                .limit(1);
              const newerAttemptCompleted = Boolean(
                current?.provider === "telnyx" &&
                current.messagingProfileId &&
                current.senderE164 === failureE164 &&
                current.numberSource === "purchased" &&
                current.registrationStatus !== "failed",
              );
              const differentSetupExists = Boolean(
                current &&
                (current.provider !== "telnyx" ||
                  (current.senderE164 && current.senderE164 !== failureE164) ||
                  (current.numberSource &&
                    current.numberSource !== "purchased")),
              );
              if (newerAttemptCompleted || differentSetupExists) return;

              // Keep any accepted or ambiguous order intact: the exact
              // customer reference is the durable idempotency key a retry uses
              // to reconcile without a second POST. Only remove a brand-new,
              // unused profile after a definitive pre-order failure.
              if (
                profileId &&
                profileCreated &&
                (!orderMutationAttempted || orderDefinitivelyRejected) &&
                !purchaseOutcomeUncertain
              ) {
                try {
                  assertProvisioningEnabled();
                  await deleteMessagingProfile(profileId);
                  profileId = null;
                } catch {
                  // Persist the recoverable provider identity below.
                }
              }

              // A provider-confirmed profile deletion after a definitive,
              // pre-order failure restores a truly fresh start. Soft-delete
              // only the exact untouched reservation; a later click can then
              // reserve it again without being stranded in resume-only state.
              if (
                profileId === null &&
                profileCreated &&
                (!orderMutationAttempted || orderDefinitivelyRejected) &&
                !purchaseOutcomeUncertain &&
                current?.provider === "telnyx" &&
                current.messagingProfileId === null &&
                current.senderE164 === failureE164 &&
                current.numberSource === "purchased" &&
                current.registrationStatus === "failed"
              ) {
                const [released] = await tx
                  .update(locationMessaging)
                  .set({ deletedAt: new Date(), updatedAt: new Date() })
                  .where(
                    and(
                      eq(locationMessaging.locationId, input.locationId),
                      eq(locationMessaging.practiceId, ctx.practiceId),
                      eq(locationMessaging.provider, "telnyx"),
                      isNull(locationMessaging.messagingProfileId),
                      eq(locationMessaging.senderE164, failureE164),
                      eq(locationMessaging.numberSource, "purchased"),
                      eq(locationMessaging.registrationStatus, "failed"),
                      eq(
                        locationMessaging.registrationDetail,
                        MESSAGING_PROVISIONING_PREPARED_DETAIL,
                      ),
                      eq(locationMessaging.enabled, false),
                      isNull(locationMessaging.deletedAt),
                    ),
                  )
                  .returning({ id: locationMessaging.id });
                if (released) return;
              }

              await tx
                .insert(locationMessaging)
                .values({
                  practiceId: ctx.practiceId,
                  locationId: input.locationId,
                  provider: "telnyx",
                  messagingProfileId: profileId,
                  senderE164: failureE164,
                  numberSource: "purchased",
                  registrationStatus: "failed",
                  registrationDetail: MESSAGING_PROVISIONING_FAILED_DETAIL,
                  providerProfileReady: false,
                  providerProfileSyncedAt: null,
                  enabled: false,
                })
                .onConflictDoUpdate({
                  target: locationMessaging.locationId,
                  set: {
                    provider: "telnyx",
                    messagingProfileId: profileId,
                    senderE164: failureE164,
                    numberSource: "purchased",
                    registrationStatus: "failed",
                    registrationDetail: MESSAGING_PROVISIONING_FAILED_DETAIL,
                    providerProfileReady: false,
                    providerProfileSyncedAt: null,
                    enabled: false,
                    deletedAt: null,
                    updatedAt: new Date(),
                  },
                });
            });
          } catch {
            // Preserve the original provider/transaction error. Deterministic
            // provider identities still let a later retry reconcile safely.
          }
        }
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
            isNull(locations.deletedAt),
          ),
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
      }

      if (input.enabled) {
        if (
          !(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: RECOVERY_HOLD_BLOCK_MESSAGE,
          });
        }
        assertHostedSendingAllowed(ctx.practiceId, input.locationId);
        if (billingEnforced()) {
          await ctx.db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`hosted-sms:${ctx.practiceId}`}, 0))`,
          );
        }
        const readySenderConditions = [
          eq(locationMessaging.locationId, input.locationId),
          eq(locationMessaging.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(locationMessaging.deletedAt),
          eq(locationMessaging.registrationStatus, "active"),
          hasNonBlankMessagingSender(),
        ];
        if (billingEnforced()) {
          readySenderConditions.push(
            eq(locationMessaging.provider, "telnyx"),
            eq(locationMessaging.providerProfileReady, true),
            gte(
              locationMessaging.providerProfileSyncedAt,
              new Date(
                Date.now() - HOSTED_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS,
              ),
            ),
          );
        }
        const [readySender] = await ctx.db
          .select({
            locationId: locationMessaging.locationId,
            provider: locationMessaging.provider,
          })
          .from(locationMessaging)
          .where(and(...readySenderConditions))
          .limit(1);

        if (!readySender) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: billingEnforced()
              ? "OpenVPM must freshly verify the active provider profile before enabling hosted SMS sending."
              : "Carrier registration must be active before enabling SMS sending.",
          });
        }
        if (billingEnforced() && readySender.provider !== "telnyx") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Hosted texting is available only through the approved Telnyx pilot.",
          });
        }

        const enabledSenders = await ctx.db
          .select({ locationId: locationMessaging.locationId })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(locationMessaging.deletedAt),
              eq(locationMessaging.enabled, true),
              eq(locationMessaging.registrationStatus, "active"),
              hasNonBlankMessagingSender(),
            ),
          )
          .limit(2);
        if (
          billingEnforced() &&
          enabledSenders.some(
            (sender) => sender.locationId !== input.locationId,
          )
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "The hosted texting pilot supports one enabled location per practice.",
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
          hasNonBlankMessagingSender(),
        );
        if (billingEnforced()) {
          updateConditions.push(
            eq(locationMessaging.provider, "telnyx"),
            eq(locationMessaging.providerProfileReady, true),
            gte(
              locationMessaging.providerProfileSyncedAt,
              new Date(
                Date.now() - HOSTED_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS,
              ),
            ),
          );
        }
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
            message:
              "Messaging sender changed while enabling. Refresh and try again.",
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
    .input(
      z.object({
        locationId: z.string().uuid(),
        to: messagingPhoneInput,
        requestId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (billingEnforced()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Hosted test sends are disabled during the controlled texting pilot.",
        });
      }
      await assertActivePractice(ctx);
      const [loc] = await ctx.db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(locations.deletedAt),
          ),
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Location not found",
        });
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
            isNull(locations.deletedAt),
          ),
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
            hasNonBlankMessagingSender(),
          ),
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
        source: "self_host_test",
        sourceId: input.requestId,
        idempotencyKey: `sms:self-host-test:${input.requestId}`,
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
