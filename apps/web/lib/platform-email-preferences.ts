import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import {
  platformEmailIdentity,
  platformEmailIdentityAliases,
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
type StoredPreferenceSource = PreferenceSource | "resend_webhook";
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
  source: StoredPreferenceSource;
  reason: PreferenceReason;
  identityKeyFingerprint: string;
  updatedByUserId: string | null;
};

type IdentityKey = {
  fingerprint: string;
  emailHashFor: (email: string) => string;
};

type IdentityRing = {
  current: IdentityKey;
  previous: IdentityKey | null;
};

type KeyedRecipientHash = {
  fingerprint: string;
  emailHash: string;
};

type PersistedIdentity = {
  identityKeyFingerprint: string;
  previousIdentityKeyFingerprint: string | null;
};

type IdentityAlias = {
  currentIdentityKeyFingerprint: string;
  currentEmailHash: string;
  previousIdentityKeyFingerprint: string;
  previousEmailHash: string;
};

type RecipientState = {
  key: KeyedRecipientHash;
  preference: CurrentPreference | null;
};

const EMAIL_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_MAX_LENGTH = 512;
const ROTATION_LOCK_NAME = "openvpm-platform-email-identity-rotation";
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
      "configured platform email identity key ring does not match persisted preferences",
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

function configuredIdentityKey(secret: string | undefined): IdentityKey {
  const fingerprint = emailPreferenceIdentityKeyFingerprint({
    identitySecret: secret,
  });
  if (!fingerprint) {
    throw new Error("email preference identity key is not configured");
  }
  return {
    fingerprint,
    emailHashFor(email: string) {
      const hash = emailPreferenceRecipientHash(email, {
        identitySecret: secret,
      });
      if (!hash) {
        throw new Error("email preference identity key is not configured");
      }
      return hash;
    },
  };
}

function configuredIdentityRing(): IdentityRing {
  const current = configuredIdentityKey(
    process.env.EMAIL_PREFERENCE_IDENTITY_SECRET,
  );
  const previousSecret = process.env.EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS;
  const previous = previousSecret?.trim()
    ? configuredIdentityKey(previousSecret)
    : null;
  if (previous?.fingerprint === current.fingerprint) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  return { current, previous };
}

function validateEmailHash(emailHash: string): void {
  if (!EMAIL_HASH_PATTERN.test(emailHash)) {
    throw new Error("invalid email preference recipient hash");
  }
}

function persistedIdentityMatches(
  persisted: PersistedIdentity,
  ring: IdentityRing,
): boolean {
  return (
    persisted.identityKeyFingerprint === ring.current.fingerprint &&
    persisted.previousIdentityKeyFingerprint ===
      (ring.previous?.fingerprint ?? null)
  );
}

async function loadPersistedIdentity(
  tx: Database,
): Promise<PersistedIdentity | null> {
  const [persisted] = await tx
    .select({
      identityKeyFingerprint: platformEmailIdentity.identityKeyFingerprint,
      previousIdentityKeyFingerprint:
        platformEmailIdentity.previousIdentityKeyFingerprint,
    })
    .from(platformEmailIdentity)
    .where(eq(platformEmailIdentity.keySlot, 1))
    .limit(1);
  return (persisted as PersistedIdentity | undefined) ?? null;
}

async function lockRotationShared(tx: Database): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${ROTATION_LOCK_NAME}, 0))`,
  );
}

async function validatedIdentityRingInTransaction(
  tx: Database,
): Promise<IdentityRing> {
  const ring = configuredIdentityRing();
  // Every preference operation takes this shared transaction lock before it
  // reads the registry. The one-off rotation transaction takes the matching
  // exclusive lock, so it cannot race an old-key write. Shared holders remain
  // concurrent with each other.
  await lockRotationShared(tx);
  if (!ring.previous) {
    await tx
      .insert(platformEmailIdentity)
      .values({
        keySlot: 1,
        identityKeyFingerprint: ring.current.fingerprint,
        previousIdentityKeyFingerprint: null,
        rotationStartedAt: null,
      })
      .onConflictDoNothing({ target: platformEmailIdentity.keySlot });
  }

  const persisted = await loadPersistedIdentity(tx);
  if (!persisted || !persistedIdentityMatches(persisted, ring)) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  return ring;
}

export async function platformEmailIdentityConfigurationReady(): Promise<{
  ready: boolean;
  initialized: boolean;
}> {
  const ring = configuredIdentityRing();
  const persisted = await withSystem(db, (tx) => loadPersistedIdentity(tx));
  if (!persisted) {
    return { ready: ring.previous === null, initialized: false };
  }
  return {
    ready: persistedIdentityMatches(persisted, ring),
    initialized: true,
  };
}

async function lockRecipientHashes(
  tx: Database,
  hashes: string[],
): Promise<void> {
  for (const emailHash of [...new Set(hashes)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${emailHash}, 0))`,
    );
  }
}

async function currentPreference(
  tx: Database,
  key: KeyedRecipientHash,
): Promise<CurrentPreference | null> {
  const [current] = await tx
    .select({
      marketingEnabled: platformEmailPreferences.marketingEnabled,
      source: platformEmailPreferences.source,
      reason: platformEmailPreferences.reason,
      identityKeyFingerprint: platformEmailPreferences.identityKeyFingerprint,
      updatedByUserId: platformEmailPreferences.updatedByUserId,
    })
    .from(platformEmailPreferences)
    .where(eq(platformEmailPreferences.emailHash, key.emailHash))
    .limit(1);

  if (current && current.identityKeyFingerprint !== key.fingerprint) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  return (current as CurrentPreference | undefined) ?? null;
}

function strongestPreference(
  preferences: Array<CurrentPreference | null>,
): CurrentPreference | null {
  return preferences.reduce<CurrentPreference | null>(
    (strongest, candidate) => {
      if (!candidate) return strongest;
      if (!strongest) return candidate;
      return REASON_PRECEDENCE[candidate.reason] >
        REASON_PRECEDENCE[strongest.reason]
        ? candidate
        : strongest;
    },
    null,
  );
}

async function updateProjection(
  tx: Database,
  input: {
    key: KeyedRecipientHash;
    enabled: boolean;
    source: StoredPreferenceSource;
    reason: PreferenceReason;
    updatedByUserId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await tx
    .insert(platformEmailPreferences)
    .values({
      emailHash: input.key.emailHash,
      identityKeyFingerprint: input.key.fingerprint,
      marketingEnabled: input.enabled,
      source: input.source,
      reason: input.reason,
      updatedByUserId: input.updatedByUserId ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: platformEmailPreferences.emailHash,
      set: {
        identityKeyFingerprint: input.key.fingerprint,
        marketingEnabled: input.enabled,
        source: input.source,
        reason: input.reason,
        updatedByUserId: input.updatedByUserId ?? null,
        updatedAt: now,
        deletedAt: null,
      },
    });
}

async function convergeRecipientState(
  tx: Database,
  states: RecipientState[],
  strongest: CurrentPreference | null,
): Promise<void> {
  if (!strongest) return;
  for (const state of states) {
    if (
      state.preference?.marketingEnabled === strongest.marketingEnabled &&
      state.preference.reason === strongest.reason
    ) {
      continue;
    }
    await updateProjection(tx, {
      key: state.key,
      enabled: strongest.marketingEnabled,
      source: strongest.source,
      reason: strongest.reason,
      updatedByUserId: strongest.updatedByUserId,
    });
  }
}

async function deriveAndValidateAlias(
  tx: Database,
  current: KeyedRecipientHash,
  previous: KeyedRecipientHash,
): Promise<IdentityAlias> {
  await tx
    .insert(platformEmailIdentityAliases)
    .values({
      currentIdentityKeyFingerprint: current.fingerprint,
      currentEmailHash: current.emailHash,
      previousIdentityKeyFingerprint: previous.fingerprint,
      previousEmailHash: previous.emailHash,
    })
    .onConflictDoNothing({
      target: [
        platformEmailIdentityAliases.currentIdentityKeyFingerprint,
        platformEmailIdentityAliases.currentEmailHash,
      ],
    });

  const [alias] = await tx
    .select({
      currentIdentityKeyFingerprint:
        platformEmailIdentityAliases.currentIdentityKeyFingerprint,
      currentEmailHash: platformEmailIdentityAliases.currentEmailHash,
      previousIdentityKeyFingerprint:
        platformEmailIdentityAliases.previousIdentityKeyFingerprint,
      previousEmailHash: platformEmailIdentityAliases.previousEmailHash,
    })
    .from(platformEmailIdentityAliases)
    .where(
      and(
        eq(
          platformEmailIdentityAliases.currentIdentityKeyFingerprint,
          current.fingerprint,
        ),
        eq(platformEmailIdentityAliases.currentEmailHash, current.emailHash),
      ),
    )
    .limit(1);
  if (
    !alias ||
    alias.previousIdentityKeyFingerprint !== previous.fingerprint ||
    alias.previousEmailHash !== previous.emailHash
  ) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  return alias as IdentityAlias;
}

async function loadAliasForHash(
  tx: Database,
  key: KeyedRecipientHash,
): Promise<IdentityAlias | null> {
  const [alias] = await tx
    .select({
      currentIdentityKeyFingerprint:
        platformEmailIdentityAliases.currentIdentityKeyFingerprint,
      currentEmailHash: platformEmailIdentityAliases.currentEmailHash,
      previousIdentityKeyFingerprint:
        platformEmailIdentityAliases.previousIdentityKeyFingerprint,
      previousEmailHash: platformEmailIdentityAliases.previousEmailHash,
    })
    .from(platformEmailIdentityAliases)
    .where(
      or(
        and(
          eq(
            platformEmailIdentityAliases.currentIdentityKeyFingerprint,
            key.fingerprint,
          ),
          eq(platformEmailIdentityAliases.currentEmailHash, key.emailHash),
        ),
        and(
          eq(
            platformEmailIdentityAliases.previousIdentityKeyFingerprint,
            key.fingerprint,
          ),
          eq(platformEmailIdentityAliases.previousEmailHash, key.emailHash),
        ),
      ),
    )
    .limit(1);
  return (alias as IdentityAlias | undefined) ?? null;
}

function keyedHashesForEmail(ring: IdentityRing, email: string) {
  const current = {
    fingerprint: ring.current.fingerprint,
    emailHash: ring.current.emailHashFor(email),
  };
  const previous = ring.previous
    ? {
        fingerprint: ring.previous.fingerprint,
        emailHash: ring.previous.emailHashFor(email),
      }
    : null;
  return { current, previous };
}

async function loadRecipientStates(
  tx: Database,
  keys: KeyedRecipientHash[],
): Promise<{
  states: RecipientState[];
  strongest: CurrentPreference | null;
}> {
  const states: RecipientState[] = [];
  for (const key of keys) {
    states.push({ key, preference: await currentPreference(tx, key) });
  }
  const strongest = strongestPreference(
    states.map((state) => state.preference),
  );
  await convergeRecipientState(tx, states, strongest);
  return { states, strongest };
}

async function preparePlaintextRecipient(
  tx: Database,
  email: string,
): Promise<{
  keys: KeyedRecipientHash[];
  strongest: CurrentPreference | null;
}> {
  const ring = await validatedIdentityRingInTransaction(tx);
  const { current, previous } = keyedHashesForEmail(ring, email);
  const keys = previous ? [current, previous] : [current];
  await lockRecipientHashes(
    tx,
    keys.map((key) => key.emailHash),
  );
  if (previous) {
    await deriveAndValidateAlias(tx, current, previous);
  }
  const { strongest } = await loadRecipientStates(tx, keys);
  return { keys, strongest };
}

async function prepareHashedRecipient(
  tx: Database,
  input: { emailHash: string; identityKeyFingerprint: string },
): Promise<{
  keys: KeyedRecipientHash[];
  strongest: CurrentPreference | null;
}> {
  const ring = await validatedIdentityRingInTransaction(tx);
  const matchingKey = [ring.current, ring.previous]
    .filter((key): key is IdentityKey => Boolean(key))
    .find((key) => key.fingerprint === input.identityKeyFingerprint);
  if (!matchingKey) throw new PlatformEmailIdentityKeyMismatchError();

  const requested = {
    fingerprint: matchingKey.fingerprint,
    emailHash: input.emailHash,
  };
  const alias = ring.previous ? await loadAliasForHash(tx, requested) : null;
  const keys = alias
    ? [
        {
          fingerprint: alias.currentIdentityKeyFingerprint,
          emailHash: alias.currentEmailHash,
        },
        {
          fingerprint: alias.previousIdentityKeyFingerprint,
          emailHash: alias.previousEmailHash,
        },
      ]
    : [requested];
  if (
    alias &&
    (alias.currentIdentityKeyFingerprint !== ring.current.fingerprint ||
      alias.previousIdentityKeyFingerprint !== ring.previous?.fingerprint)
  ) {
    throw new PlatformEmailIdentityKeyMismatchError();
  }
  await lockRecipientHashes(
    tx,
    keys.map((key) => key.emailHash),
  );
  const { strongest } = await loadRecipientStates(tx, keys);
  return { keys, strongest };
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

function appendPreferenceEvent(
  tx: Database,
  input: {
    key: KeyedRecipientHash;
    requestedMarketingEnabled: boolean;
    applied: boolean;
    source: StoredPreferenceSource;
    reason: PreferenceReason;
    updatedByUserId?: string | null;
    providerEventKeyHash?: string;
  },
) {
  return tx.insert(platformEmailPreferenceEvents).values({
    emailHash: input.key.emailHash,
    identityKeyFingerprint: input.key.fingerprint,
    requestedMarketingEnabled: input.requestedMarketingEnabled,
    applied: input.applied,
    source: input.source,
    reason: input.reason,
    updatedByUserId: input.updatedByUserId ?? null,
    providerEventKeyHash: input.providerEventKeyHash,
  });
}

async function applyPreferenceToKeys(
  tx: Database,
  keys: KeyedRecipientHash[],
  input: {
    enabled: boolean;
    source: StoredPreferenceSource;
    reason: PreferenceReason;
    updatedByUserId?: string | null;
  },
): Promise<void> {
  for (const key of keys) {
    await updateProjection(tx, { key, ...input });
  }
}

export async function marketingEmailEnabledForRecipient(
  email: string,
): Promise<boolean> {
  return withSystem(db, (tx) => lockAndCheckMarketingEmailEnabled(tx, email));
}

/**
 * Serialize a marketing send with preference changes for this recipient and
 * re-read the strongest current/previous-key preference in the provider-call
 * transaction. The lock order is rotation lock, then sorted recipient hashes.
 */
export async function lockAndCheckMarketingEmailEnabled(
  tx: Database,
  email: string,
): Promise<boolean> {
  const { strongest } = await preparePlaintextRecipient(tx, email);
  return strongest?.marketingEnabled !== false;
}

export async function setMarketingEmailPreferenceForRecipient(input: {
  email: string;
  enabled: boolean;
  source: PreferenceSource;
  updatedByUserId?: string | null;
}): Promise<void> {
  const reason = preferenceReason(input);
  const outcome = await withSystem(db, async (tx) => {
    const { keys, strongest } = await preparePlaintextRecipient(
      tx,
      input.email,
    );
    const decision = shouldApply(strongest, input.enabled, reason);
    if (!decision.applied && !decision.blocked) return decision;

    await appendPreferenceEvent(tx, {
      key: keys[0]!,
      requestedMarketingEnabled: input.enabled,
      applied: decision.applied,
      source: input.source,
      reason,
      updatedByUserId: input.updatedByUserId,
    });
    if (decision.applied) {
      await applyPreferenceToKeys(tx, keys, {
        enabled: input.enabled,
        source: input.source,
        reason,
        updatedByUserId: input.updatedByUserId,
      });
    }
    return decision;
  });
  if (outcome.blocked) throw new PlatformEmailPreferenceBlockedError();
}

export async function setMarketingEmailPreferenceForHash(input: {
  emailHash: string;
  identityKeyFingerprint: string;
  enabled: boolean;
  source: PreferenceSource;
  updatedByUserId?: string | null;
}): Promise<void> {
  validateEmailHash(input.emailHash);
  validateEmailHash(input.identityKeyFingerprint);
  const reason = preferenceReason(input);

  const outcome = await withSystem(db, async (tx) => {
    const { keys, strongest } = await prepareHashedRecipient(tx, input);
    const decision = shouldApply(strongest, input.enabled, reason);
    if (!decision.applied && !decision.blocked) return decision;

    const eventKey =
      keys.find(
        (key) =>
          key.emailHash === input.emailHash &&
          key.fingerprint === input.identityKeyFingerprint,
      ) ?? keys[0]!;
    await appendPreferenceEvent(tx, {
      key: eventKey,
      requestedMarketingEnabled: input.enabled,
      applied: decision.applied,
      source: input.source,
      reason,
      updatedByUserId: input.updatedByUserId,
    });
    if (decision.applied) {
      await applyPreferenceToKeys(tx, keys, {
        enabled: input.enabled,
        source: input.source,
        reason,
        updatedByUserId: input.updatedByUserId,
      });
    }
    return decision;
  });
  if (outcome.blocked) throw new PlatformEmailPreferenceBlockedError();
}

function validatedProviderId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > PROVIDER_ID_MAX_LENGTH) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function providerEventKeyHash(input: {
  webhookId: string;
  providerMessageId: string;
  reason: DeliverySuppressionReason;
  emailHash: string;
}): string {
  return createHash("sha256")
    .update(
      `openvpm-platform-email-provider-event:${input.webhookId}:${input.providerMessageId}:${input.reason}:${input.emailHash}`,
    )
    .digest("hex");
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
  const providerMessageId = validatedProviderId(
    input.providerMessageId,
    "provider message id",
  );
  const webhookId = validatedProviderId(input.webhookId, "webhook id");

  return withSystem(db, async (tx) => {
    const { keys, strongest } = await preparePlaintextRecipient(
      tx,
      input.email,
    );
    const eventKeyHashes = keys.map((key) =>
      providerEventKeyHash({
        webhookId,
        providerMessageId,
        reason: input.reason,
        emailHash: key.emailHash,
      }),
    );
    for (const eventKeyHash of eventKeyHashes) {
      const [existing] = await tx
        .select({ id: platformEmailPreferenceEvents.id })
        .from(platformEmailPreferenceEvents)
        .where(
          eq(platformEmailPreferenceEvents.providerEventKeyHash, eventKeyHash),
        )
        .limit(1);
      if (existing) return { applied: false, duplicate: true };
    }

    const decision = shouldApply(strongest, false, input.reason);
    const inserted = await appendPreferenceEvent(tx, {
      key: keys[0]!,
      requestedMarketingEnabled: false,
      applied: decision.applied,
      source: "resend_webhook",
      reason: input.reason,
      providerEventKeyHash: eventKeyHashes[0]!,
    })
      .onConflictDoNothing({
        target: platformEmailPreferenceEvents.providerEventKeyHash,
      })
      .returning({ id: platformEmailPreferenceEvents.id });

    if (inserted.length === 0) {
      return { applied: false, duplicate: true };
    }
    if (decision.applied) {
      await applyPreferenceToKeys(tx, keys, {
        enabled: false,
        source: "resend_webhook",
        reason: input.reason,
      });
    }
    return { applied: decision.applied, duplicate: false };
  });
}
