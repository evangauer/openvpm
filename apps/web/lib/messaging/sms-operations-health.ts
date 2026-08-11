import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { publicTelnyxWebhookUrl } from "@/lib/messaging/public-webhook";
import {
  inspectTelnyxProviderReadiness,
  type TelnyxProviderReadinessInput,
} from "@/lib/messaging/provider-readiness";
import {
  loadSmsDeliveryEventQueue,
  loadSmsSendAttemptQueue,
} from "@/lib/messaging/sms-operations-queues";

const MINUTE_MS = 60 * 1000;

export const SMS_OPERATIONS_THRESHOLDS = {
  submissionLockMinutes: 15,
  pendingRegistrationMinutes: 1_440,
  providerAttestationMinutes: 15,
  sendAttemptMinutes: 15,
  deliveryReceiptMinutes: 60,
} as const;

export type SmsOperationsSeverity = "p0" | "p1";
export type SmsOperationsCategory =
  | "carrier"
  | "profile"
  | "send_attempt"
  | "delivery_event";

export interface SmsOperationsItem {
  severity: SmsOperationsSeverity;
  category: SmsOperationsCategory;
  practiceName: string;
  locationName: string | null;
  ageMinutes: number | null;
  reason: string;
  nextAction: string;
}

export interface SmsOperationsHealth {
  cacheControl: "no-store";
  generatedAt: string;
  status: "healthy" | "attention" | "critical";
  counts: {
    critical: number;
    attention: number;
    carrier: number;
    profile: number;
    sendAttempts: number;
    deliveryEvents: number;
    staleWithoutFinal: number;
    providerAuditFailures: number;
  };
  reasons: Array<{
    severity: SmsOperationsSeverity;
    category: SmsOperationsCategory;
    reason: string;
    count: number;
  }>;
  items: SmsOperationsItem[];
  truncated: boolean;
  thresholds: typeof SMS_OPERATIONS_THRESHOLDS;
}

interface InternalIssue extends SmsOperationsItem {
  reasonCode: string;
  observedAt: Date | null;
}

export interface SmsMessagingState {
  practiceId: string;
  practiceName: string;
  registrationId: string | null;
  registrationStatus: string | null;
  providerBrandId: string | null;
  providerCampaignId: string | null;
  registrationDisplayName: string | null;
  registrationEntityType: string | null;
  registrationBusinessPhone: string | null;
  submissionLockAt: Date | string | null;
  lastSubmittedAt: Date | string | null;
  lastSyncedAt: Date | string | null;
  registrationUpdatedAt: Date | string | null;
  locationId: string | null;
  locationName: string | null;
  locationActive: boolean | null;
  provider: string | null;
  messagingProfileId: string | null;
  senderE164: string | null;
  senderBrandId: string | null;
  senderCampaignId: string | null;
  senderRegistrationStatus: string | null;
  providerProfileReady: boolean | null;
  providerProfileSyncedAt: Date | string | null;
  enabled: boolean | null;
  senderUpdatedAt: Date | string | null;
}

interface QueueRow {
  practiceId: string | null;
  locationId: string | null;
  practiceName: string;
  locationName: string | null;
  observedAt: Date | string;
  classification: string;
}

interface SmsOperationsOptions {
  limit?: number;
  now?: Date;
  inspectProvider?: (input: TelnyxProviderReadinessInput) => Promise<{
    blockers: string[];
    profile?: { enabled: boolean | null };
  }>;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ageMinutes(now: Date, value: Date | string | null | undefined) {
  const parsed = asDate(value);
  return parsed
    ? Math.max(0, Math.floor((now.getTime() - parsed.getTime()) / MINUTE_MS))
    : null;
}

function latestDate(
  ...values: Array<Date | string | null | undefined>
): Date | null {
  const dates = values
    .map(asDate)
    .filter((value): value is Date => Boolean(value));
  return dates.length > 0
    ? new Date(Math.max(...dates.map((value) => value.getTime())))
    : null;
}

function issueKey(issue: InternalIssue) {
  return [
    issue.severity,
    issue.category,
    issue.reasonCode,
    issue.practiceName,
    issue.locationName ?? "practice",
  ].join("|");
}

function addIssue(target: Map<string, InternalIssue>, issue: InternalIssue) {
  const key = issueKey(issue);
  const existing = target.get(key);
  if (
    !existing ||
    (issue.observedAt &&
      (!existing.observedAt || issue.observedAt < existing.observedAt))
  ) {
    target.set(key, issue);
  }
}

function stateIssue(
  state: SmsMessagingState,
  input: Omit<InternalIssue, "practiceName" | "locationName"> & {
    practiceWide?: boolean;
  },
): InternalIssue {
  return {
    ...input,
    practiceName: state.practiceName,
    locationName: input.practiceWide ? null : state.locationName,
  };
}

const ATTENTION_STATUSES = new Set(["failed", "suspended", "action_required"]);

/** Pure database-state classifier; provider reads are applied separately. */
export function classifySmsMessagingStates(
  states: SmsMessagingState[],
  now = new Date(),
): InternalIssue[] {
  const issues = new Map<string, InternalIssue>();
  const enabledByPractice = new Map<string, SmsMessagingState[]>();

  for (const state of states) {
    if (state.enabled) {
      const enabled = enabledByPractice.get(state.practiceId) ?? [];
      enabled.push(state);
      enabledByPractice.set(state.practiceId, enabled);
    }

    const registrationObservedAt = latestDate(
      state.lastSyncedAt,
      state.lastSubmittedAt,
      state.registrationUpdatedAt,
    );
    const senderObservedAt = latestDate(
      state.providerProfileSyncedAt,
      state.senderUpdatedAt,
    );

    if (
      state.registrationStatus &&
      ATTENTION_STATUSES.has(state.registrationStatus)
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p1",
          category: "carrier",
          reasonCode: `registration_${state.registrationStatus}`,
          reason: `Carrier registration is ${state.registrationStatus.replaceAll("_", " ")}.`,
          nextAction:
            "Review the carrier registration history and provider portal.",
          observedAt: registrationObservedAt,
          ageMinutes: ageMinutes(now, registrationObservedAt),
          practiceWide: true,
        }),
      );
    }

    if (
      state.senderRegistrationStatus &&
      ATTENTION_STATUSES.has(state.senderRegistrationStatus)
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p1",
          category: "carrier",
          reasonCode: `sender_${state.senderRegistrationStatus}`,
          reason: `Sender registration is ${state.senderRegistrationStatus.replaceAll("_", " ")}.`,
          nextAction:
            "Review the number assignment and carrier reconciliation evidence.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }

    const lockAge = ageMinutes(now, state.submissionLockAt);
    if (
      state.submissionLockAt &&
      lockAge !== null &&
      lockAge >= SMS_OPERATIONS_THRESHOLDS.submissionLockMinutes
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p1",
          category: "carrier",
          reasonCode: "stale_submission_lock",
          reason: "Carrier submission lock is older than the safety window.",
          nextAction:
            "Review the provider portal before recovering IDs or clearing the lock.",
          observedAt: asDate(state.submissionLockAt),
          ageMinutes: lockAge,
          practiceWide: true,
        }),
      );
    }

    if (
      state.registrationStatus &&
      ["pending", "not_started"].includes(state.registrationStatus)
    ) {
      const pendingAge = ageMinutes(now, registrationObservedAt);
      if (
        pendingAge !== null &&
        pendingAge >= SMS_OPERATIONS_THRESHOLDS.pendingRegistrationMinutes
      ) {
        addIssue(
          issues,
          stateIssue(state, {
            severity: "p1",
            category: "carrier",
            reasonCode: "registration_pending_stale",
            reason: "Carrier registration has no recent provider activity.",
            nextAction:
              "Refresh carrier state and review any action required in the provider portal.",
            observedAt: registrationObservedAt,
            ageMinutes: pendingAge,
            practiceWide: true,
          }),
        );
      }
    }

    if (
      state.senderRegistrationStatus &&
      ["pending", "not_started"].includes(state.senderRegistrationStatus)
    ) {
      const pendingAge = ageMinutes(now, senderObservedAt);
      if (
        pendingAge !== null &&
        pendingAge >= SMS_OPERATIONS_THRESHOLDS.pendingRegistrationMinutes
      ) {
        addIssue(
          issues,
          stateIssue(state, {
            severity: "p1",
            category: "carrier",
            reasonCode: "sender_pending_stale",
            reason: "Sender registration has no recent provider activity.",
            nextAction: "Refresh the number assignment and carrier state.",
            observedAt: senderObservedAt,
            ageMinutes: pendingAge,
          }),
        );
      }
    }

    if (!state.locationId) continue;

    if (state.locationActive === false) {
      if (
        state.enabled ||
        state.providerProfileReady === true ||
        Boolean(state.messagingProfileId?.trim()) ||
        Boolean(state.senderE164?.trim())
      ) {
        addIssue(
          issues,
          stateIssue(state, {
            severity: state.enabled ? "p0" : "p1",
            category: "profile",
            reasonCode: state.enabled
              ? "enabled_inactive_location"
              : "inactive_location_configuration",
            reason: state.enabled
              ? "Clinic sending is enabled for a deleted or inactive location."
              : "A deleted or inactive location still has provider messaging configuration.",
            nextAction: state.enabled
              ? "Turn off the global gate and disable this orphaned sender immediately."
              : "Review and retire the orphaned provider configuration.",
            observedAt: senderObservedAt,
            ageMinutes: ageMinutes(now, senderObservedAt),
          }),
        );
      }
      // An inactive location cannot be safely activated. Avoid layering active
      // profile/attestation guidance onto the orphan-cleanup incident.
      continue;
    }

    if (state.enabled && state.provider !== "telnyx") {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "profile",
          reasonCode: "enabled_provider_unsupported",
          reason:
            "Hosted clinic sending is enabled on an unsupported provider.",
          nextAction:
            "Turn off the global gate and disable this clinic sender.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }

    if (state.enabled && state.registrationStatus !== "active") {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "carrier",
          reasonCode: "enabled_registration_inactive",
          reason:
            "Clinic sending is enabled without an active practice registration.",
          nextAction:
            "Disable clinic sending and review carrier registration state.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }
    if (state.enabled && state.senderRegistrationStatus !== "active") {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "carrier",
          reasonCode: "enabled_sender_inactive",
          reason:
            "Clinic sending is enabled without an active sender registration.",
          nextAction:
            "Disable clinic sending and review the number assignment.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }
    if (
      state.enabled &&
      (!state.messagingProfileId?.trim() || !state.senderE164?.trim())
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "profile",
          reasonCode: "enabled_sender_identity_missing",
          reason:
            "Clinic sending is enabled with an incomplete provider sender identity.",
          nextAction:
            "Disable clinic sending and restore the exact profile and number identity.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }
    if (state.enabled && state.providerProfileReady !== true) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "profile",
          reasonCode: "enabled_profile_not_ready",
          reason:
            "Clinic sending is enabled while the provider-readiness gate is closed.",
          nextAction:
            "Disable clinic sending and complete an exact provider inspection.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }
    if (
      state.enabled &&
      (!state.registrationId ||
        !state.providerBrandId ||
        !state.providerCampaignId ||
        state.senderBrandId !== state.providerBrandId ||
        state.senderCampaignId !== state.providerCampaignId)
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p0",
          category: "carrier",
          reasonCode: "enabled_registration_identity_drift",
          reason:
            "Enabled sender identity does not match the active practice registration.",
          nextAction:
            "Disable clinic sending and reconcile the exact brand and campaign assignment.",
          observedAt: senderObservedAt,
          ageMinutes: ageMinutes(now, senderObservedAt),
        }),
      );
    }

    const attestationAge = ageMinutes(now, state.providerProfileSyncedAt);
    if (
      !state.enabled &&
      state.providerProfileReady === true &&
      (attestationAge === null ||
        attestationAge >= SMS_OPERATIONS_THRESHOLDS.providerAttestationMinutes)
    ) {
      addIssue(
        issues,
        stateIssue(state, {
          severity: "p1",
          category: "profile",
          reasonCode: "provider_attestation_expired",
          reason:
            "Provider readiness attestation has expired before clinic activation.",
          nextAction:
            "Run a fresh read-only inspection before any activation decision.",
          observedAt: asDate(state.providerProfileSyncedAt),
          ageMinutes: attestationAge,
        }),
      );
    }
  }

  for (const enabledStates of enabledByPractice.values()) {
    if (enabledStates.length <= 1) continue;
    const state = enabledStates[0]!;
    addIssue(
      issues,
      stateIssue(state, {
        severity: "p0",
        category: "profile",
        reasonCode: "multiple_enabled_locations",
        reason:
          "More than one hosted texting location is enabled for this practice.",
        nextAction:
          "Turn off the global gate and disable extra clinic senders.",
        observedAt: latestDate(
          ...enabledStates.map((row) => row.senderUpdatedAt),
        ),
        ageMinutes: null,
        practiceWide: true,
      }),
    );
  }

  return [...issues.values()];
}

function queueIssue(
  row: QueueRow,
  now: Date,
  category: "send_attempt" | "delivery_event",
): InternalIssue {
  const observedAt = asDate(row.observedAt);
  const sendActions: Record<string, string> = {
    missing_provider_result:
      "Review provider receipt evidence; do not retry blindly.",
    outcome_unknown: "Reconcile the exact provider outcome before any resend.",
    terminal_projection_pending:
      "Repair the communication projection from durable evidence.",
    orphan_pending_communication:
      "Review the orphaned pending communication claim.",
  };
  const deliveryActions: Record<string, string> = {
    identity_conflict:
      "Resolve the identity conflict using exact provider evidence.",
    unmatched: "Review unmatched provider evidence without guessing a clinic.",
    unknown_status: "Classify the provider status from signed evidence.",
    projection_miss: "Repair the delivery projection from immutable evidence.",
    stale_without_final_delivery:
      "Review the provider portal for a missing final receipt.",
  };
  return {
    severity: "p1",
    category,
    practiceName: row.practiceName,
    locationName: row.locationName,
    ageMinutes: ageMinutes(now, observedAt),
    reasonCode: row.classification,
    reason: row.classification.replaceAll("_", " "),
    nextAction:
      (category === "send_attempt" ? sendActions : deliveryActions)[
        row.classification
      ] ?? "Review the exact SMS evidence before taking action.",
    observedAt,
  };
}

async function loadMessagingStates(db: Database): Promise<SmsMessagingState[]> {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      select
        p.id as "practiceId",
        p.name as "practiceName",
        mr.id as "registrationId",
        mr.status::text as "registrationStatus",
        mr.provider_brand_id as "providerBrandId",
        mr.provider_campaign_id as "providerCampaignId",
        mr.display_name as "registrationDisplayName",
        mr.entity_type::text as "registrationEntityType",
        mr.business_phone as "registrationBusinessPhone",
        mr.submission_lock_at as "submissionLockAt",
        mr.last_submitted_at as "lastSubmittedAt",
        mr.last_synced_at as "lastSyncedAt",
        mr.updated_at as "registrationUpdatedAt",
        lm.location_id as "locationId",
        l.name as "locationName",
        (l.id is not null) as "locationActive",
        lm.provider as "provider",
        lm.messaging_profile_id as "messagingProfileId",
        lm.sender_e164 as "senderE164",
        lm.a2p_brand_id as "senderBrandId",
        lm.a2p_campaign_id as "senderCampaignId",
        lm.registration_status::text as "senderRegistrationStatus",
        lm.provider_profile_ready as "providerProfileReady",
        lm.provider_profile_synced_at as "providerProfileSyncedAt",
        lm.enabled as "enabled",
        lm.updated_at as "senderUpdatedAt"
      from practices p
      left join messaging_registrations mr
        on mr.practice_id = p.id and mr.deleted_at is null
      left join location_messaging lm
        on lm.practice_id = p.id and lm.deleted_at is null
      left join locations l
        on l.id = lm.location_id
       and l.practice_id = p.id
       and l.deleted_at is null
      where p.deleted_at is null
        and (mr.id is not null or lm.id is not null)
      order by p.name, p.id, l.name, lm.location_id
    `);
    return rowsFromExecute<SmsMessagingState>(result);
  });
}

function hydrateQueueNames(
  rows: QueueRow[],
  states: SmsMessagingState[],
): QueueRow[] {
  const practiceNames = new Map(
    states.map((state) => [state.practiceId, state.practiceName] as const),
  );
  const locationNames = new Map(
    states
      .filter((state) => state.locationId && state.locationName)
      .map((state) => [state.locationId!, state.locationName!] as const),
  );
  return rows.map((row) => ({
    ...row,
    practiceName:
      (row.practiceId ? practiceNames.get(row.practiceId) : null) ??
      (row.practiceId ? "Clinic unavailable" : "Unattributed provider event"),
    locationName: row.locationId
      ? (locationNames.get(row.locationId) ?? null)
      : null,
  }));
}

function providerReasonCode(blocker: string) {
  const slug = blocker
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `provider_drift_${slug || "unsafe_state"}`;
}

export function classifyProviderReadinessResult(
  state: SmsMessagingState,
  now: Date,
  result: { blockers?: string[]; failed?: boolean },
): InternalIssue[] {
  const observedAt = asDate(state.providerProfileSyncedAt);
  if (result.failed) {
    return [
      stateIssue(state, {
        severity: "p1",
        category: "profile",
        reasonCode: "provider_audit_failed",
        reason: "Read-only provider readiness inspection did not complete.",
        nextAction:
          "Review provider availability and rerun the read-only inspection.",
        observedAt,
        ageMinutes: ageMinutes(now, observedAt),
      }),
    ];
  }
  return (result.blockers ?? []).map((blocker) =>
    stateIssue(state, {
      severity: state.enabled ? "p0" : "p1",
      category: "profile",
      reasonCode: providerReasonCode(blocker),
      reason: `Provider drift: ${blocker}.`,
      nextAction: state.enabled
        ? "Turn off sending and resolve the exact provider drift before reactivation."
        : "Resolve the provider drift and run a fresh inspection before activation.",
      observedAt,
      ageMinutes: ageMinutes(now, observedAt),
    }),
  );
}

async function providerIssues(
  states: SmsMessagingState[],
  now: Date,
  inspectProvider: NonNullable<SmsOperationsOptions["inspectProvider"]>,
): Promise<InternalIssue[]> {
  const webhookUrl = publicTelnyxWebhookUrl(
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim(),
  );
  const candidates = states.filter(
    (state) =>
      state.locationId &&
      state.locationActive !== false &&
      state.provider === "telnyx" &&
      (state.enabled || state.providerProfileReady === true),
  );

  const settled: InternalIssue[][] = [];
  const providerAuditConcurrency = 4;
  for (
    let index = 0;
    index < candidates.length;
    index += providerAuditConcurrency
  ) {
    const batch = candidates.slice(index, index + providerAuditConcurrency);
    const batchResults = await Promise.all(
      batch.map(async (state): Promise<InternalIssue[]> => {
        const observedAt = asDate(state.providerProfileSyncedAt);
        if (
          !webhookUrl ||
          !state.locationId ||
          !state.messagingProfileId?.trim() ||
          !state.senderE164?.trim() ||
          !state.providerBrandId?.trim() ||
          !state.providerCampaignId?.trim() ||
          !state.registrationDisplayName?.trim() ||
          !state.registrationEntityType?.trim() ||
          !state.registrationBusinessPhone?.trim()
        ) {
          return [
            stateIssue(state, {
              severity: "p1",
              category: "profile",
              reasonCode: "provider_audit_failed",
              reason:
                "Provider readiness inspection could not start from complete public configuration.",
              nextAction:
                "Restore the exact provider identity or public webhook configuration, then reinspect.",
              observedAt,
              ageMinutes: ageMinutes(now, observedAt),
            }),
          ];
        }

        try {
          const inspection = await inspectProvider({
            practiceId: state.practiceId,
            locationId: state.locationId,
            messagingProfileId: state.messagingProfileId,
            senderE164: state.senderE164,
            providerBrandId: state.providerBrandId,
            providerCampaignId: state.providerCampaignId,
            registrationStatus: state.registrationStatus ?? "not_started",
            senderRegistrationStatus:
              state.senderRegistrationStatus ?? "not_started",
            webhookUrl,
            registrationDisplayName: state.registrationDisplayName,
            registrationEntityType: state.registrationEntityType,
            registrationBusinessPhone: state.registrationBusinessPhone,
          });
          const blockers = [...inspection.blockers];
          if (inspection.profile && inspection.profile.enabled !== true) {
            blockers.push("messaging profile is disabled");
          }
          return classifyProviderReadinessResult(state, now, {
            blockers,
          });
        } catch {
          return classifyProviderReadinessResult(state, now, { failed: true });
        }
      }),
    );
    settled.push(...batchResults);
  }
  return settled.flat();
}

function addReason(
  target: Map<string, SmsOperationsHealth["reasons"][number]>,
  severity: SmsOperationsSeverity,
  category: SmsOperationsCategory,
  reason: string,
  count: number,
) {
  if (count <= 0) return;
  const key = `${severity}|${category}|${reason}`;
  const existing = target.get(key);
  target.set(key, {
    severity,
    category,
    reason,
    count: (existing?.count ?? 0) + count,
  });
}

export async function getSmsOperationsHealth(
  db: Database,
  options: SmsOperationsOptions = {},
): Promise<SmsOperationsHealth> {
  const now = options.now ?? new Date();
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const inspectProvider =
    options.inspectProvider ?? inspectTelnyxProviderReadiness;

  const queueLimit = limit + 1;
  const [states, sendQueue, deliveryQueue] = await Promise.all([
    loadMessagingStates(db),
    loadSmsSendAttemptQueue(db, {
      staleMinutes: SMS_OPERATIONS_THRESHOLDS.sendAttemptMinutes,
      limit: queueLimit,
      now,
    }),
    loadSmsDeliveryEventQueue(db, {
      staleMinutes: SMS_OPERATIONS_THRESHOLDS.deliveryReceiptMinutes,
      limit: queueLimit,
      now,
    }),
  ]);
  const sendRows = hydrateQueueNames(
    sendQueue.items.map((item) => ({
      practiceId: item.practiceId,
      locationId: item.locationId,
      practiceName: "",
      locationName: null,
      observedAt: item.createdAt,
      classification: item.classification,
    })),
    states,
  );
  const deliveryRows = hydrateQueueNames(
    deliveryQueue.items.map((item) => ({
      practiceId: item.practiceId,
      locationId: item.locationId,
      practiceName: "",
      locationName: null,
      observedAt: item.receivedAt,
      classification: item.queueReason,
    })),
    states,
  );
  const staleRows = hydrateQueueNames(
    deliveryQueue.staleAcceptedWithoutFinalDelivery.map((item) => ({
      practiceId: item.practiceId,
      locationId: item.locationId,
      practiceName: "",
      locationName: null,
      observedAt: item.receivedAt!,
      classification: item.queueReason,
    })),
    states,
  );
  // Provider GETs run only after the system transactions above have closed.
  const localIssues = classifySmsMessagingStates(states, now);
  const inspectedIssues = await providerIssues(states, now, inspectProvider);
  const stateIssues = [...localIssues, ...inspectedIssues];

  const sendItems = sendRows
    .slice(0, limit)
    .map((row) => queueIssue(row, now, "send_attempt"));
  const deliveryItems = deliveryRows
    .slice(0, limit)
    .map((row) => queueIssue(row, now, "delivery_event"));
  const staleItems = staleRows
    .slice(0, limit)
    .map((row) => queueIssue(row, now, "delivery_event"));
  const allItems = [
    ...stateIssues,
    ...sendItems,
    ...deliveryItems,
    ...staleItems,
  ].sort((left, right) => {
    if (left.severity !== right.severity)
      return left.severity === "p0" ? -1 : 1;
    const leftTime = left.observedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const rightTime = right.observedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return issueKey(left).localeCompare(issueKey(right));
  });

  const sendTotal = sendRows.length;
  const deliveryTotal = deliveryRows.length;
  const staleTotal = staleRows.length;
  const localCritical = stateIssues.filter(
    (item) => item.severity === "p0",
  ).length;
  const localAttention = stateIssues.filter(
    (item) => item.severity === "p1",
  ).length;
  const critical = localCritical;
  const attention = localAttention + sendTotal + deliveryTotal + staleTotal;
  const carrier = stateIssues.filter(
    (item) => item.category === "carrier",
  ).length;
  const profile = stateIssues.filter(
    (item) => item.category === "profile",
  ).length;
  const providerAuditFailures = stateIssues.filter(
    (item) => item.reasonCode === "provider_audit_failed",
  ).length;

  const reasons = new Map<string, SmsOperationsHealth["reasons"][number]>();
  for (const item of stateIssues) {
    addReason(reasons, item.severity, item.category, item.reasonCode, 1);
  }
  for (const item of sendRows) {
    addReason(reasons, "p1", "send_attempt", item.classification, 1);
  }
  for (const item of [...deliveryRows, ...staleRows]) {
    addReason(reasons, "p1", "delivery_event", item.classification, 1);
  }

  return {
    cacheControl: "no-store",
    generatedAt: now.toISOString(),
    status: critical > 0 ? "critical" : attention > 0 ? "attention" : "healthy",
    counts: {
      critical,
      attention,
      carrier,
      profile,
      sendAttempts: sendTotal,
      deliveryEvents: deliveryTotal,
      staleWithoutFinal: staleTotal,
      providerAuditFailures,
    },
    reasons: [...reasons.values()].sort((left, right) =>
      `${left.severity}|${left.category}|${left.reason}`.localeCompare(
        `${right.severity}|${right.category}|${right.reason}`,
      ),
    ),
    items: allItems
      .slice(0, limit)
      .map(
        ({ reasonCode: _reasonCode, observedAt: _observedAt, ...item }) => item,
      ),
    truncated:
      allItems.length > limit ||
      sendRows.length > limit ||
      deliveryRows.length > limit ||
      staleRows.length > limit,
    thresholds: SMS_OPERATIONS_THRESHOLDS,
  };
}
