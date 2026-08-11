import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { cronHeartbeatConfigured } from "@/lib/cron-heartbeat";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import { loadSmsProviderEventGateSummaryInTransaction } from "./sms-provider-event-operations";
import { hostedSmsConfigurationDiagnostics } from "./hosted-sms-readiness";

const PROVISIONING_PRACTICE_IDS_ENV = "MESSAGING_PROVISIONING_PRACTICE_IDS";
const SENDING_PRACTICE_IDS_ENV = "MESSAGING_SENDING_PRACTICE_IDS";
const SENDING_LOCATION_IDS_ENV = "MESSAGING_SENDING_LOCATION_IDS";
const PILOT_HEARTBEAT_JOBS = ["sms-provider-events", "sms-operations"] as const;

export type HostedSmsPilotStage =
  | "deferred"
  | "blocked"
  | "provisioning_prepared"
  | "scope_prepared"
  | "inbound_prepared"
  | "provider_ready"
  | "active";

export type HostedSmsPilotBlocker =
  | "provider_not_telnyx"
  | "credential_shape_invalid"
  | "provisioning_scope_invalid"
  | "sending_scope_invalid"
  | "scope_mismatch"
  | "inbound_disabled_while_sending"
  | "pilot_practice_unavailable"
  | "practice_recovery_hold"
  | "carrier_identity_not_ready"
  | "provider_event_backlog"
  | "heartbeat_not_configured"
  | "provider_profile_not_ready"
  | "readiness_check_failed";

export interface HostedSmsPilotActivationPreflight {
  generatedAt: string;
  stage: HostedSmsPilotStage;
  ok: boolean;
  detail: string;
  nextAction: string;
  blockers: HostedSmsPilotBlocker[];
  configuration: ReturnType<typeof hostedSmsConfigurationDiagnostics>;
  checks: {
    credentialsValid: boolean;
    provisioningScopeExact: boolean | null;
    sendingScopeExact: boolean | null;
    scopesMatch: boolean | null;
    practiceActive: boolean | null;
    recoveryClear: boolean | null;
    carrierIdentityReady: boolean | null;
    providerProfileReady: boolean | null;
    providerEventsClear: boolean | null;
    heartbeatDeliveryConfigured: boolean;
  };
  providerEventBlocking: number | null;
  readyForInboundEnable: boolean;
  readyForProviderActivation: boolean;
  readyForSendingEnable: boolean;
}

interface PilotScopeRow {
  practiceActive: boolean;
  recoveryClear: boolean;
  carrierIdentityReady: boolean;
  providerProfileReady: boolean;
  clinicSenderEnabled: boolean;
}

function commaSeparatedValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function exactUuidScope(values: string[]): boolean {
  return values.length === 1 && isUuid(values[0]!);
}

function uniqueBlockers(
  values: readonly HostedSmsPilotBlocker[],
): HostedSmsPilotBlocker[] {
  return [...new Set(values)];
}

function nextActionForBlocker(blocker: HostedSmsPilotBlocker): string {
  switch (blocker) {
    case "provider_not_telnyx":
      return "Select Telnyx as the hosted messaging provider.";
    case "credential_shape_invalid":
      return "Fix the secret-safe Telnyx credential checks before staging a clinic.";
    case "provisioning_scope_invalid":
      return "Stage exactly one approved provisioning practice UUID.";
    case "sending_scope_invalid":
      return "Stage exactly one sending practice and its exact location while sending remains off.";
    case "scope_mismatch":
      return "Make the provisioning and sending practice scopes name the same clinic.";
    case "inbound_disabled_while_sending":
      return "Turn sending off until the inbound gate and provider profile are ready.";
    case "pilot_practice_unavailable":
      return "Select one active, non-deleted pilot practice.";
    case "practice_recovery_hold":
      return "Finish or safely release the clinic recovery hold before SMS activation.";
    case "carrier_identity_not_ready":
      return "Reconcile the exact Telnyx registration, campaign assignment, sender number, and messaging profile.";
    case "provider_event_backlog":
      return "Project or reconcile every blocking provider event before activation.";
    case "heartbeat_not_configured":
      return "Configure both SMS heartbeat destinations, then verify fresh receipts in the external monitor.";
    case "provider_profile_not_ready":
      return "Keep sending off and enable/read back the exact provider profile first.";
    case "readiness_check_failed":
      return "Retry the read-only preflight and investigate database readiness if it fails again.";
  }
}

function blockedPreflight(
  base: Omit<
    HostedSmsPilotActivationPreflight,
    | "stage"
    | "ok"
    | "detail"
    | "nextAction"
    | "readyForInboundEnable"
    | "readyForProviderActivation"
    | "readyForSendingEnable"
  >,
): HostedSmsPilotActivationPreflight {
  const blockers = uniqueBlockers(base.blockers);
  const first = blockers[0] ?? "readiness_check_failed";
  return {
    ...base,
    blockers,
    stage: "blocked",
    ok: false,
    detail: `${blockers.length} hosted SMS pilot readiness ${
      blockers.length === 1 ? "issue" : "issues"
    } detected`,
    nextAction: nextActionForBlocker(first),
    readyForInboundEnable: false,
    readyForProviderActivation: false,
    readyForSendingEnable: false,
  };
}

export function hostedSmsRolloutIntended(): boolean {
  return hostedSmsConfigurationDiagnostics().rolloutIntended;
}

/**
 * Secret- and PHI-free hosted SMS activation preflight. This performs no
 * provider I/O and no mutation. The exact configured UUIDs are used only as
 * bounded internal lookup keys and are never returned to the caller.
 */
export async function loadHostedSmsPilotActivationPreflight(
  database: Database = db,
  now: Date = new Date(),
): Promise<HostedSmsPilotActivationPreflight> {
  const configuration = hostedSmsConfigurationDiagnostics();
  const provisioningPracticeIds = commaSeparatedValues(
    PROVISIONING_PRACTICE_IDS_ENV,
  );
  const sendingPracticeIds = commaSeparatedValues(SENDING_PRACTICE_IDS_ENV);
  const sendingLocationIds = commaSeparatedValues(SENDING_LOCATION_IDS_ENV);
  const sendingSignal =
    configuration.sendingEnabled ||
    configuration.inboundEnabled ||
    sendingPracticeIds.length > 0 ||
    sendingLocationIds.length > 0;
  const provisioningSignal =
    configuration.provisioningEnabled ||
    provisioningPracticeIds.length > 0 ||
    sendingSignal;
  const credentialsValid =
    configuration.apiKeyShapeValid &&
    configuration.webhookPublicKeyShapeValid &&
    configuration.registrationEncryptionKeyShapeValid;
  const provisioningScopeExact = provisioningSignal
    ? exactUuidScope(provisioningPracticeIds)
    : null;
  const sendingScopeExact = sendingSignal
    ? exactUuidScope(sendingPracticeIds) && exactUuidScope(sendingLocationIds)
    : null;
  const scopesMatch =
    provisioningScopeExact === true && sendingScopeExact === true
      ? provisioningPracticeIds[0] === sendingPracticeIds[0]
      : null;
  const heartbeat = cronHeartbeatConfigured(PILOT_HEARTBEAT_JOBS);
  const checks: HostedSmsPilotActivationPreflight["checks"] = {
    credentialsValid,
    provisioningScopeExact,
    sendingScopeExact,
    scopesMatch,
    practiceActive: null,
    recoveryClear: null,
    carrierIdentityReady: null,
    providerProfileReady: null,
    providerEventsClear: null,
    heartbeatDeliveryConfigured: heartbeat.ok,
  };
  const base: Parameters<typeof blockedPreflight>[0] = {
    generatedAt: now.toISOString(),
    configuration,
    checks,
    providerEventBlocking: null,
    blockers: [] as HostedSmsPilotBlocker[],
  };

  if (!configuration.rolloutIntended) {
    return {
      ...base,
      stage: "deferred",
      ok: true,
      detail: "Hosted SMS pilot is safely deferred",
      nextAction:
        "Fix any credential-shape issue, then stage one approved provisioning practice with all launch flags off.",
      readyForInboundEnable: false,
      readyForProviderActivation: false,
      readyForSendingEnable: false,
    };
  }

  if (!configuration.providerIsTelnyx) {
    base.blockers.push("provider_not_telnyx");
  }
  if (!credentialsValid) base.blockers.push("credential_shape_invalid");
  if (provisioningScopeExact !== true) {
    base.blockers.push("provisioning_scope_invalid");
  }
  if (sendingSignal && sendingScopeExact !== true) {
    base.blockers.push("sending_scope_invalid");
  }
  if (scopesMatch === false) base.blockers.push("scope_mismatch");
  if (configuration.sendingEnabled && !configuration.inboundEnabled) {
    base.blockers.push("inbound_disabled_while_sending");
  }
  if (base.blockers.length > 0) return blockedPreflight(base);

  const practiceId = provisioningPracticeIds[0]!;
  const locationId = sendingSignal ? sendingLocationIds[0]! : null;

  try {
    const result = await withSystem(database, async (tx) => {
      const scopeResult = await tx.execute(sql`
        select
          exists (
            select 1
            from practices practice
            where practice.id = ${practiceId}::uuid
              and practice.deleted_at is null
          ) as "practiceActive",
          exists (
            select 1
            from practices practice
            where practice.id = ${practiceId}::uuid
              and practice.deleted_at is null
              and practice.recovery_hold = false
          ) as "recoveryClear",
          ${
            locationId
              ? sql`exists (
                  select 1
                  from locations location
                  join location_messaging sender
                    on sender.practice_id = location.practice_id
                    and sender.location_id = location.id
                    and sender.deleted_at is null
                  join messaging_registrations registration
                    on registration.practice_id = location.practice_id
                    and registration.deleted_at is null
                  where location.id = ${locationId}::uuid
                    and location.practice_id = ${practiceId}::uuid
                    and location.deleted_at is null
                    and sender.provider = 'telnyx'
                    and sender.registration_status = 'active'
                    and nullif(btrim(sender.sender_e164), '') is not null
                    and nullif(btrim(sender.messaging_profile_id), '') is not null
                    and registration.provider = 'telnyx'
                    and registration.status = 'active'
                    and sender.a2p_brand_id = registration.provider_brand_id
                    and sender.a2p_campaign_id = registration.provider_campaign_id
                )`
              : sql`false`
          } as "carrierIdentityReady",
          ${
            locationId
              ? sql`exists (
                  select 1
                  from location_messaging sender
                  where sender.practice_id = ${practiceId}::uuid
                    and sender.location_id = ${locationId}::uuid
                    and sender.deleted_at is null
                    and sender.provider = 'telnyx'
                    and sender.provider_profile_ready = true
                    and sender.provider_profile_synced_at is not null
                )`
              : sql`false`
          } as "providerProfileReady",
          ${
            locationId
              ? sql`exists (
                  select 1
                  from location_messaging sender
                  where sender.practice_id = ${practiceId}::uuid
                    and sender.location_id = ${locationId}::uuid
                    and sender.deleted_at is null
                    and sender.enabled = true
                )`
              : sql`false`
          } as "clinicSenderEnabled"
      `);
      const scope = rowsFromExecute<PilotScopeRow>(scopeResult)[0];
      if (!scope?.practiceActive) {
        return { scope: null, providerEventBlocking: null };
      }
      const gate = await loadSmsProviderEventGateSummaryInTransaction(tx, {
        practiceId,
        ...(locationId ? { locationId } : {}),
      });
      return { scope, providerEventBlocking: gate.total };
    });

    checks.practiceActive = result.scope?.practiceActive ?? false;
    checks.recoveryClear = result.scope?.recoveryClear ?? false;
    checks.carrierIdentityReady = locationId
      ? (result.scope?.carrierIdentityReady ?? false)
      : null;
    checks.providerProfileReady = locationId
      ? (result.scope?.providerProfileReady ?? false)
      : null;
    checks.providerEventsClear =
      result.providerEventBlocking === null
        ? null
        : result.providerEventBlocking === 0;
    base.providerEventBlocking = result.providerEventBlocking;

    if (!checks.practiceActive)
      base.blockers.push("pilot_practice_unavailable");
    if (checks.practiceActive && !checks.recoveryClear) {
      base.blockers.push("practice_recovery_hold");
    }
    if (locationId && !checks.carrierIdentityReady) {
      base.blockers.push("carrier_identity_not_ready");
    }
    if (checks.providerEventsClear === false) {
      base.blockers.push("provider_event_backlog");
    }
    if (!checks.heartbeatDeliveryConfigured) {
      base.blockers.push("heartbeat_not_configured");
    }
    if (configuration.sendingEnabled && checks.providerProfileReady !== true) {
      base.blockers.push("provider_profile_not_ready");
    }
    if (base.blockers.length > 0) return blockedPreflight(base);

    if (!locationId) {
      return {
        ...base,
        stage: "provisioning_prepared",
        ok: true,
        detail: "Hosted SMS provisioning scope prepared; sending remains off",
        nextAction:
          "Complete carrier registration, then stage the exact sending practice and location with sending off.",
        readyForInboundEnable: false,
        readyForProviderActivation: false,
        readyForSendingEnable: false,
      };
    }

    if (configuration.sendingEnabled) {
      return {
        ...base,
        stage: "active",
        ok: true,
        detail: "Hosted SMS pilot configuration active",
        nextAction: result.scope?.clinicSenderEnabled
          ? "Run and record the consented live SMS validation drill."
          : "Have the clinic admin enable the exact approved sender, then run the live validation drill.",
        readyForInboundEnable: false,
        readyForProviderActivation: false,
        readyForSendingEnable: false,
      };
    }

    if (!configuration.inboundEnabled) {
      return {
        ...base,
        stage: "scope_prepared",
        ok: true,
        detail:
          "Hosted SMS pilot scope prepared; inbound and sending remain off",
        nextAction:
          "Verify fresh provider-event and SMS-operations heartbeat receipts, then enable inbound projection while sending stays off.",
        readyForInboundEnable: true,
        readyForProviderActivation: false,
        readyForSendingEnable: false,
      };
    }

    if (checks.providerProfileReady !== true) {
      return {
        ...base,
        stage: "inbound_prepared",
        ok: true,
        detail: "Hosted SMS inbound projection prepared; sending remains off",
        nextAction:
          "Enable and read back the exact provider profile in the platform-admin queue.",
        readyForInboundEnable: false,
        readyForProviderActivation: true,
        readyForSendingEnable: false,
      };
    }

    return {
      ...base,
      stage: "provider_ready",
      ok: true,
      detail: "Hosted SMS provider profile ready; sending remains off",
      nextAction:
        "Enable the exact sending allowlist flag, redeploy, and confirm health before clinic enablement.",
      readyForInboundEnable: false,
      readyForProviderActivation: false,
      readyForSendingEnable: true,
    };
  } catch {
    base.blockers.push("readiness_check_failed");
    return blockedPreflight(base);
  }
}
