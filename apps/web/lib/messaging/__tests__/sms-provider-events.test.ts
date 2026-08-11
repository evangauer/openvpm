import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeProviderOccurredAt } from "../sms-provider-events";
import { findMessagingLocationCandidatesForWebhookInTransaction } from "../inbound";
import type { Database } from "@openpims/db/client";

const SERVICE_SOURCE = readFileSync(
  new URL("../sms-provider-events.ts", import.meta.url),
  "utf8",
);
const INBOUND_SOURCE = readFileSync(
  new URL("../inbound.ts", import.meta.url),
  "utf8",
);
const DELIVERY_SOURCE = readFileSync(
  new URL("../sms-delivery-ledger.ts", import.meta.url),
  "utf8",
);

function functionSource(source: string, start: string, next: string): string {
  const startIndex = source.indexOf(start);
  const nextIndex = source.indexOf(next, startIndex + start.length);
  const endIndex = nextIndex === -1 ? source.length : nextIndex;
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("SMS provider event time normalization", () => {
  const receivedAt = new Date("2026-08-11T12:00:00.000Z");

  it("keeps plausible signed provider time", () => {
    const occurredAt = new Date("2026-08-11T11:59:00.000Z");
    expect(normalizeProviderOccurredAt(occurredAt, receivedAt)).toEqual(
      occurredAt,
    );
  });

  it.each([
    ["invalid", "not-a-date"],
    ["too far in the future", "2026-08-11T12:11:00.000Z"],
    ["implausibly ancient", "2026-07-01T12:00:00.000Z"],
  ])("falls back to receipt time when provider time is %s", (_label, value) => {
    expect(normalizeProviderOccurredAt(value, receivedAt)).toEqual(receivedAt);
  });
});

describe("inbound provider identity candidate resolution", () => {
  function databaseWithResults(
    results: Array<Array<{ practiceId: string; locationId: string }>>,
  ): Database {
    return {
      select: () => {
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: () => builder,
          limit: async () => results.shift() ?? [],
        };
        return builder;
      },
    } as unknown as Database;
  }

  it("locks both practice candidates but attributes neither on contradiction", async () => {
    const result = await findMessagingLocationCandidatesForWebhookInTransaction(
      databaseWithResults([
        [{ practiceId: "practice-a", locationId: "location-a" }],
        [{ practiceId: "practice-b", locationId: "location-b" }],
      ]),
      {
        provider: "telnyx",
        senderE164: "+15555550100",
        messagingProfileId: "profile-b",
      },
    );
    expect(result).toEqual({
      practiceIds: ["practice-a", "practice-b"],
      location: null,
    });
  });

  it("attributes only when sender and profile uniquely agree", async () => {
    const location = { practiceId: "practice-a", locationId: "location-a" };
    const result = await findMessagingLocationCandidatesForWebhookInTransaction(
      databaseWithResults([[location], [location]]),
      {
        provider: "twilio",
        senderE164: "+15555550100",
        messagingProfileId: "profile-a",
      },
    );
    expect(result).toEqual({ practiceIds: ["practice-a"], location });
  });
});

describe("SMS provider event durability contracts", () => {
  it("takes sorted practice and recipient locks before inbound inbox insert", () => {
    const intake = functionSource(
      SERVICE_SOURCE,
      "export async function ingestSmsProviderEvent(",
      "type StoredSmsProviderEvent",
    );
    expect(intake.indexOf("lockPracticeIdsInTransaction")).toBeLessThan(
      intake.indexOf("lockMessagingLocationIdentityInTransaction"),
    );
    expect(
      intake.indexOf("lockMessagingLocationIdentityInTransaction"),
    ).toBeLessThan(intake.indexOf("acquireSmsRecipientLockInTransaction"));
    expect(intake.indexOf("acquireSmsRecipientLockInTransaction")).toBeLessThan(
      intake.indexOf(".insert(smsProviderEvents)"),
    );
    expect(intake).toContain(
      "lockedPracticeIds.includes(candidate.practiceId)",
    );
    expect(intake).toContain(
      "for (const practiceId of initialResolution.practiceIds)",
    );
  });

  it("keeps contradictory sender/profile candidate practices for STOP locking", () => {
    const candidates = functionSource(
      INBOUND_SOURCE,
      "export async function findMessagingLocationCandidatesForWebhookInTransaction(",
      "/** Resolve sender and messaging profile",
    );
    expect(candidates).toContain("senderMatches");
    expect(candidates).toContain("profileMatches");
    expect(candidates).toContain("practiceIds");
    expect(candidates).toContain(
      "senderMatch.practiceId === profileMatch.practiceId",
    );
    expect(candidates).toContain(
      "senderMatch.locationId === profileMatch.locationId",
    );
  });

  it("excludes deleted sender, location, and practice identities", () => {
    expect(INBOUND_SOURCE).toContain("isNull(locationMessaging.deletedAt)");
    expect(INBOUND_SOURCE).toContain("isNull(locations.deletedAt)");
    expect(INBOUND_SOURCE).toContain("isNull(practices.deletedAt)");
  });

  it("pre-reads same-key attribution and locks the sorted practice union", () => {
    const intake = functionSource(
      SERVICE_SOURCE,
      "export async function ingestSmsProviderEvent(",
      "type StoredSmsProviderEvent",
    );
    expect(intake.indexOf("preExisting")).toBeLessThan(
      intake.indexOf("lockPracticeIdsInTransaction"),
    );
    expect(intake).toContain("...(preExisting?.practiceId");
    expect(SERVICE_SOURCE).toContain(".orderBy(practices.id)");
  });

  it("records collision evidence even when the original event is terminal", () => {
    const intake = functionSource(
      SERVICE_SOURCE,
      "export async function ingestSmsProviderEvent(",
      "type StoredSmsProviderEvent",
    );
    expect(intake.indexOf(".insert(smsProviderEventConflicts)")).toBeLessThan(
      intake.indexOf('original.state === "pending"'),
    );
    expect(intake).toContain('original.state === "blocked_recovery"');
    expect(intake).not.toContain('original.state === "projected" ||');
  });

  it("uses practice, sender identity, recipient, event lock order during inbound projection", () => {
    const projection = functionSource(
      SERVICE_SOURCE,
      "async function projectSmsProviderEventWithLocksInTransaction(",
      "export async function projectSmsProviderEvent(",
    );
    expect(projection.indexOf("lockPracticeStatesInTransaction")).toBeLessThan(
      projection.indexOf("lockMessagingLocationIdentityInTransaction"),
    );
    expect(
      projection.indexOf("lockMessagingLocationIdentityInTransaction"),
    ).toBeLessThan(projection.indexOf("acquireSmsRecipientLockInTransaction"));
    expect(
      projection.indexOf("acquireSmsRecipientLockInTransaction"),
    ).toBeLessThan(projection.indexOf('.for("update")'));
    expect(projection.indexOf('.for("update")')).toBeLessThan(
      projection.indexOf("resolveStoredEventInTransaction(tx, event)"),
    );
    expect(projection).toContain(
      "inboundRecipientLockAlreadyHeld: inboundRecipientLockHeld",
    );
  });

  it("never silently consumes supported unresolved inbound or A2P evidence", () => {
    expect(SERVICE_SOURCE).toContain("inbound_attribution_pending");
    expect(SERVICE_SOURCE).toContain("a2p_attribution_pending");
    expect(SERVICE_SOURCE).toContain("a2p_projection_pending");
  });

  it("allows the owner recovery drain to bypass only the inbound launch flag", () => {
    expect(SERVICE_SOURCE).toContain(
      "allowDisabledInbound: Boolean(options.lockedPracticeId && options.force)",
    );
    expect(SERVICE_SOURCE).toContain(
      "!options.allowDisabledInbound && !hostedInboundProjectionEnabled()",
    );
  });

  it("revalidates exact A2P identities in the registration compare-and-set", () => {
    const a2p = functionSource(
      SERVICE_SOURCE,
      "async function projectA2pEventInTransaction(",
      "async function projectLockedEventInTransaction(",
    );
    expect(a2p).toContain("messagingRegistrations.providerBrandId");
    expect(a2p).toContain("messagingRegistrations.providerCampaignId");
    expect(a2p).toContain("sender.sender_e164");
    expect(a2p).toContain("messagingRegistrations.status, registration.status");
  });

  it("keeps callback-first DLRs retryable and quarantines ambiguity", () => {
    expect(SERVICE_SOURCE).toContain('result.result === "ambiguous"');
    expect(SERVICE_SOURCE).toContain('result.result !== "projected"');
    expect(SERVICE_SOURCE).toContain("exhaustible: false");
    expect(SERVICE_SOURCE).toContain("delivery_attribution_pending");
  });

  it("bounds genuine retry storms without exhausting the disabled launch gate", () => {
    expect(SERVICE_SOURCE).toContain("MAX_PROJECTION_ATTEMPTS = 12");
    expect(SERVICE_SOURCE).toContain("projection_retry_exhausted");
    const inbound = functionSource(
      SERVICE_SOURCE,
      'if (event.kind === "inbound")',
      'if (event.kind === "delivery")',
    );
    expect(inbound).toContain("inbound_projection_disabled");
    expect(inbound).toContain("exhaustible: false");
  });

  it("counts held and quarantined work in bounded-worker remaining", () => {
    expect(SERVICE_SOURCE).toMatch(
      /result\.remaining\s*=\s*summary\.pending\s*\+\s*summary\.retry\s*\+\s*summary\.blockedRecovery\s*\+\s*summary\.quarantined\s*\+\s*summary\.conflicts/,
    );
  });
});

describe("atomic inbound and delivery projection boundaries", () => {
  it("projects consent, suppression, client, communication, and inbox state on one tx", () => {
    const projection = functionSource(
      INBOUND_SOURCE,
      "export async function projectInboundSmsReplyInTransaction(",
      "/** Compatibility entry point",
    );
    expect(projection).not.toContain("withSystem(");
    expect(projection).not.toContain("withTenant(");
    expect(projection).toContain(
      "revokeSmsConsentAfterRecipientLockInTransaction(tx",
    );
    expect(projection).toContain("applyInboundSmsOptInInTransaction(tx");
    expect(projection).toContain("logInboundSmsCommunicationInTransaction(tx");
    expect(SERVICE_SOURCE).toContain("projectInboundSmsReplyInTransaction(tx");
    expect(SERVICE_SOURCE).toContain("markTerminalInTransaction(tx, event");
  });

  it("uses bounded constant consent detail rather than copying message content", () => {
    expect(INBOUND_SOURCE).toContain('detail: "Inbound SMS opt-out received."');
    expect(INBOUND_SOURCE).toContain('detail: "Inbound SMS opt-in received."');
    expect(INBOUND_SOURCE).not.toContain("Inbound opt-out: ${text}");
    expect(INBOUND_SOURCE).not.toContain("Inbound opt-in keyword:");
  });

  it("makes operator delivery reconciliation practice-first and recovery-aware", () => {
    const reconciliation = functionSource(
      DELIVERY_SOURCE,
      "export async function reconcileSmsDeliveryEvent(",
      "export async function",
    );
    expect(reconciliation.indexOf('.for("share"')).toBeLessThan(
      reconciliation.indexOf("lockSmsDeliveryIdentity("),
    );
    expect(reconciliation).toContain("practice.recoveryHold");
    expect(reconciliation).toContain("revalidatedPracticeIds");
  });
});
