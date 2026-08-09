import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { unstable_noStore as noStore } from "next/cache";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { db } from "@openpims/db/client";
import {
  practices,
  users,
  clients,
  patients,
  locations,
  messagingRegistrations,
  locationMessaging,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { computeActivationFunnel } from "@/lib/admin/activation-funnel";
import { computeJourneyFunnel } from "@/lib/admin/journey-funnel";
import { computeActivationRecovery } from "@/lib/admin/activation-recovery";
import {
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD,
  getPlan,
  type PlanTier,
} from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import {
  onboardingIntentLabel,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
import { publicTelnyxWebhookUrl } from "@/lib/messaging/public-webhook";
import {
  createA2pBrand,
  createA2pCampaign,
  ensureA2pNumberAssignment,
  findA2pCampaignByReference,
  getA2pBrand,
  getA2pCampaign,
  getA2pNumberAssignment,
  getMessagingProfile,
  messagingProfileSafetyIssues,
  openVpmMessagingProfileName,
  TelnyxError,
  type TelnyxNumberAssignment,
  updateMessagingProfileEnabled,
} from "@/lib/messaging/telnyx-provisioning";
import { inspectTelnyxProviderReadiness } from "@/lib/messaging/provider-readiness";
import { getSmsOperationsHealth } from "@/lib/messaging/sms-operations-health";
import {
  loadSmsDeliveryEventQueue,
  loadSmsSendAttemptQueue,
} from "@/lib/messaging/sms-operations-queues";
import {
  decryptRegistrationTaxId,
  MessagingRegistrationEncryptionError,
} from "@/lib/messaging/registration-crypto";
import {
  mergeRegistrationStatus,
  observedRegistrationStatus,
} from "@/lib/messaging/a2p-lifecycle";
import { messagingProgramUrls } from "@/lib/messaging/public-program";
import { reconcileSmsSendAttempt, resendSmsAttempt } from "@/lib/sms-dispatch";
import { reconcileSmsDeliveryEvent } from "@/lib/messaging/sms-delivery-ledger";
import { rowsFromExecute } from "@/lib/db/execute-rows";

/**
 * Platform-operator only. Crosses tenant boundaries deliberately, so it is
 * gated by the PLATFORM_ADMIN_EMAILS allowlist (not the practice "admin" role).
 */
const platformAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!isPlatformAdmin(ctx.session?.user?.email)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Platform admin access only.",
    });
  }
  return next();
});

const MESSAGING_SUBMISSION_LOCK_STALE_MS = 15 * 60 * 1000;
const MESSAGING_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;

function redactedOperatorIdentity(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return "reviewer-recorded";
  return `${local.slice(0, 1)}***@${domain}`;
}

function assertMessagingProviderMutationsEnabled() {
  const flag = process.env.MESSAGING_PROVISIONING_ENABLED?.trim().toLowerCase();
  if (flag !== "true" && flag !== "1") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Messaging provider mutations are disabled by the platform kill-switch.",
    });
  }
}

function telnyxRegistrationWebhookUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  const webhookUrl = publicTelnyxWebhookUrl(raw);
  if (!webhookUrl) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "A public HTTPS app URL is required for Telnyx registration.",
    });
  }
  return webhookUrl;
}

function providerFailure(error: unknown): TRPCError {
  if (error instanceof MessagingRegistrationEncryptionError) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: error.message,
    });
  }
  const message =
    error instanceof Error ? error.message : "Provider request failed.";
  return new TRPCError({
    code:
      error instanceof TelnyxError && error.status === 409
        ? "CONFLICT"
        : "BAD_GATEWAY",
    message,
  });
}

async function messagingSenderForOperator(
  practiceId: string,
  locationId: string,
) {
  return withSystem(db, async (tx) => {
    const [sender] = await tx
      .select({
        practiceId: locationMessaging.practiceId,
        locationId: locationMessaging.locationId,
        provider: locationMessaging.provider,
        messagingProfileId: locationMessaging.messagingProfileId,
        senderE164: locationMessaging.senderE164,
        registrationStatus: locationMessaging.registrationStatus,
        registrationDetail: locationMessaging.registrationDetail,
        providerProfileReady: locationMessaging.providerProfileReady,
        providerProfileSyncedAt: locationMessaging.providerProfileSyncedAt,
        enabled: locationMessaging.enabled,
      })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, practiceId),
          eq(locationMessaging.locationId, locationId),
          isNull(locationMessaging.deletedAt),
          sql`exists (
            select 1
            from ${locations}
            where ${locations.id} = ${locationId}
              and ${locations.practiceId} = ${practiceId}
              and ${locations.deletedAt} is null
          )`,
          sql`exists (
            select 1
            from ${practices}
            where ${practices.id} = ${practiceId}
              and ${practices.deletedAt} is null
          )`,
        ),
      )
      .limit(1);
    if (
      !sender ||
      sender.provider !== "telnyx" ||
      !sender.messagingProfileId ||
      !sender.senderE164
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "This clinic location does not have a complete Telnyx sender identity.",
      });
    }
    return {
      ...sender,
      messagingProfileId: sender.messagingProfileId,
      senderE164: sender.senderE164,
    };
  });
}

async function inspectMessagingProviderReadiness(input: {
  practiceId: string;
  locationId: string;
}) {
  const registration = await registrationForOperator(input.practiceId);
  const sender = await messagingSenderForOperator(
    input.practiceId,
    input.locationId,
  );
  const providerBrandId = registration.providerBrandId;
  const providerCampaignId = registration.providerCampaignId;
  if (!providerBrandId || !providerCampaignId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "The clinic brand and campaign must be submitted first.",
    });
  }

  const webhookUrl = telnyxRegistrationWebhookUrl();
  const { profile, blockers } = await inspectTelnyxProviderReadiness({
    locationId: sender.locationId,
    messagingProfileId: sender.messagingProfileId,
    senderE164: sender.senderE164,
    providerBrandId,
    providerCampaignId,
    registrationStatus: registration.status,
    senderRegistrationStatus: sender.registrationStatus,
    webhookUrl,
  });

  return {
    profile,
    sender,
    blockers,
    registration: {
      id: registration.id,
      practiceId: registration.practiceId,
      providerBrandId,
      providerCampaignId,
      status: registration.status,
    },
  };
}

function expectedMessagingProfileState(
  inspection: Awaited<ReturnType<typeof inspectMessagingProviderReadiness>>,
) {
  return {
    registrationId: inspection.registration.id,
    providerBrandId: inspection.registration.providerBrandId,
    providerCampaignId: inspection.registration.providerCampaignId,
    messagingProfileId: inspection.sender.messagingProfileId,
    senderE164: inspection.sender.senderE164,
    clinicEnabled: inspection.sender.enabled,
    providerProfileReady: inspection.sender.providerProfileReady,
    providerProfileSyncedAt: inspection.sender.providerProfileSyncedAt,
  };
}

async function updateMessagingSenderDisabled(input: {
  practiceId: string;
  locationId: string;
  detail: string;
  syncedAt: Date | null;
}) {
  await withSystem(db, async (tx) => {
    await tx
      .update(locationMessaging)
      .set({
        enabled: false,
        registrationDetail: input.detail,
        providerProfileReady: false,
        providerProfileSyncedAt: input.syncedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.practiceId, input.practiceId),
          eq(locationMessaging.locationId, input.locationId),
          eq(locationMessaging.provider, "telnyx"),
          isNull(locationMessaging.deletedAt),
        ),
      );
  });
}

async function recordMessagingProfileReady(input: {
  practiceId: string;
  locationId: string;
  detail: string;
  expected: {
    registrationId: string;
    providerBrandId: string;
    providerCampaignId: string;
    messagingProfileId: string;
    senderE164: string;
    clinicEnabled: boolean;
    providerProfileReady: boolean;
    providerProfileSyncedAt: Date | null;
  };
}) {
  await withSystem(db, async (tx) => {
    const [updated] = await tx
      .update(locationMessaging)
      .set({
        registrationDetail: input.detail,
        providerProfileReady: true,
        providerProfileSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.practiceId, input.practiceId),
          eq(locationMessaging.locationId, input.locationId),
          eq(locationMessaging.provider, "telnyx"),
          eq(
            locationMessaging.messagingProfileId,
            input.expected.messagingProfileId,
          ),
          eq(locationMessaging.senderE164, input.expected.senderE164),
          eq(locationMessaging.registrationStatus, "active"),
          eq(locationMessaging.enabled, input.expected.clinicEnabled),
          eq(
            locationMessaging.providerProfileReady,
            input.expected.providerProfileReady,
          ),
          input.expected.providerProfileSyncedAt === null
            ? isNull(locationMessaging.providerProfileSyncedAt)
            : eq(
                locationMessaging.providerProfileSyncedAt,
                input.expected.providerProfileSyncedAt,
              ),
          isNull(locationMessaging.deletedAt),
          sql`exists (
            select 1
            from ${messagingRegistrations}
            where ${messagingRegistrations.id} = ${input.expected.registrationId}
              and ${messagingRegistrations.practiceId} = ${input.practiceId}
              and ${messagingRegistrations.providerBrandId} = ${input.expected.providerBrandId}
              and ${messagingRegistrations.providerCampaignId} = ${input.expected.providerCampaignId}
              and ${messagingRegistrations.status} = 'active'
              and ${messagingRegistrations.deletedAt} is null
          )`,
        ),
      )
      .returning({ id: locationMessaging.id });
    if (!updated) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Messaging lifecycle state changed during provider verification. Refresh and inspect again.",
      });
    }
  });
}

async function recordMessagingProfileDisabled(input: {
  practiceId: string;
  locationId: string;
  detail: string;
  expected: {
    messagingProfileId: string;
    senderE164: string;
  };
}) {
  await withSystem(db, async (tx) => {
    const [updated] = await tx
      .update(locationMessaging)
      .set({
        enabled: false,
        registrationDetail: input.detail,
        providerProfileReady: false,
        providerProfileSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.practiceId, input.practiceId),
          eq(locationMessaging.locationId, input.locationId),
          eq(locationMessaging.provider, "telnyx"),
          eq(
            locationMessaging.messagingProfileId,
            input.expected.messagingProfileId,
          ),
          eq(locationMessaging.senderE164, input.expected.senderE164),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .returning({ id: locationMessaging.id });
    if (!updated) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Messaging sender identity changed during provider deactivation. Refresh and disable the current profile.",
      });
    }
  });
}

function campaignReferenceId(practiceId: string) {
  return `openvpm-clinic-${practiceId}`;
}

export function messagingCampaignCopy(input: {
  displayName: string;
  businessPhone: string;
  website: string;
  programUrl: string;
  privacyPolicyUrl: string;
  termsUrl: string;
  optInUrl: string;
}) {
  return {
    description:
      "Veterinary clinic communications including appointment reminders, vaccination and care follow-ups, and two-way client support. Messages are sent only to clients whose SMS consent is recorded by the clinic.",
    sample1: `${input.displayName}: Reminder—your pet's appointment is tomorrow at 10:00 AM. Call ${input.businessPhone} if you need to reschedule. Reply STOP to opt out or HELP for help.`,
    sample2: `${input.displayName}: Your pet's care instructions are ready. Reply here with questions or call ${input.businessPhone}. Reply STOP to opt out or HELP for help.`,
    sample3: `${input.displayName}: Clinic text messaging information: ${input.programUrl} Reply STOP to opt out or HELP for help.`,
    messageFlow: `Clients opt in during phone or in-person intake. Clinic staff read or show the exact disclosure at ${input.optInUrl}, ask for an explicit choice, and record the consent decision, timestamp, disclosure, consent source, and mobile number in OpenVPM. The consent control is optional and unchecked by default. No SMS is sent before consent is recorded. Message frequency varies. Message and data rates may apply. Consent is not a condition of purchase. Reply STOP to opt out or HELP for help. Privacy: ${input.privacyPolicyUrl} Terms: ${input.termsUrl}`,
    helpMessage: `Contact ${input.displayName} at ${input.businessPhone} or ${input.website}. Reply STOP to opt out.`,
    optinMessage: `${input.displayName}: You agreed to receive clinic service texts. Frequency varies. Msg & data rates may apply. Consent is not a condition of purchase. Reply HELP for help or STOP to opt out.`,
    optoutMessage: `${input.displayName}: You have been unsubscribed and will receive no further SMS messages. Reply START to opt back in.`,
  };
}

async function registrationForOperator(practiceId: string) {
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(messagingRegistrations)
      .where(
        and(
          eq(messagingRegistrations.practiceId, practiceId),
          isNull(messagingRegistrations.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The clinic has not completed carrier registration details.",
      });
    }
    return row;
  });
}

async function claimRegistrationOperation(opts: {
  registrationId: string;
  operation: "brand" | "campaign" | "assignment";
  allowReviewedRetry: boolean;
}) {
  return withSystem(db, async (tx) => {
    const lockId = randomUUID();
    const [claimed] = await tx
      .update(messagingRegistrations)
      .set({
        submissionLockId: lockId,
        submissionLockAt: new Date(),
        status: "pending",
        statusDetail: `OpenVPM is submitting the ${opts.operation} step to the carrier.`,
        attemptCount: sql`${messagingRegistrations.attemptCount} + 1`,
        lastSubmittedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messagingRegistrations.id, opts.registrationId),
          isNull(messagingRegistrations.deletedAt),
          isNull(messagingRegistrations.submissionLockId),
          opts.allowReviewedRetry
            ? sql`true`
            : sql`${messagingRegistrations.lastError} is null`,
        ),
      )
      .returning({ id: messagingRegistrations.id });
    if (!claimed) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A provider operation is already running or a previous ambiguous failure needs operator review.",
      });
    }
    return lockId;
  });
}

async function finishRegistrationOperation(opts: {
  registrationId: string;
  lockId: string;
  values: Partial<typeof messagingRegistrations.$inferInsert>;
}) {
  return withSystem(db, async (tx) => {
    const [updated] = await tx
      .update(messagingRegistrations)
      .set({
        ...opts.values,
        submissionLockId: null,
        submissionLockAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messagingRegistrations.id, opts.registrationId),
          eq(messagingRegistrations.submissionLockId, opts.lockId),
          isNull(messagingRegistrations.deletedAt),
        ),
      )
      .returning({ id: messagingRegistrations.id });
    if (!updated) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Registration changed while the provider operation was running.",
      });
    }
  });
}

async function failRegistrationOperation(opts: {
  registrationId: string;
  practiceId: string;
  lockId: string;
  error: unknown;
}) {
  const detail =
    opts.error instanceof Error
      ? opts.error.message.slice(0, 1000)
      : "Provider request failed.";
  await finishRegistrationOperation({
    registrationId: opts.registrationId,
    lockId: opts.lockId,
    values: {
      status: "action_required",
      statusDetail: "Carrier registration needs OpenVPM operator review.",
      lastError: detail,
    },
  });
  await withSystem(db, async (tx) => {
    await tx
      .update(locationMessaging)
      .set({
        enabled: false,
        registrationStatus: "action_required",
        providerProfileReady: false,
        providerProfileSyncedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.practiceId, opts.practiceId),
          eq(locationMessaging.provider, "telnyx"),
          isNull(locationMessaging.deletedAt),
        ),
      );
  });
}

type AdminPracticeSettings = {
  acquisition?: { source?: string; campaign?: string };
  analyticsExcluded?: boolean;
  onboardingCompletedAt?: string | null;
  onboardingState?: {
    onboardingIntent?: OnboardingIntent;
    journeyStepId?: string | null;
    journeyDismissed?: boolean;
    setupHelpRequestedAt?: string | null;
  };
};

const setupStepLabels: Record<string, string> = {
  intent: "Starting path",
  basics: "Clinic basics",
  branding: "Branding",
  team: "Team",
  data: "Data import",
  agent: "AI helper",
  phone: "Texting",
  billing: "Billing",
  allSet: "Finish",
};

function conversionContext(value: unknown) {
  const settings = (value ?? {}) as AdminPracticeSettings;
  const acquisition = settings.acquisition;
  const acquisitionSource =
    [acquisition?.source, acquisition?.campaign].filter(Boolean).join(" · ") ||
    "Unknown";
  const state = settings.onboardingState;
  const onboardingIntent = onboardingIntentLabel(state?.onboardingIntent);
  const analyticsExcluded = settings.analyticsExcluded === true;
  const setupHelpRequestedAt = state?.setupHelpRequestedAt ?? null;

  if (settings.onboardingCompletedAt) {
    return {
      acquisitionSource,
      onboardingIntent,
      analyticsExcluded,
      setupHelpRequestedAt,
      setupStage: "Complete",
    };
  }
  const step = state?.journeyStepId;
  if (step) {
    const label = setupStepLabels[step] ?? step;
    return {
      acquisitionSource,
      onboardingIntent,
      analyticsExcluded,
      setupHelpRequestedAt,
      setupStage: state?.journeyDismissed ? `Paused at ${label}` : label,
    };
  }
  return {
    acquisitionSource,
    onboardingIntent,
    analyticsExcluded,
    setupHelpRequestedAt,
    setupStage: "Not started",
  };
}

export const adminRouter = createRouter({
  /** Am I a platform admin? (drives whether the /admin nav shows.) */
  isPlatformAdmin: protectedProcedure.query(({ ctx }) => {
    return isPlatformAdmin(ctx.session?.user?.email);
  }),

  /** Bounded, recipient-free verification-email recovery queue. */
  authEmailRecoveryQueue: platformAdminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(50) })
        .default({}),
    )
    .query(({ input }) => {
      noStore();
      return withSystem(db, async (tx) => {
        const result = await tx.execute(sql`
          with latest_attempts as (
            select distinct on (attempt.practice_id, attempt.user_id)
              attempt.*
            from auth_email_attempts attempt
            join users account
              on account.id = attempt.user_id
             and account.practice_id = attempt.practice_id
             and account.deleted_at is null
             and account.email_verified_at is null
            order by
              attempt.practice_id,
              attempt.user_id,
              attempt.created_at desc,
              attempt.id desc
          ), attempt_issues as (
            select
              attempt.created_at as "occurredAt",
              practice.name as "practiceName",
              attempt.source::text as source,
              attempt.outcome::text as outcome,
              case
                when attempt.outcome = 'reserved'
                  then 'provider_outcome_missing'
                when attempt.outcome = 'outcome_unknown'
                  then 'provider_outcome_unknown'
                when attempt.outcome = 'definite_failure'
                  then 'provider_definite_failure'
                else 'delivery_confirmation_missing'
              end as reason
            from latest_attempts attempt
            join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
            where (
              (
                attempt.outcome = 'reserved'
                and attempt.created_at <= now() - interval '15 minutes'
              ) or attempt.outcome in ('outcome_unknown', 'definite_failure')
                or (
                  attempt.provider = 'resend'
                  and attempt.outcome = 'accepted'
                  and attempt.resolved_at <= now() - interval '60 minutes'
                  and not exists (
                    select 1
                    from auth_email_delivery_events delivery
                    where (
                      delivery.attempt_id = attempt.id
                      or (
                        delivery.attempt_id is null
                        and delivery.provider = attempt.provider
                        and delivery.provider_message_id = attempt.provider_message_id
                      )
                    )
                    and delivery.classification in (
                      'delivered', 'failed', 'complained'
                    )
                  )
                )
            )
          ), delivery_incidents as (
            select
              terminal.received_at as "occurredAt",
              practice.name as "practiceName",
              attempt.source::text as source,
              attempt.outcome::text as outcome,
              case
                when terminal.classification = 'complained'
                  then 'delivery_complained'
                else 'delivery_failed'
              end as reason
            from latest_attempts attempt
            join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
            join lateral (
              select
                delivery.received_at,
                delivery.classification
              from auth_email_delivery_events delivery
              where (
                delivery.attempt_id = attempt.id
                or (
                  delivery.attempt_id is null
                  and delivery.provider = attempt.provider
                  and delivery.provider_message_id = attempt.provider_message_id
                )
              )
                and delivery.classification in (
                  'delivered', 'failed', 'complained'
                )
              order by
                delivery.occurred_at desc,
                delivery.received_at desc,
                delivery.id desc
              limit 1
            ) terminal on true
            where attempt.outcome = 'accepted'
              and terminal.classification in ('failed', 'complained')
          ), attribution_issues as (
            select
              delivery.received_at as "occurredAt",
              coalesce(practice.name, 'Unattributed auth email') as "practiceName",
              null::text as source,
              null::text as outcome,
              case
                when delivery.attribution = 'identity_conflict'
                  then 'delivery_identity_conflict'
                else 'delivery_attribution_unmatched'
              end as reason
            from auth_email_delivery_events delivery
            left join auth_email_attempts attempt
              on attempt.id = delivery.attempt_id
              or (
                delivery.attempt_id is null
                and attempt.provider = delivery.provider
                and attempt.provider_message_id = delivery.provider_message_id
              )
            left join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
            where delivery.attribution = 'identity_conflict'
              or (
                delivery.attribution = 'unmatched'
                and attempt.id is null
              )
          ), identity_mismatches as (
            select
              delivery.received_at as "occurredAt",
              practice.name as "practiceName",
              attempt.source::text as source,
              attempt.outcome::text as outcome,
              'delivery_identity_conflict'::text as reason
            from auth_email_delivery_events delivery
            join auth_email_attempts attempt
              on attempt.id = delivery.attempt_id
            join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
            where delivery.provider <> attempt.provider
               or (
                 attempt.provider_message_id is not null
                 and delivery.provider_message_id <> attempt.provider_message_id
               )
          ), webhook_conflicts as (
            select
              quarantine.received_at as "occurredAt",
              coalesce(practice.name, 'Unattributed auth email') as "practiceName",
              attempt.source::text as source,
              attempt.outcome::text as outcome,
              'webhook_payload_conflict'::text as reason
            from auth_email_webhook_conflicts quarantine
            join auth_email_delivery_events original
              on original.webhook_id = quarantine.original_webhook_id
            left join auth_email_attempts attempt
              on attempt.id = original.attempt_id
              or (
                original.attempt_id is null
                and attempt.provider = original.provider
                and attempt.provider_message_id = original.provider_message_id
              )
            left join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
          ), provider_identity_conflicts as (
            select
              conflict.occurred_at as "occurredAt",
              practice.name as "practiceName",
              conflict.source::text as source,
              attempt.outcome::text as outcome,
              'provider_identity_conflict'::text as reason
            from auth_email_provider_identity_conflicts conflict
            join auth_email_attempts attempt
              on attempt.id = conflict.attempt_id
            join practices practice
              on practice.id = attempt.practice_id
             and practice.deleted_at is null
          ), queue as (
            select * from attempt_issues
            union all
            select * from delivery_incidents
            union all
            select * from attribution_issues
            union all
            select * from identity_mismatches
            union all
            select * from webhook_conflicts
            union all
            select * from provider_identity_conflicts
          )
          select
            "occurredAt",
            "practiceName",
            source,
            outcome,
            reason,
            greatest(
              0,
              floor(extract(epoch from (now() - "occurredAt")) / 60)
            )::int as "ageMinutes"
          from queue
          order by "occurredAt" asc, reason asc
          limit ${input.limit}
        `);

        return {
          cacheControl: "no-store" as const,
          items: rowsFromExecute<{
            occurredAt: Date;
            practiceName: string;
            source: "registration" | "authenticated_resend" | null;
            outcome:
              | "reserved"
              | "accepted"
              | "definite_failure"
              | "outcome_unknown"
              | null;
            reason:
              | "provider_outcome_missing"
              | "provider_outcome_unknown"
              | "provider_definite_failure"
              | "delivery_confirmation_missing"
              | "delivery_failed"
              | "delivery_complained"
              | "delivery_identity_conflict"
              | "delivery_attribution_unmatched"
              | "webhook_payload_conflict"
              | "provider_identity_conflict";
            ageMinutes: number;
          }>(result).map((row) => ({
            ...row,
            providerMessageHint: null,
          })),
        };
      });
    }),

  /** Cross-tenant operations overview: practices, plans, status, usage, MRR. */
  overview: platformAdminProcedure.query(async () =>
    // Bypass tenant RLS — this view legitimately spans all practices.
    withSystem(db, async (tx) => {
      const rows = await tx
        .select({
          id: practices.id,
          name: practices.name,
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
          timezone: practices.timezone,
          country: practices.country,
          createdAt: practices.createdAt,
          settings: practices.settings,
        })
        .from(practices)
        .where(isNull(practices.deletedAt))
        .orderBy(desc(practices.createdAt));

      const countBy = async (
        table:
          | typeof users
          | typeof clients
          | typeof patients
          | typeof locations,
      ) => {
        const res = await tx
          .select({
            practiceId: table.practiceId,
            c: sql<number>`count(*)::int`,
          })
          .from(table)
          .where(isNull(table.deletedAt))
          .groupBy(table.practiceId);
        return new Map(res.map((r) => [r.practiceId, Number(r.c)]));
      };

      const [
        userCounts,
        clientCounts,
        patientCounts,
        locationCounts,
        adminRows,
      ] = await Promise.all([
        countBy(users),
        countBy(clients),
        countBy(patients),
        countBy(locations),
        tx
          .select({
            practiceId: users.practiceId,
            name: users.name,
            email: users.email,
            emailVerifiedAt: users.emailVerifiedAt,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(and(eq(users.role, "admin"), isNull(users.deletedAt)))
          .orderBy(users.practiceId, users.createdAt),
      ]);

      const primaryAdminByPractice = new Map<
        string,
        (typeof adminRows)[number]
      >();
      for (const admin of adminRows) {
        if (!primaryAdminByPractice.has(admin.practiceId)) {
          primaryAdminByPractice.set(admin.practiceId, admin);
        }
      }

      const practiceRows = rows.map((p) => {
        const { settings, ...practice } = p;
        const primaryAdmin = primaryAdminByPractice.get(p.id);
        const userCount = userCounts.get(p.id) ?? 0;
        const locationCount = Math.max(1, locationCounts.get(p.id) ?? 0);
        const estimatedMrr =
          p.billingStatus === "active" && getPlan(p.tier).tier === "cloud"
            ? locationCount * CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD +
              userCount * CLOUD_SEAT_UNIT_PRICE_MONTHLY_USD
            : 0;
        return {
          ...practice,
          ...conversionContext(settings),
          userCount,
          locationCount,
          estimatedMrr,
          clientCount: clientCounts.get(p.id) ?? 0,
          patientCount: patientCounts.get(p.id) ?? 0,
          adminName: primaryAdmin?.name ?? null,
          adminEmail: primaryAdmin?.email ?? null,
          adminEmailVerifiedAt: primaryAdmin?.emailVerifiedAt ?? null,
        };
      });

      // MRR: active hosted Cloud subscriptions use hybrid location + staff pricing.
      const estimatedMrr = practiceRows
        .filter(
          (p) =>
            p.billingStatus === "active" && getPlan(p.tier).tier === "cloud",
        )
        .reduce((sum, p) => sum + p.estimatedMrr, 0);

      const byTier: Record<PlanTier, number> = {
        free: 0,
        cloud: 0,
        enterprise: 0,
      };
      for (const p of practiceRows) {
        const t = getPlan(p.tier).tier;
        byTier[t] += 1;
      }

      const overviewNow = new Date();

      return {
        practices: practiceRows,
        totals: {
          practices: practiceRows.length,
          estimatedMrr,
          byTier,
          activeTrials: practiceRows.filter(
            (p) =>
              p.billingStatus === "trialing" &&
              p.trialEndsAt != null &&
              p.trialEndsAt.getTime() > overviewNow.getTime(),
          ).length,
          active: practiceRows.filter((p) => p.billingStatus === "active")
            .length,
          pastDue: practiceRows.filter((p) => p.billingStatus === "past_due")
            .length,
        },
      };
    }),
  ),

  /**
   * Platform-operator tooling: give a trialing practice more time. Extends
   * from the later of now / the current trial end, so a lapsed no-card trial
   * comes back to life. Paid, past-due, and canceled practices are managed in
   * Stripe, never here.
   */
  extendTrial: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        days: z.number().int().min(1).max(90),
      }),
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [practice] = await tx
          .select({
            id: practices.id,
            billingStatus: practices.billingStatus,
            trialEndsAt: practices.trialEndsAt,
          })
          .from(practices)
          .where(
            and(
              eq(practices.id, input.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .limit(1);

        if (!practice) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Practice not found.",
          });
        }
        if (practice.billingStatus !== "trialing") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Only trialing practices can be extended. Paid and canceled practices are managed through Stripe.",
          });
        }

        const now = Date.now();
        const base =
          practice.trialEndsAt && practice.trialEndsAt.getTime() > now
            ? practice.trialEndsAt.getTime()
            : now;
        const trialEndsAt = new Date(base + input.days * 24 * 60 * 60 * 1000);

        await tx
          .update(practices)
          .set({ trialEndsAt, updatedAt: new Date() })
          .where(eq(practices.id, input.practiceId));

        return { practiceId: input.practiceId, trialEndsAt };
      }),
    ),

  /** Reversibly exclude internal/test practices from conversion reporting. */
  setAnalyticsExcluded: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        excluded: z.boolean(),
      }),
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [updated] = await tx
          .update(practices)
          .set({
            settings: sql`coalesce(${practices.settings}, '{}'::jsonb) || ${JSON.stringify(
              {
                analyticsExcluded: input.excluded,
              },
            )}::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(practices.id, input.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .returning({ id: practices.id });

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Practice not found.",
          });
        }
        return { practiceId: input.practiceId, excluded: input.excluded };
      }),
    ),

  /** Bounded, PHI-free, read-only launch and delivery exception monitor. */
  smsOperationsHealth: platformAdminProcedure.query(() => {
    noStore();
    return getSmsOperationsHealth(db);
  }),

  /** Redacted A2P work queue. Legal tax IDs are never exposed here. */
  messagingRegistrationQueue: platformAdminProcedure.query(async () =>
    withSystem(db, async (tx) => {
      const rows = await tx
        .select({
          id: messagingRegistrations.id,
          practiceId: messagingRegistrations.practiceId,
          practiceName: practices.name,
          displayName: messagingRegistrations.displayName,
          legalName: messagingRegistrations.legalName,
          entityType: messagingRegistrations.entityType,
          taxIdLast4: messagingRegistrations.taxIdLast4,
          status: messagingRegistrations.status,
          statusDetail: messagingRegistrations.statusDetail,
          providerBrandId: messagingRegistrations.providerBrandId,
          providerBrandStatus: messagingRegistrations.providerBrandStatus,
          providerCampaignId: messagingRegistrations.providerCampaignId,
          providerCampaignStatus: messagingRegistrations.providerCampaignStatus,
          attemptCount: messagingRegistrations.attemptCount,
          lastSubmittedAt: messagingRegistrations.lastSubmittedAt,
          lastSyncedAt: messagingRegistrations.lastSyncedAt,
          lastError: messagingRegistrations.lastError,
          submissionLockAt: messagingRegistrations.submissionLockAt,
          updatedAt: messagingRegistrations.updatedAt,
        })
        .from(messagingRegistrations)
        .innerJoin(
          practices,
          and(
            eq(practices.id, messagingRegistrations.practiceId),
            isNull(practices.deletedAt),
          ),
        )
        .where(isNull(messagingRegistrations.deletedAt))
        .orderBy(desc(messagingRegistrations.updatedAt));

      const senders = await tx
        .select({
          practiceId: locationMessaging.practiceId,
          locationId: locationMessaging.locationId,
          provider: locationMessaging.provider,
          messagingProfileId: locationMessaging.messagingProfileId,
          senderE164: locationMessaging.senderE164,
          registrationStatus: locationMessaging.registrationStatus,
          registrationDetail: locationMessaging.registrationDetail,
          providerProfileReady: locationMessaging.providerProfileReady,
          providerProfileSyncedAt: locationMessaging.providerProfileSyncedAt,
          enabled: locationMessaging.enabled,
        })
        .from(locationMessaging)
        .where(isNull(locationMessaging.deletedAt));
      return rows.map((row) => ({
        ...row,
        senders: senders
          .filter((sender) => sender.practiceId === row.practiceId)
          .map((sender) => ({
            ...sender,
            providerProfileReady:
              sender.providerProfileReady &&
              sender.providerProfileSyncedAt !== null &&
              sender.providerProfileSyncedAt.getTime() >=
                Date.now() - MESSAGING_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS,
          })),
      }));
    }),
  ),

  /** Read the exact provider profile and every prerequisite without mutating it. */
  inspectMessagingProfile: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        locationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const inspection = await inspectMessagingProviderReadiness(input);
        const { profile, blockers } = inspection;
        const ready = blockers.length === 0 && profile.enabled === true;
        if (ready) {
          await recordMessagingProfileReady({
            ...input,
            detail:
              "Provider profile is active and verified. A clinic admin may now enable this approved pilot sender.",
            expected: expectedMessagingProfileState(inspection),
          });
        } else {
          await updateMessagingSenderDisabled({
            ...input,
            detail:
              blockers.length > 0
                ? `Provider profile is not ready: ${blockers.join("; ")}.`
                : "Provider profile is verified but remains disabled. Clinic sending stays off.",
            syncedAt: new Date(),
          });
        }
        return {
          locationId: input.locationId,
          enabled: profile.enabled === true,
          activationReady: blockers.length === 0,
          clinicEnableReady: ready,
          blockers,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw providerFailure(error);
      }
    }),

  /**
   * Explicit provider-side profile switch. Clinic sending remains disabled
   * until its own admin performs the final, separately allowlisted enable.
   */
  setMessagingProfileEnabled: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        locationId: z.string().uuid(),
        enabled: z.boolean(),
        confirmProviderMutation: z.literal(true),
      }),
    )
    .mutation(async ({ input }) => {
      assertMessagingProviderMutationsEnabled();
      const sender = await messagingSenderForOperator(
        input.practiceId,
        input.locationId,
      );

      if (!input.enabled) {
        await updateMessagingSenderDisabled({
          ...input,
          detail:
            "OpenVPM disabled the provider profile. Clinic sending remains off.",
          syncedAt: null,
        });
        try {
          const targetSender = await messagingSenderForOperator(
            input.practiceId,
            input.locationId,
          );
          let profile = await getMessagingProfile(
            targetSender.messagingProfileId,
          );
          const reused = profile.enabled === false;
          if (!reused) {
            await updateMessagingProfileEnabled({
              profileId: targetSender.messagingProfileId,
              enabled: false,
            });
            profile = await getMessagingProfile(
              targetSender.messagingProfileId,
            );
          }
          if (profile.enabled !== false) {
            throw new TRPCError({
              code: "BAD_GATEWAY",
              message:
                "Telnyx did not confirm that the messaging profile is disabled.",
            });
          }
          await recordMessagingProfileDisabled({
            ...input,
            detail:
              "OpenVPM disabled the provider profile. Clinic sending remains off.",
            expected: {
              messagingProfileId: targetSender.messagingProfileId,
              senderE164: targetSender.senderE164,
            },
          });
          return {
            locationId: input.locationId,
            enabled: false,
            clinicEnabled: false,
            reused,
          };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw providerFailure(error);
        }
      }

      if (sender.enabled) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Turn off clinic sending before changing its provider profile.",
        });
      }

      await updateMessagingSenderDisabled({
        ...input,
        detail:
          "OpenVPM is verifying the provider profile. Clinic sending remains off.",
        syncedAt: null,
      });

      try {
        const inspection = await inspectMessagingProviderReadiness(input);
        if (inspection.blockers.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Provider profile is not safe to enable: ${inspection.blockers.join(
              "; ",
            )}.`,
          });
        }
        let profile = inspection.profile;
        const inspectedSender = inspection.sender;
        const reused = profile.enabled === true;
        if (!reused) {
          await updateMessagingProfileEnabled({
            profileId: inspectedSender.messagingProfileId,
            enabled: true,
          });
          profile = await getMessagingProfile(
            inspectedSender.messagingProfileId,
          );
        }
        const readbackIssues = messagingProfileSafetyIssues(profile, {
          id: inspectedSender.messagingProfileId,
          name: openVpmMessagingProfileName(inspectedSender.locationId),
          webhookUrl: telnyxRegistrationWebhookUrl(),
        });
        if (profile.enabled !== true || readbackIssues.length > 0) {
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message:
              "Telnyx did not confirm the exact safe messaging-profile state.",
          });
        }
        await recordMessagingProfileReady({
          ...input,
          detail:
            "Provider profile is active and verified. A clinic admin may now enable this approved pilot sender.",
          expected: expectedMessagingProfileState(inspection),
        });
        return {
          locationId: input.locationId,
          enabled: true,
          clinicEnabled: false,
          reused,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw providerFailure(error);
      }
    }),

  /** Fee-bearing TCR brand creation; platform operator only and explicitly confirmed. */
  submitMessagingBrand: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        confirmProviderCharges: z.literal(true),
        retryAfterProviderReview: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      assertMessagingProviderMutationsEnabled();
      const registration = await registrationForOperator(input.practiceId);
      if (registration.providerBrandId) {
        return {
          ok: true,
          providerBrandId: registration.providerBrandId,
          reused: true,
        };
      }
      const lockId = await claimRegistrationOperation({
        registrationId: registration.id,
        operation: "brand",
        allowReviewedRetry: input.retryAfterProviderReview,
      });
      try {
        const brand = await createA2pBrand({
          entityType: registration.entityType,
          displayName: registration.displayName,
          legalName: registration.legalName,
          ein: decryptRegistrationTaxId(registration.taxIdEncrypted),
          firstName: registration.contactFirstName,
          lastName: registration.contactLastName,
          email: registration.contactEmail,
          phone: registration.businessPhone,
          street: registration.street,
          city: registration.city,
          state: registration.state,
          postalCode: registration.postalCode,
          website: registration.website,
          webhookUrl: telnyxRegistrationWebhookUrl(),
        });
        await finishRegistrationOperation({
          registrationId: registration.id,
          lockId,
          values: {
            providerBrandId: brand.brandId,
            providerBrandStatus: brand.identityStatus ?? brand.status,
            status:
              brand.identityStatus === "UNVERIFIED"
                ? "action_required"
                : "pending",
            statusDetail:
              brand.identityStatus === "UNVERIFIED"
                ? "Carrier could not verify the clinic identity; OpenVPM review is required."
                : "Carrier brand submitted. Waiting for identity verification.",
            lastError: brand.failureReasons,
            lastSyncedAt: new Date(),
          },
        });
        return { ok: true, providerBrandId: brand.brandId, reused: false };
      } catch (error) {
        await failRegistrationOperation({
          registrationId: registration.id,
          practiceId: registration.practiceId,
          lockId,
          error,
        });
        throw providerFailure(error);
      }
    }),

  /** Fee-bearing campaign submission with reference-id recovery before POST. */
  submitMessagingCampaign: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        confirmProviderCharges: z.literal(true),
        retryAfterProviderReview: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      assertMessagingProviderMutationsEnabled();
      const registration = await registrationForOperator(input.practiceId);
      if (!registration.providerBrandId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Submit the clinic brand before its campaign.",
        });
      }
      if (registration.providerCampaignId) {
        return {
          ok: true,
          providerCampaignId: registration.providerCampaignId,
          reused: true,
        };
      }

      const brand = await getA2pBrand(registration.providerBrandId);
      if (
        !new Set(["VERIFIED", "VETTED_VERIFIED"]).has(
          brand.identityStatus ?? "",
        )
      ) {
        await withSystem(db, async (tx) => {
          await tx
            .update(messagingRegistrations)
            .set({
              providerBrandStatus: brand.identityStatus ?? brand.status,
              status:
                brand.identityStatus === "UNVERIFIED"
                  ? "action_required"
                  : "pending",
              statusDetail:
                "Carrier brand verification must finish before campaign submission.",
              lastError: brand.failureReasons,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(messagingRegistrations.id, registration.id));
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Carrier brand verification is not complete.",
        });
      }

      const referenceId = campaignReferenceId(input.practiceId);
      const recovered = await findA2pCampaignByReference({
        brandId: registration.providerBrandId,
        referenceId,
      });
      if (recovered) {
        await withSystem(db, async (tx) => {
          await tx
            .update(messagingRegistrations)
            .set({
              providerCampaignId: recovered.campaignId,
              providerCampaignStatus:
                recovered.campaignStatus ??
                recovered.status ??
                recovered.submissionStatus,
              status: "pending",
              statusDetail:
                "Recovered the existing carrier campaign; awaiting approval.",
              lastError: recovered.failureReasons,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(messagingRegistrations.id, registration.id));
        });
        return {
          ok: true,
          providerCampaignId: recovered.campaignId,
          reused: true,
        };
      }

      const lockId = await claimRegistrationOperation({
        registrationId: registration.id,
        operation: "campaign",
        allowReviewedRetry: input.retryAfterProviderReview,
      });
      try {
        const programUrls = messagingProgramUrls(registration.practiceId);
        const copy = messagingCampaignCopy({
          displayName: registration.displayName,
          businessPhone: registration.businessPhone,
          website: registration.website,
          programUrl: programUrls.programUrl,
          privacyPolicyUrl: registration.privacyPolicyUrl,
          termsUrl: registration.termsUrl,
          optInUrl: programUrls.optInUrl,
        });
        const campaign = await createA2pCampaign({
          brandId: registration.providerBrandId,
          referenceId,
          displayName: registration.displayName,
          ...copy,
          privacyPolicyUrl: registration.privacyPolicyUrl,
          termsUrl: registration.termsUrl,
          webhookUrl: telnyxRegistrationWebhookUrl(),
        });
        await finishRegistrationOperation({
          registrationId: registration.id,
          lockId,
          values: {
            providerBrandStatus: brand.identityStatus ?? brand.status,
            providerCampaignId: campaign.campaignId,
            providerCampaignStatus:
              campaign.campaignStatus ??
              campaign.status ??
              campaign.submissionStatus,
            status: "pending",
            statusDetail:
              "Carrier campaign submitted. Waiting for mobile-network approval.",
            lastError: campaign.failureReasons,
            lastSyncedAt: new Date(),
          },
        });
        return {
          ok: true,
          providerCampaignId: campaign.campaignId,
          reused: false,
        };
      } catch (error) {
        await failRegistrationOperation({
          registrationId: registration.id,
          practiceId: registration.practiceId,
          lockId,
          error,
        });
        throw providerFailure(error);
      }
    }),

  /** Idempotent number-to-campaign assignment; never enables sending. */
  assignMessagingNumbers: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        confirmProviderMutation: z.literal(true),
      }),
    )
    .mutation(async ({ input }) => {
      assertMessagingProviderMutationsEnabled();
      const registration = await registrationForOperator(input.practiceId);
      if (!registration.providerCampaignId || !registration.providerBrandId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "An approved brand and campaign are required before assignment.",
        });
      }
      const campaign = await getA2pCampaign(registration.providerCampaignId);
      if (
        campaign.status !== "ACTIVE" &&
        campaign.campaignStatus !== "MNO_PROVISIONED"
      ) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The carrier campaign is not fully active yet.",
        });
      }
      const senders = await withSystem(db, async (tx) =>
        tx
          .select({ phoneNumber: locationMessaging.senderE164 })
          .from(locationMessaging)
          .where(
            and(
              eq(locationMessaging.practiceId, input.practiceId),
              eq(locationMessaging.provider, "telnyx"),
              isNull(locationMessaging.deletedAt),
              sql`nullif(trim(${locationMessaging.senderE164}), '') is not null`,
            ),
          ),
      );
      if (senders.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Provision at least one clinic texting number first.",
        });
      }

      const assignments: TelnyxNumberAssignment[] = [];
      for (const sender of senders) {
        if (!sender.phoneNumber) continue;
        assignments.push(
          await ensureA2pNumberAssignment({
            phoneNumber: sender.phoneNumber,
            campaignId: registration.providerCampaignId,
          }),
        );
      }
      const observed = observedRegistrationStatus({
        brandIdentityStatus: registration.providerBrandStatus,
        campaignStatus: campaign.campaignStatus ?? campaign.status,
        campaignSubmissionStatus: campaign.submissionStatus,
        assignmentStatuses: assignments.map((row) => row.assignmentStatus),
      });
      const next = mergeRegistrationStatus(registration.status, observed);
      await withSystem(db, async (tx) => {
        await tx
          .update(messagingRegistrations)
          .set({
            providerCampaignStatus:
              campaign.campaignStatus ??
              campaign.status ??
              campaign.submissionStatus,
            status: next,
            statusDetail:
              next === "active"
                ? "Carrier registration and all clinic number assignments are active."
                : "Clinic numbers were submitted for carrier assignment.",
            lastError:
              assignments
                .map((row) => row.failureReasons)
                .filter(Boolean)
                .join("; ") || null,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(messagingRegistrations.id, registration.id));
        await tx
          .update(locationMessaging)
          .set({
            a2pBrandId: registration.providerBrandId,
            a2pCampaignId: registration.providerCampaignId,
            registrationStatus: next,
            registrationDetail:
              next === "active"
                ? "Carrier registration active. An admin may now enable sending."
                : "Carrier number assignment is pending.",
            providerProfileReady: false,
            providerProfileSyncedAt: null,
            enabled: false,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(locationMessaging.practiceId, input.practiceId),
              eq(locationMessaging.provider, "telnyx"),
              isNull(locationMessaging.deletedAt),
            ),
          );
      });
      return { ok: true, status: next, assigned: assignments.length };
    }),

  smsDeliveryEventQueue: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid().optional(),
        staleMinutes: z.number().int().min(15).max(10_080).default(60),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(({ input }) => {
      noStore();
      return loadSmsDeliveryEventQueue(db, input);
    }),

  reconcileSmsDeliveryEvent: platformAdminProcedure
    .input(
      z.object({
        deliveryEventId: z.string().uuid(),
        reconciliationId: z.string().uuid(),
        reviewedHistoryId: z.string().uuid().optional(),
        classification: z.enum(["sent", "failed", "delivered"]).optional(),
        reasonCode: z.enum([
          "exact_attribution_retry",
          "provider_portal_status_review",
          "projection_repair",
          "identity_conflict_review",
          "unmatched_evidence_review",
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await reconcileSmsDeliveryEvent({
          deliveryEventId: input.deliveryEventId,
          reconciliationId: input.reconciliationId,
          reviewedHistoryId: input.reviewedHistoryId,
          classification: input.classification,
          reasonCode: input.reasonCode,
          actorIdentity: ctx.session!.user.email,
          actorName: ctx.session!.user.name?.trim() || ctx.session!.user.email,
        });
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "SMS delivery reconciliation failed.",
        });
      }
    }),

  smsDeliveryEventDetail: platformAdminProcedure
    .input(
      z.object({
        deliveryEventId: z.string().uuid(),
        historyLimit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(({ input }) => {
      noStore();
      return withSystem(db, async (tx) => {
        const [event] = await tx
          .select({
            id: smsDeliveryEvents.id,
            receivedAt: smsDeliveryEvents.receivedAt,
            provider: smsDeliveryEvents.provider,
            providerEventId: smsDeliveryEvents.providerEventId,
            providerMessageId: smsDeliveryEvents.providerMessageId,
            providerEventType: smsDeliveryEvents.providerEventType,
            providerStatus: smsDeliveryEvents.providerStatus,
            providerErrorCode: smsDeliveryEvents.providerErrorCode,
            classification: smsDeliveryEvents.classification,
            occurredAt: smsDeliveryEvents.occurredAt,
            payloadFingerprintSha256:
              smsDeliveryEvents.payloadFingerprintSha256,
          })
          .from(smsDeliveryEvents)
          .where(eq(smsDeliveryEvents.id, input.deliveryEventId))
          .limit(1);
        if (!event) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "SMS delivery evidence not found.",
          });
        }
        const candidateAttempts = event.providerMessageId
          ? await tx
              .select({
                practiceId: smsSendAttempts.practiceId,
                attemptId: smsSendAttempts.id,
              })
              .from(smsSendAttempts)
              .innerJoin(
                smsSendAttemptEvents,
                and(
                  eq(
                    smsSendAttemptEvents.practiceId,
                    smsSendAttempts.practiceId,
                  ),
                  eq(smsSendAttemptEvents.attemptId, smsSendAttempts.id),
                  eq(smsSendAttemptEvents.outcome, "accepted"),
                  eq(
                    smsSendAttemptEvents.providerMessageId,
                    event.providerMessageId,
                  ),
                ),
              )
              .where(eq(smsSendAttempts.provider, event.provider))
              .groupBy(smsSendAttempts.practiceId, smsSendAttempts.id)
              .orderBy(smsSendAttempts.practiceId, smsSendAttempts.id)
              .limit(101)
          : [];
        const history = await tx
          .select({
            id: smsDeliveryEventHistory.id,
            createdAt: smsDeliveryEventHistory.createdAt,
            reviewedHistoryId: smsDeliveryEventHistory.reviewedHistoryId,
            practiceId: smsDeliveryEventHistory.practiceId,
            attemptId: smsDeliveryEventHistory.attemptId,
            communicationId: smsDeliveryEventHistory.communicationId,
            kind: smsDeliveryEventHistory.kind,
            result: smsDeliveryEventHistory.result,
            classification: smsDeliveryEventHistory.classification,
            detail: smsDeliveryEventHistory.detail,
            operatorReasonCode: smsDeliveryEventHistory.operatorReasonCode,
            actorName: smsDeliveryEventHistory.actorName,
            actorIdentity: smsDeliveryEventHistory.actorIdentity,
            eventKey: smsDeliveryEventHistory.eventKey,
          })
          .from(smsDeliveryEventHistory)
          .where(
            eq(smsDeliveryEventHistory.deliveryEventId, input.deliveryEventId),
          )
          .orderBy(
            desc(smsDeliveryEventHistory.createdAt),
            desc(smsDeliveryEventHistory.id),
          )
          .limit(input.historyLimit + 1);
        const truncated = history.length > input.historyLimit;
        const visibleHistory = history.slice(0, input.historyLimit).reverse();
        return {
          cacheControl: "no-store" as const,
          event,
          candidateAttempts: candidateAttempts.slice(0, 100),
          candidateAttemptsTruncated: candidateAttempts.length > 100,
          history: visibleHistory.map((row) => ({
            ...row,
            actorIdentity: redactedOperatorIdentity(row.actorIdentity),
          })),
          truncated,
        };
      });
    }),

  smsSendAttemptQueue: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid().optional(),
        staleMinutes: z
          .number()
          .int()
          .min(15)
          .max(7 * 24 * 60)
          .default(15),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(({ input }) => {
      noStore();
      return loadSmsSendAttemptQueue(db, input);
    }),

  smsSendAttempt: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        attemptId: z.string().uuid(),
      }),
    )
    .query(({ input }) => {
      noStore();
      return withSystem(db, async (tx) => {
        const [attempt] = await tx
          .select({
            id: smsSendAttempts.id,
            createdAt: smsSendAttempts.createdAt,
            practiceId: smsSendAttempts.practiceId,
            clientId: smsSendAttempts.clientId,
            locationId: smsSendAttempts.locationId,
            communicationId: smsSendAttempts.communicationId,
            resendOfAttemptId: smsSendAttempts.resendOfAttemptId,
            source: smsSendAttempts.source,
            sourceId: smsSendAttempts.sourceId,
            idempotencyKey: smsSendAttempts.idempotencyKey,
            registeredDisplayName: smsSendAttempts.registeredDisplayName,
            provider: smsSendAttempts.provider,
            senderMessagingServiceId: smsSendAttempts.senderMessagingServiceId,
            senderE164: smsSendAttempts.senderE164,
            requestedByActorType: smsSendAttempts.requestedByActorType,
            requestedByUserId: smsSendAttempts.requestedByUserId,
            requestedByIdentity: smsSendAttempts.requestedByIdentity,
            requestedByName: smsSendAttempts.requestedByName,
          })
          .from(smsSendAttempts)
          .where(
            and(
              eq(smsSendAttempts.practiceId, input.practiceId),
              eq(smsSendAttempts.id, input.attemptId),
            ),
          )
          .limit(1);
        if (!attempt) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "SMS send attempt not found.",
          });
        }
        const events = await tx
          .select({
            id: smsSendAttemptEvents.id,
            createdAt: smsSendAttemptEvents.createdAt,
            kind: smsSendAttemptEvents.kind,
            outcome: smsSendAttemptEvents.outcome,
            providerMessageId: smsSendAttemptEvents.providerMessageId,
            detail: smsSendAttemptEvents.detail,
            actorType: smsSendAttemptEvents.actorType,
            actorUserId: smsSendAttemptEvents.actorUserId,
            actorIdentity: smsSendAttemptEvents.actorIdentity,
            actorName: smsSendAttemptEvents.actorName,
            eventKey: smsSendAttemptEvents.eventKey,
          })
          .from(smsSendAttemptEvents)
          .where(
            and(
              eq(smsSendAttemptEvents.practiceId, input.practiceId),
              eq(smsSendAttemptEvents.attemptId, input.attemptId),
            ),
          )
          .orderBy(
            desc(smsSendAttemptEvents.createdAt),
            desc(smsSendAttemptEvents.id),
          );
        return { cacheControl: "no-store" as const, attempt, events };
      });
    }),

  reconcileSmsSendAttempt: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        attemptId: z.string().uuid(),
        reconciliationId: z.string().uuid(),
        outcome: z.enum(["accepted", "definite_failure"]),
        providerMessageId: z.string().trim().min(1).max(255).optional(),
        detail: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(({ ctx, input }) =>
      reconcileSmsSendAttempt({
        practiceId: input.practiceId,
        attemptId: input.attemptId,
        outcome: input.outcome,
        providerMessageId: input.providerMessageId,
        detail: input.detail,
        actorType: "platform_operator",
        actorUserId: ctx.session!.user.id,
        actorIdentity: ctx.session!.user.email,
        actorName: ctx.session!.user.name?.trim() || ctx.session!.user.email,
        reconciliationKey: `operator-reconciliation:${input.reconciliationId}`,
      }),
    ),

  resendSmsSendAttempt: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        attemptId: z.string().uuid(),
        resendId: z.string().uuid(),
      }),
    )
    .mutation(({ ctx, input }) =>
      resendSmsAttempt({
        practiceId: input.practiceId,
        attemptId: input.attemptId,
        idempotencyKey: `sms:operator-resend:${input.resendId}`,
        actorType: "platform_operator",
        actorUserId: ctx.session!.user.id,
        actorIdentity: ctx.session!.user.email,
        actorName: ctx.session!.user.name?.trim() || ctx.session!.user.email,
      }),
    ),

  /**
   * Recover an ambiguous provider timeout after an operator confirms the IDs in
   * the Telnyx portal. This clears a stale operation lock without creating or
   * charging for anything; reconciliation must run next.
   */
  attachMessagingProviderIds: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        providerBrandId: z.string().trim().min(3).max(128),
        providerCampaignId: z.string().trim().min(3).max(128).optional(),
        confirmProviderPortalReviewed: z.literal(true),
      }),
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [updated] = await tx
          .update(messagingRegistrations)
          .set({
            providerBrandId: input.providerBrandId,
            providerBrandStatus: null,
            providerCampaignId: input.providerCampaignId ?? null,
            providerCampaignStatus: null,
            status: "pending",
            statusDetail:
              "Provider IDs recovered by an OpenVPM operator; refresh status next.",
            submissionLockId: null,
            submissionLockAt: null,
            lastError: null,
            lastSyncedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messagingRegistrations.practiceId, input.practiceId),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .returning({ id: messagingRegistrations.id });
        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Registration not found.",
          });
        }
        await tx
          .update(locationMessaging)
          .set({
            enabled: false,
            registrationStatus: "pending",
            registrationDetail:
              "Provider IDs changed. OpenVPM must reconcile carrier and provider-profile state again.",
            providerProfileReady: false,
            providerProfileSyncedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(locationMessaging.practiceId, input.practiceId),
              eq(locationMessaging.provider, "telnyx"),
              isNull(locationMessaging.deletedAt),
            ),
          );
        return { ok: true };
      }),
    ),

  /**
   * Clear a crash-stale submission lock only after an operator verifies in the
   * Telnyx portal that the fee-bearing object was not created. A fresh lock can
   * never be cleared, and all clinic senders remain disabled.
   */
  clearStaleMessagingSubmissionLock: platformAdminProcedure
    .input(
      z.object({
        practiceId: z.string().uuid(),
        providerObject: z.enum(["brand", "campaign"]),
        confirmProviderPortalReviewed: z.literal(true),
        confirmNoProviderObjectExists: z.literal("NO_PROVIDER_OBJECT"),
      }),
    )
    .mutation(async ({ input }) =>
      withSystem(db, async (tx) => {
        const [registration] = await tx
          .select({
            id: messagingRegistrations.id,
            submissionLockId: messagingRegistrations.submissionLockId,
            submissionLockAt: messagingRegistrations.submissionLockAt,
            providerBrandId: messagingRegistrations.providerBrandId,
            providerCampaignId: messagingRegistrations.providerCampaignId,
          })
          .from(messagingRegistrations)
          .where(
            and(
              eq(messagingRegistrations.practiceId, input.practiceId),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(1);
        if (!registration?.submissionLockId || !registration.submissionLockAt) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "No locked provider operation exists.",
          });
        }
        if (
          registration.submissionLockAt.getTime() >
          Date.now() - MESSAGING_SUBMISSION_LOCK_STALE_MS
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "The provider operation is still within its 15-minute safety window.",
          });
        }
        if (
          (input.providerObject === "brand" && registration.providerBrandId) ||
          (input.providerObject === "campaign" &&
            registration.providerCampaignId) ||
          (input.providerObject === "campaign" && !registration.providerBrandId)
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Stored provider IDs do not match the operation being recovered.",
          });
        }

        const [updated] = await tx
          .update(messagingRegistrations)
          .set({
            submissionLockId: null,
            submissionLockAt: null,
            status: "action_required",
            statusDetail:
              "OpenVPM confirmed no provider object exists; a reviewed retry is available.",
            lastError: `Operator cleared a stale ${input.providerObject} lock after confirming no provider object exists.`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messagingRegistrations.id, registration.id),
              eq(
                messagingRegistrations.submissionLockId,
                registration.submissionLockId,
              ),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .returning({ id: messagingRegistrations.id });
        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The provider operation changed during recovery. Refresh and review again.",
          });
        }
        await tx
          .update(locationMessaging)
          .set({
            enabled: false,
            registrationStatus: "action_required",
            registrationDetail: "Carrier registration needs OpenVPM review.",
            providerProfileReady: false,
            providerProfileSyncedAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(locationMessaging.practiceId, input.practiceId),
              eq(locationMessaging.provider, "telnyx"),
              isNull(locationMessaging.deletedAt),
            ),
          );
        return { ok: true, providerObject: input.providerObject };
      }),
    ),

  /** Read-only provider reconciliation. Safe to retry and never enables sending. */
  reconcileMessagingRegistration: platformAdminProcedure
    .input(z.object({ practiceId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const registration = await registrationForOperator(input.practiceId);
      if (!registration.providerBrandId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No provider brand has been submitted.",
        });
      }
      try {
        const brand = await getA2pBrand(registration.providerBrandId);
        const campaign = registration.providerCampaignId
          ? await getA2pCampaign(registration.providerCampaignId)
          : null;
        const senders = await withSystem(db, async (tx) =>
          tx
            .select({ phoneNumber: locationMessaging.senderE164 })
            .from(locationMessaging)
            .where(
              and(
                eq(locationMessaging.practiceId, input.practiceId),
                eq(locationMessaging.provider, "telnyx"),
                isNull(locationMessaging.deletedAt),
                sql`nullif(trim(${locationMessaging.senderE164}), '') is not null`,
              ),
            ),
        );
        const assignments: Array<TelnyxNumberAssignment | null> = [];
        if (campaign) {
          for (const sender of senders) {
            if (!sender.phoneNumber) continue;
            assignments.push(await getA2pNumberAssignment(sender.phoneNumber));
          }
        }
        const observed = observedRegistrationStatus({
          brandIdentityStatus: brand.identityStatus,
          brandStatus: brand.status,
          campaignStatus: campaign?.campaignStatus ?? campaign?.status,
          campaignSubmissionStatus: campaign?.submissionStatus,
          assignmentStatuses: assignments.map((row) => row?.assignmentStatus),
        });
        const next = mergeRegistrationStatus(registration.status, observed);
        const failureDetail = [
          brand.failureReasons,
          campaign?.failureReasons,
          ...assignments.map((row) => row?.failureReasons),
        ]
          .filter(Boolean)
          .join("; ")
          .slice(0, 1000);
        await withSystem(db, async (tx) => {
          await tx
            .update(messagingRegistrations)
            .set({
              providerBrandStatus: brand.identityStatus ?? brand.status,
              providerCampaignStatus:
                campaign?.campaignStatus ??
                campaign?.status ??
                campaign?.submissionStatus,
              status: next,
              statusDetail:
                next === "active"
                  ? "Carrier registration and all clinic number assignments are active."
                  : next === "action_required" ||
                      next === "failed" ||
                      next === "suspended"
                    ? "Carrier registration needs OpenVPM operator review."
                    : "Carrier registration is still processing.",
              lastError: failureDetail || null,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(messagingRegistrations.id, registration.id));
          await tx
            .update(locationMessaging)
            .set({
              a2pBrandId: registration.providerBrandId,
              a2pCampaignId: registration.providerCampaignId,
              registrationStatus: next,
              registrationDetail:
                next === "active"
                  ? "Carrier registration active. An admin may now enable sending."
                  : next === "action_required" ||
                      next === "failed" ||
                      next === "suspended"
                    ? "Carrier registration needs OpenVPM review."
                    : "Carrier registration is pending.",
              ...(next === "active"
                ? {}
                : {
                    enabled: false,
                    providerProfileReady: false,
                    providerProfileSyncedAt: null,
                  }),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(locationMessaging.practiceId, input.practiceId),
                eq(locationMessaging.provider, "telnyx"),
                isNull(locationMessaging.deletedAt),
              ),
            );
        });
        return { ok: true, status: next, assignments: assignments.length };
      } catch (error) {
        throw providerFailure(error);
      }
    }),

  /**
   * Trial funnel: signups -> activated -> subscribed, derived from existing
   * rows (see lib/admin/activation-funnel.ts for the definitions).
   */
  activationFunnel: platformAdminProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .optional(),
    )
    .query(({ input }) => computeActivationFunnel(db, input?.days ?? 30)),

  /** Ranked, cross-tenant operator queue for recovering clinic activation. */
  activationRecovery: platformAdminProcedure.query(() =>
    computeActivationRecovery(db, new Date()),
  ),

  /** Privacy-safe first-touch cohorts spanning visit through paid. */
  journeyFunnel: platformAdminProcedure
    .input(
      z
        .object({ days: z.number().int().min(1).max(365).default(30) })
        .optional(),
    )
    .query(({ input }) => computeJourneyFunnel(db, input?.days ?? 30)),
});
