import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  projectInbound: vi.fn(async () => ({ duplicate: false })),
  revoke: vi.fn(async () => undefined),
  delivery: vi.fn(),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: vi.fn(
    async (database: unknown, action: (tx: unknown) => unknown) =>
      action(database),
  ),
}));
vi.mock("../sms-provider-events", () => ({
  lockSmsProviderEventForRemediationInTransaction: mocks.lock,
}));
vi.mock("../inbound", () => ({
  inboundSmsDedupeKey: (provider: string, id: string) =>
    `sms:inbound:${provider}:${id}`,
  projectInboundSmsReplyInTransaction: mocks.projectInbound,
}));
vi.mock("../consent-events", () => ({
  inboundSmsConsentEventKey: (provider: string, id: string, action: string) =>
    `sms:consent:${provider}:${id}:${action}`,
}));
vi.mock("../suppression", () => ({
  revokeSmsConsentAfterRecipientLockInTransaction: mocks.revoke,
}));
vi.mock("../sms-delivery-ledger", () => ({
  recordSmsDeliveryCallbackInTransaction: mocks.delivery,
}));

const {
  isValidProviderExternalEvidenceReference,
  resolveSmsProviderEventInTransaction,
  smsProviderEventResolutionModesForIncident,
} = await import("../sms-provider-event-remediation");

const SERVICE_SOURCE = readFileSync(
  new URL("../sms-provider-event-remediation.ts", import.meta.url),
  "utf8",
);
const STATUS_SOURCE = readFileSync(
  new URL("../sms-provider-event-resolution-status.ts", import.meta.url),
  "utf8",
);
const OPERATIONS_SOURCE = readFileSync(
  new URL("../sms-provider-event-operations.ts", import.meta.url),
  "utf8",
);
const PROVIDER_SOURCE = readFileSync(
  new URL("../sms-provider-events.ts", import.meta.url),
  "utf8",
);

const EVENT_ID = "00000000-0000-4000-8000-000000000101";
const CONFLICT_ID = "00000000-0000-4000-8000-000000000102";
const OPERATION_ID = "00000000-0000-4000-8000-000000000103";
const PRACTICE_ID = "00000000-0000-4000-8000-000000000104";
const LOCATION_ID = "00000000-0000-4000-8000-000000000105";
const COMMUNICATION_ID = "00000000-0000-4000-8000-000000000106";
const CONSENT_ID = "00000000-0000-4000-8000-000000000107";
const REGISTRATION_EVENT_ID = "00000000-0000-4000-8000-000000000108";
const RESOLUTION_ID = "00000000-0000-4000-8000-000000000109";

type FakeTx = ReturnType<typeof fakeTx>;

function fakeTx(
  selectResults: unknown[][],
  returningResults: unknown[][] = [],
) {
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];
  const select = vi.fn(() => {
    const builder: Record<string, unknown> & PromiseLike<unknown[]> = {
      then: (resolve, reject) =>
        Promise.resolve(selectResults.shift() ?? []).then(resolve, reject),
    };
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.for = vi.fn(async () => selectResults.shift() ?? []);
    return builder;
  });
  const insert = vi.fn(() => {
    const builder: Record<string, unknown> & PromiseLike<void> = {
      then: (resolve, reject) => Promise.resolve().then(resolve, reject),
    };
    builder.values = vi.fn((values: unknown) => {
      insertedValues.push(values);
      return builder;
    });
    builder.onConflictDoNothing = vi.fn(() => builder);
    builder.returning = vi.fn(async () => returningResults.shift() ?? []);
    return builder;
  });
  const update = vi.fn(() => {
    const builder: Record<string, unknown> & PromiseLike<void> = {
      then: (resolve, reject) => Promise.resolve().then(resolve, reject),
    };
    builder.set = vi.fn((values: unknown) => {
      updatedValues.push(values);
      return builder;
    });
    builder.where = vi.fn(() => builder);
    return builder;
  });
  return { select, insert, update, insertedValues, updatedValues };
}

function inboundEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: EVENT_ID,
    provider: "telnyx",
    kind: "inbound",
    state: "quarantined",
    practiceId: PRACTICE_ID,
    locationId: LOCATION_ID,
    lastErrorCode: "projection_retry_exhausted",
    fromE164: "+15555550199",
    toE164: "+15555550100",
    messageBody: "STOP",
    providerMessageId: "message-101",
    inboundClassification: "stop",
    occurredAt: new Date("2026-08-11T12:00:00.000Z"),
    receivedAt: new Date("2026-08-11T12:00:01.000Z"),
    ...overrides,
  };
}

function locked(event: Record<string, unknown>, attribution = true) {
  return {
    event,
    attribution: attribution
      ? { practiceId: PRACTICE_ID, locationId: event.locationId ?? null }
      : null,
    resolution: {
      practiceIds: attribution ? [PRACTICE_ID] : [],
      attribution: null,
    },
    inboundRecipientLockHeld: event.kind === "inbound",
  };
}

function resultRow(input: {
  resolution: string;
  conflictId?: string | null;
  practiceId?: string | null;
  reasonCode: string;
  inboundCommunicationId?: string | null;
  smsConsentEventId?: string | null;
  messagingRegistrationEventId?: string | null;
  externalEvidenceReference?: string | null;
}) {
  return {
    id: RESOLUTION_ID,
    eventId: EVENT_ID,
    conflictId: input.conflictId ?? null,
    operationId: OPERATION_ID,
    practiceId: input.practiceId === undefined ? PRACTICE_ID : input.practiceId,
    resolution: input.resolution,
    reasonCode: input.reasonCode,
    resolvedByIdentity: "o***@example.com",
    resolvedByName: "Operator",
    inboundCommunicationId: input.inboundCommunicationId ?? null,
    smsConsentEventId: input.smsConsentEventId ?? null,
    smsDeliveryEventId: null,
    messagingRegistrationEventId: input.messagingRegistrationEventId ?? null,
    externalEvidenceReference: input.externalEvidenceReference ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider-event remediation mode and privacy policy", () => {
  it("restricts base and conflict incidents to evidence-valid modes", () => {
    expect(
      smsProviderEventResolutionModesForIncident({
        kind: "inbound",
        state: "quarantined",
        lastErrorCode: "projection_retry_exhausted",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).toEqual(["authoritative_projection"]);
    expect(
      smsProviderEventResolutionModesForIncident({
        kind: "inbound",
        state: "projected",
        lastErrorCode: null,
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        conflictId: CONFLICT_ID,
      }),
    ).toEqual(["conservative_opt_out"]);
    expect(
      smsProviderEventResolutionModesForIncident({
        kind: "inbound",
        state: "projected",
        lastErrorCode: null,
        practiceId: null,
        locationId: null,
        conflictId: CONFLICT_ID,
      }),
    ).toEqual([]);
    expect(
      smsProviderEventResolutionModesForIncident({
        kind: "a2p",
        state: "ignored",
        lastErrorCode: null,
        practiceId: PRACTICE_ID,
        locationId: null,
        conflictId: CONFLICT_ID,
      }),
    ).toEqual(["carrier_state_reconciled"]);
    expect(
      smsProviderEventResolutionModesForIncident({
        kind: "delivery",
        state: "quarantined",
        lastErrorCode: null,
        practiceId: null,
        locationId: null,
      }),
    ).toEqual(["provider_attested_no_projection"]);
  });

  it("rejects phone-shaped and malformed provider references", () => {
    expect(isValidProviderExternalEvidenceReference("TELNYX-TICKET:2048")).toBe(
      true,
    );
    expect(isValidProviderExternalEvidenceReference("+1 (555) 555-0199")).toBe(
      false,
    );
    expect(isValidProviderExternalEvidenceReference("15555550199")).toBe(false);
    expect(isValidProviderExternalEvidenceReference("contains spaces")).toBe(
      false,
    );
  });
});

describe("provider-event remediation evidence behavior", () => {
  it("authoritatively projects inbound STOP and binds communication plus consent", async () => {
    mocks.lock.mockResolvedValue(locked(inboundEvent()));
    const tx = fakeTx(
      [[], [], [{ id: COMMUNICATION_ID }], [{ id: CONSENT_ID }]],
      [
        [
          resultRow({
            resolution: "authoritative_projection",
            reasonCode: "projection_repaired",
            inboundCommunicationId: COMMUNICATION_ID,
            smsConsentEventId: CONSENT_ID,
          }),
        ],
      ],
    );

    await expect(
      resolveSmsProviderEventInTransaction(tx as never, {
        eventId: EVENT_ID,
        operationId: OPERATION_ID,
        resolution: "authoritative_projection",
        actorIdentity: "o***@example.com",
        actorName: "Operator",
      }),
    ).resolves.toMatchObject({
      resolutionId: RESOLUTION_ID,
      duplicate: false,
    });

    expect(mocks.projectInbound).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        classification: "stop",
        recipientLockAlreadyHeld: true,
      }),
    );
    expect(mocks.lock).toHaveBeenCalledWith(
      tx,
      EVENT_ID,
      expect.objectContaining({ allowRecoveryHeld: true }),
    );
    expect(tx.insertedValues).toContainEqual(
      expect.objectContaining({
        reasonCode: "projection_repaired",
        inboundCommunicationId: COMMUNICATION_ID,
        smsConsentEventId: CONSENT_ID,
      }),
    );
  });

  it("resolves a projected inbound conflict with system revocation and active suppression", async () => {
    mocks.lock.mockResolvedValue(
      locked(inboundEvent({ state: "projected", messageBody: "START" })),
    );
    const tx = fakeTx(
      [
        [],
        [{ id: CONFLICT_ID }],
        [],
        [{ id: CONSENT_ID }],
        [{ id: "suppression-1" }],
        [],
        [{ id: "review-1" }],
      ],
      [
        [
          resultRow({
            resolution: "conservative_opt_out",
            conflictId: CONFLICT_ID,
            reasonCode: "provider_identity_conflict_opt_out",
            smsConsentEventId: CONSENT_ID,
          }),
        ],
      ],
    );

    await resolveSmsProviderEventInTransaction(tx as never, {
      eventId: EVENT_ID,
      conflictId: CONFLICT_ID,
      operationId: OPERATION_ID,
      resolution: "conservative_opt_out",
      actorIdentity: "o***@example.com",
      actorName: "Operator",
    });

    expect(mocks.revoke).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        evidence: expect.objectContaining({
          actorType: "system",
          source: "provider_event_resolution:v1",
          eventKey: `provider_event_resolution:${OPERATION_ID}:${CONFLICT_ID}:revoked`,
        }),
      }),
    );
    expect(tx.insertedValues).toContainEqual(
      expect.objectContaining({
        conflictId: CONFLICT_ID,
        resolution: "conservative_opt_out",
        reasonCode: "provider_identity_conflict_opt_out",
        smsConsentEventId: CONSENT_ID,
      }),
    );
  });

  it("makes exact operation replay idempotent before tenant locks or effects", async () => {
    const prior = resultRow({
      resolution: "provider_attested_no_projection",
      practiceId: null,
      reasonCode: "provider_support_invalid_callback",
      externalEvidenceReference: "TELNYX-TICKET:2048",
    });
    const tx = fakeTx([[prior]]);
    await expect(
      resolveSmsProviderEventInTransaction(tx as never, {
        eventId: EVENT_ID,
        operationId: OPERATION_ID,
        resolution: "provider_attested_no_projection",
        reasonCode: "provider_support_invalid_callback",
        externalEvidenceReference: "TELNYX-TICKET:2048",
        providerAttestationConfirmed: true,
        actorIdentity: "o***@example.com",
        actorName: "Operator",
      }),
    ).resolves.toMatchObject({ duplicate: true, practiceId: null });
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.projectInbound).not.toHaveBeenCalled();
  });

  it("binds carrier evidence to the remediation operation and keeps senders disabled", async () => {
    const event = {
      ...inboundEvent(),
      kind: "a2p",
      state: "quarantined",
      locationId: null,
      a2pBrandId: "brand-101",
      a2pCampaignId: "campaign-101",
      a2pPhoneE164: null,
    };
    mocks.lock.mockResolvedValue(locked(event));
    const tx = fakeTx(
      [[], [], [{ id: REGISTRATION_EVENT_ID, locationId: null }]],
      [
        [
          resultRow({
            resolution: "carrier_state_reconciled",
            reasonCode: "carrier_state_readback_confirmed",
            messagingRegistrationEventId: REGISTRATION_EVENT_ID,
          }),
        ],
      ],
    );

    await resolveSmsProviderEventInTransaction(tx as never, {
      eventId: EVENT_ID,
      operationId: OPERATION_ID,
      resolution: "carrier_state_reconciled",
      messagingRegistrationEventId: REGISTRATION_EVENT_ID,
      actorIdentity: "o***@example.com",
      actorName: "Operator",
    });

    expect(tx.updatedValues).toContainEqual(
      expect.objectContaining({
        enabled: false,
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
    expect(tx.insertedValues).toContainEqual(
      expect.objectContaining({
        operationId: OPERATION_ID,
        messagingRegistrationEventId: REGISTRATION_EVENT_ID,
        reasonCode: "carrier_state_readback_confirmed",
      }),
    );
  });
});

describe("provider-event remediation operational gates", () => {
  it("allows only the audited resolver to cross a recovery hold under a practice update lock", () => {
    expect(SERVICE_SOURCE).toContain("allowRecoveryHeld: true");
    expect(PROVIDER_SOURCE).toContain("options: { forUpdate?: boolean } = {}");
    expect(PROVIDER_SOURCE).toContain('options.forUpdate ? "update" : "share"');
    expect(PROVIDER_SOURCE).toContain("!options.allowRecoveryHeld &&");
    expect(SERVICE_SOURCE).not.toContain("recoveryHold:");
  });

  it("requires base evidence and fresh review plus resolution for every conflict", () => {
    expect(STATUS_SOURCE).toContain("base_resolution.conflict_id is null");
    expect(STATUS_SOURCE).toContain(
      "event.last_error_code = 'provider_identity_conflict'",
    );
    expect(STATUS_SOURCE).toContain("conflict_review.conflict_id");
    expect(STATUS_SOURCE).toContain("conflict_resolution.conflict_id");
    expect(STATUS_SOURCE).toContain("not exists (");
    expect(
      OPERATIONS_SOURCE.match(/smsProviderEventQuarantineIsRemediatedSql/g),
    ).toHaveLength(5);
    expect(PROVIDER_SOURCE).toContain(
      "smsProviderEventQuarantineIsRemediatedSql",
    );
    expect(PROVIDER_SOURCE).toMatch(
      /summary\.quarantined\s*\+\s*summary\.conflicts/,
    );
  });

  it("never mutates the terminal provider event during remediation", () => {
    expect(SERVICE_SOURCE).not.toContain(".update(smsProviderEvents)");
    expect(SERVICE_SOURCE.indexOf("appendConflictReview(")).toBeLessThan(
      SERVICE_SOURCE.lastIndexOf(".insert(smsProviderEventResolutions)"),
    );
  });
});
