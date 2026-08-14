import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  platformEmailIdentity,
  platformEmailPreferenceEvents,
  platformEmailPreferences,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import {
  emailPreferenceIdentityKeyFingerprint,
  emailPreferenceRecipientHash,
} from "@/lib/email-preferences";
import { withSystem } from "@/lib/tenant-db";

type PreferenceSource = "settings" | "unsubscribe_link";
type PreferenceReason =
  | "settings_enabled"
  | "settings_disabled"
  | "unsubscribe"
  | DeliverySuppressionReason;
export type DeliverySuppressionReason =
  | "complaint"
  | "bounce"
  | "provider_suppressed";

type CurrentPreference = {
  marketingEnabled: boolean;
  reason: PreferenceReason;
  identityKeyFingerprint: string;
};

const EMAIL_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_MAX_LENGTH = 512;
const REENABLE_REQUIRES_RECIPIENT_CONFIRMATION = new Set<PreferenceReason>([
  "unsubscribe",
  "complaint",
  "bounce",
  "provider_suppressed",
]);
const DELIVERY_SUPPRESSION_REASONS = new Set<DeliverySuppressionReason>([
  "complaint",
  "bounce",
  "provider_suppressed",
]);
const REASON_PRECEDENCE: Record<PreferenceReason, number> = {
  settings_enabled: 0,
  settings_disabled: 10,
  unsubscribe: 20,
  bounce: 100,
  provider_suppressed: 110,
  complaint: 120,
};

export class PlatformEmailIdentityKeyMismatchError extends Error {
  constructor() {
    super(
      "configured platform email identity key does not match persisted preferences",
    );
    this.name = "PlatformEmailIdentityKeyMismatchError";
  }
}

export class PlatformEmailPreferenceBlockedError extends Error {
  readonly code = "HARD_DELIVERY_SUPPRESSION";

  constructor() {
    super(
      "marketing email cannot be re-enabled without recipient confirmation after an unsubscribe or delivery suppression",
    );
    this.name = "PlatformEmailPreferenceBlockedError";
  }
}

export async function platformEmailIdentityConfigurationReady(): Promise<{
  ready: boolean;
  initialized: boolean;
}> {
  const identity = configuredIdentity();
  const [persisted] = await withSystem(db, (tx) =>
    tx
      .select({
        identityKeyFingerprint: platformEmailIdentity.identityKeyFingerprint,
      })
      .from(platformEmailIdentity)
      .where(eq(platformEmailIdentity.keySlot, 1))
      .limit(1),
  );
  if (!persisted) return { ready: true, initialized: false };
  return {
    ready: persisted.identityKeyFingerprint === identity.fingerprint,
    initialized: true,
  };
}

function configuredIdentity(): {
  emailHashFor: (email: string) => string;
  fingerprint: string;
} {
  const fingerprint = emailPreferenceIdentityKeyFingerprint();
  if (!fingerprint) {
    throw new Error("email preference identity key is not configured");
  }
  return {
    fingerprint,
    emailHashFor(email: string) {
      const hash = emailPreferenceRecipientHash(email);
      if (!hash) {
        throw new Error("email preference identity key is not configured");
      }
      return hash;
    },
  };
}

function validateEmailHash(emailHash: string): void {
  if (!EMAIL_HASH_PATTERN.test(emailHash)) {
    throw new Error("invalid email preference recipient hash");
  }
}

async function assertPersistedIdentityKey(
  tx: Database,
  fingerprint: string,
): Promise<void> {
  await tx
    .insert(platformEmailIdentity)
    .values({ keySlot: 1, identityKeyFingerprint: fingerprint })
    .onConflictDoNothing({ target: platformEmailIdentity.keySlot });

  const [persisted] = await tx
    .select({
      identityKeyFingerprint: platformEmailIdentity.identityKeyFingerprint,
    })
    .from(platformEmailIdentity)
    .where(eq(platformEmailIdentity.keySlot, 1))
    .limit(1);

  if (!persisted || persisted.identityKeyFingerprint !== fingerprint) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
}

async function lockRecipient(tx: Database, emailHash: string): Promise<void> {
  // Serialize projection/event decisions for one recipient without exposing the
  // address. The lock lasts only for this short database transaction.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${emailHash}, 0))`,
  );
}

async function currentPreference(
  tx: Database,
  emailHash: string,
  fingerprint: string,
): Promise<CurrentPreference | null> {
  const [current] = await tx
    .select({
      marketingEnabled: platformEmailPreferences.marketingEnabled,
      reason: platformEmailPreferences.reason,
      identityKeyFingerprint: platformEmailPreferences.identityKeyFingerprint,
    })
    .from(platformEmailPreferences)
    .where(eq(platformEmailPreferences.emailHash, emailHash))
    .limit(1);

  if (current && current.identityKeyFingerprint !== fingerprint) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  return (current as CurrentPreference | undefined) ?? null;
}

function preferenceReason(input: {
  enabled: boolean;
  source: PreferenceSource;
}): PreferenceReason {
  if (input.source === "unsubscribe_link") {
    if (input.enabled) {
      throw new Error("an unsubscribe link cannot enable marketing email");
    }
    return "unsubscribe";
  }
  return input.enabled ? "settings_enabled" : "settings_disabled";
}

function shouldApply(
  current: CurrentPreference | null,
  requestedEnabled: boolean,
  requestedReason: PreferenceReason,
): { applied: boolean; blocked: boolean } {
  if (!current) return { applied: true, blocked: false };

  if (requestedEnabled) {
    if (REENABLE_REQUIRES_RECIPIENT_CONFIRMATION.has(current.reason)) {
      return { applied: false, blocked: true };
    }
    return {
      applied: !current.marketingEnabled || current.reason !== requestedReason,
      blocked: false,
    };
  }

  return {
    applied:
      current.marketingEnabled ||
      REASON_PRECEDENCE[requestedReason] > REASON_PRECEDENCE[current.reason],
    blocked: false,
  };
}

async function updateProjection(
  tx: Database,
  input: {
    emailHash: string;
    fingerprint: string;
    enabled: boolean;
    source: "settings" | "unsubscribe_link" | "resend_webhook";
    reason: PreferenceReason;
    updatedByUserId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await tx
    .insert(platformEmailPreferences)
    .values({
      emailHash: input.emailHash,
      identityKeyFingerprint: input.fingerprint,
      marketingEnabled: input.enabled,
      source: input.source,
      reason: input.reason,
      updatedByUserId: input.updatedByUserId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformEmailPreferences.emailHash,
      set: {
        identityKeyFingerprint: input.fingerprint,
        marketingEnabled: input.enabled,
        source: input.source,
        reason: input.reason,
        updatedByUserId: input.updatedByUserId ?? null,
        updatedAt: now,
        deletedAt: null,
      },
    });
}

export async function marketingEmailEnabledForRecipient(
  email: string,
): Promise<boolean> {
  return withSystem(db, (tx) => lockAndCheckMarketingEmailEnabled(tx, email));
}

/**
 * Serialize a marketing send with preference changes for this recipient and
 * re-read the current preference in the caller's provider-call transaction.
 * The lock order is practice row first, then recipient advisory lock.
 */
export async function lockAndCheckMarketingEmailEnabled(
  tx: Database,
  email: string,
): Promise<boolean> {
  const identity = configuredIdentity();
  const emailHash = identity.emailHashFor(email);
  await assertPersistedIdentityKey(tx, identity.fingerprint);
  await lockRecipient(tx, emailHash);
  const preference = await currentPreference(
    tx,
    emailHash,
    identity.fingerprint,
  );
  return preference?.marketingEnabled !== false;
}

export async function setMarketingEmailPreferenceForRecipient(input: {
  email: string;
  enabled: boolean;
  source: PreferenceSource;
  updatedByUserId?: string | null;
}): Promise<void> {
  const identity = configuredIdentity();
  await setMarketingEmailPreferenceForHash({
    emailHash: identity.emailHashFor(input.email),
    enabled: input.enabled,
    source: input.source,
    updatedByUserId: input.updatedByUserId,
  });
}

export async function setMarketingEmailPreferenceForHash(input: {
  emailHash: string;
  enabled: boolean;
  source: PreferenceSource;
  updatedByUserId?: string | null;
}): Promise<void> {
  validateEmailHash(input.emailHash);
  const identity = configuredIdentity();
  const reason = preferenceReason(input);

  const outcome = await withSystem(db, async (tx) => {
    await assertPersistedIdentityKey(tx, identity.fingerprint);
    await lockRecipient(tx, input.emailHash);
    const current = await currentPreference(
      tx,
      input.emailHash,
      identity.fingerprint,
    );
    const decision = shouldApply(current, input.enabled, reason);

    // A no-op request is intentionally replayable. Once the same or a stronger
    // state is current, acknowledge it without growing the immutable ledger.
    // Blocked re-enable attempts remain auditable. The recipient advisory lock
    // makes this race-safe while still allowing every later state transition to
    // append fresh evidence.
    if (!decision.applied && !decision.blocked) {
      return decision;
    }

    await tx.insert(platformEmailPreferenceEvents).values({
      emailHash: input.emailHash,
      identityKeyFingerprint: identity.fingerprint,
      requestedMarketingEnabled: input.enabled,
      applied: decision.applied,
      source: input.source,
      reason,
      updatedByUserId: input.updatedByUserId ?? null,
    });

    if (decision.applied) {
      await updateProjection(tx, {
        emailHash: input.emailHash,
        fingerprint: identity.fingerprint,
        enabled: input.enabled,
        source: input.source,
        reason,
        updatedByUserId: input.updatedByUserId,
      });
    }
    return decision;
  });

  // Throw only after the audit event commits so the settings caller can
  // explain that this recipient address cannot be re-enabled there.
  if (outcome.blocked) throw new PlatformEmailPreferenceBlockedError();
}

function validatedProviderId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > PROVIDER_ID_MAX_LENGTH) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

export async function recordPlatformEmailDeliverySuppression(input: {
  email: string;
  reason: DeliverySuppressionReason;
  providerMessageId: string;
  webhookId: string;
}): Promise<{ applied: boolean; duplicate: boolean }> {
  if (!DELIVERY_SUPPRESSION_REASONS.has(input.reason)) {
    throw new Error("invalid platform email delivery suppression reason");
  }

  const identity = configuredIdentity();
  const emailHash = identity.emailHashFor(input.email);
  const providerMessageId = validatedProviderId(
    input.providerMessageId,
    "provider message id",
  );
  const webhookId = validatedProviderId(input.webhookId, "webhook id");
  const providerEventKeyHash = createHash("sha256")
    .update(
      `openvpm-platform-email-provider-event:${webhookId}:${providerMessageId}:${input.reason}:${emailHash}`,
    )
    .digest("hex");

  return withSystem(db, async (tx) => {
    await assertPersistedIdentityKey(tx, identity.fingerprint);
    await lockRecipient(tx, emailHash);
    const current = await currentPreference(
      tx,
      emailHash,
      identity.fingerprint,
    );
    const decision = shouldApply(current, false, input.reason);

    const inserted = await tx
      .insert(platformEmailPreferenceEvents)
      .values({
        emailHash,
        identityKeyFingerprint: identity.fingerprint,
        requestedMarketingEnabled: false,
        applied: decision.applied,
        source: "resend_webhook",
        reason: input.reason,
        updatedByUserId: null,
        providerEventKeyHash,
      })
      .onConflictDoNothing({
        target: platformEmailPreferenceEvents.providerEventKeyHash,
      })
      .returning({ id: platformEmailPreferenceEvents.id });

    if (inserted.length === 0) {
      return { applied: false, duplicate: true };
    }
    if (decision.applied) {
      await updateProjection(tx, {
        emailHash,
        fingerprint: identity.fingerprint,
        enabled: false,
        source: "resend_webhook",
        reason: input.reason,
      });
    }
    return { applied: decision.applied, duplicate: false };
  });
}
