import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { smsSendAttempts } from "@openpims/db";

const mocks = vi.hoisted(() => ({
  tx: {} as Record<string, unknown>,
  providerSend: vi.fn(),
  resolveMessagingTransport: vi.fn(),
  getMessagingProvider: vi.fn(),
  billingEnforced: vi.fn(() => false),
  hasHostedFullAccess: vi.fn(() => true),
  recordUsage: vi.fn(async () => undefined),
  withSystem: vi.fn(),
  acquireSmsRecipientLockInTransaction: vi.fn(async () => undefined),
  alertOps: vi.fn(async () => undefined),
  practiceAllowsExternalSideEffects: vi.fn(async () => true),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
  isQuietHours: vi.fn(() => false),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));
vi.mock("@/lib/billing/usage", () => ({ recordUsage: mocks.recordUsage }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  practiceAllowsExternalSideEffects: mocks.practiceAllowsExternalSideEffects,
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));
vi.mock("@/lib/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging")>();
  return {
    ...actual,
    resolveMessagingTransport: mocks.resolveMessagingTransport,
    getMessagingProvider: mocks.getMessagingProvider,
    acquireSmsRecipientLockInTransaction:
      mocks.acquireSmsRecipientLockInTransaction,
  };
});
vi.mock("@/lib/messaging/reminders", () => ({
  isQuietHours: mocks.isQuietHours,
}));

const {
  classifySmsAttemptForOps,
  prepareCampaignSmsBody,
  reconcileSmsSendAttempt,
  resendSmsAttempt,
  sendSms,
  SMS_COMPLIANCE_FOOTER,
} = await import("../sms-dispatch");
const { sendAppointmentReminderSms, sendVaccinationReminderSms } =
  await import("../sms");
const { revokeSmsConsentByPhoneInTransaction } =
  await import("@/lib/messaging/suppression");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const LOCATION_ID = "00000000-0000-0000-0000-0000000000cc";
const COMMUNICATION_ID = "00000000-0000-0000-0000-0000000000dd";
const ACTOR_ID = "00000000-0000-0000-0000-0000000000ee";

type Attempt = Record<string, unknown> & {
  id: string;
  createdAt: Date;
  practiceId: string;
  idempotencyKey: string;
  resendOfAttemptId: string | null;
};
type AttemptEvent = Record<string, unknown> & {
  id: string;
  createdAt: Date;
  practiceId: string;
  attemptId: string;
  kind: "provider_result" | "reconciliation";
  outcome: "accepted" | "definite_failure" | "outcome_unknown";
  providerMessageId: string | null;
  detail: string | null;
  eventKey: string;
};

function sqlIncludesColumnParamPair(
  value: unknown,
  columnName: string,
  paramValue: unknown,
): boolean {
  if (!value || typeof value !== "object") return false;
  const chunk = value as { name?: unknown; queryChunks?: unknown[] };
  if (!Array.isArray(chunk.queryChunks)) return false;
  const hasColumn = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === columnName,
  );
  const hasParam = chunk.queryChunks.some((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as { value?: unknown };
    return Object.prototype.hasOwnProperty.call(candidate, "value")
      ? Object.is(candidate.value, paramValue)
      : false;
  });
  return (
    (hasColumn && hasParam) ||
    chunk.queryChunks.some((item) =>
      sqlIncludesColumnParamPair(item, columnName, paramValue),
    )
  );
}

function sqlIncludesColumn(value: unknown, columnName: string): boolean {
  if (!value || typeof value !== "object") return false;
  const chunk = value as { name?: unknown; queryChunks?: unknown[] };
  if (chunk.name === columnName) return true;
  return (
    Array.isArray(chunk.queryChunks) &&
    chunk.queryChunks.some((item) => sqlIncludesColumn(item, columnName))
  );
}

function createLedgerDb() {
  const attempts: Attempt[] = [];
  const events: AttemptEvent[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const locationMessagingRows: Array<Record<string, unknown>> = [
    {
      provider: "telnyx",
      messagingServiceId: null,
      senderE164: "+15555550100",
      enabled: true,
      registrationStatus: "active",
      a2pCampaignId: "campaign-1",
      a2pBrandId: "brand-1",
    },
  ];
  const practiceRows: Array<Record<string, unknown>> = [
    {
      name: "Neighborhood Veterinary",
      tier: "cloud",
      billingStatus: "active",
      trialEndsAt: null,
    },
  ];
  const clientRows: Array<Record<string, unknown>> = [
    {
      phone: "+15555550199",
      smsConsent: true,
      smsConsentAt: new Date("2026-08-01T00:00:00Z"),
      smsConsentSource: "staff_attested_form:v1",
      smsConsentDisclosure: "Disclosure",
    },
  ];
  const suppressionRows: Array<Record<string, unknown>> = [];
  const communicationRows: Array<Record<string, unknown>> = [
    { id: COMMUNICATION_ID, status: "pending" },
  ];
  const communicationProjection = { available: true };
  const throwOnSelect = new Map<string, Error>();
  const selectedTables: string[] = [];
  let id = 0;

  const rowsFor = (
    table: unknown,
    fields?: Record<string, unknown>,
    condition?: unknown,
  ) => {
    const name = getTableName(table as never);
    selectedTables.push(name);
    const selectedError = throwOnSelect.get(name);
    if (selectedError) throw selectedError;
    if (name === "messaging_registrations") return registrations;
    if (name === "location_messaging") return locationMessagingRows;
    if (name === "practices") return practiceRows;
    if (name === "sms_suppressions") return suppressionRows;
    if (name === "users") {
      return [{ id: ACTOR_ID, name: "Operator", email: "ops@openvpm.com" }];
    }
    if (name === "communications") return communicationRows;
    if (name === "sms_send_attempts") {
      if (fields && Object.keys(fields).length === 1 && "id" in fields) {
        const current = attempts.at(-1)?.id;
        return attempts.filter((attempt) => {
          if (attempt.id === current) return false;
          const attemptEvents = events.filter(
            (event) => event.attemptId === attempt.id,
          );
          const effective =
            [...attemptEvents]
              .reverse()
              .find((event) => event.kind === "reconciliation") ??
            [...attemptEvents]
              .reverse()
              .find((event) => event.kind === "provider_result");
          return !effective || effective.outcome === "outcome_unknown";
        });
      }
      const specificallyMatched = attempts.filter(
        (attempt) =>
          sqlIncludesColumnParamPair(condition, "id", attempt.id) ||
          sqlIncludesColumnParamPair(
            condition,
            "idempotency_key",
            attempt.idempotencyKey,
          ) ||
          (attempt.resendOfAttemptId !== null &&
            sqlIncludesColumnParamPair(
              condition,
              "resend_of_attempt_id",
              attempt.resendOfAttemptId,
            )),
      );
      if (specificallyMatched.length > 0) return specificallyMatched;
      if (
        sqlIncludesColumn(condition, "id") ||
        sqlIncludesColumn(condition, "idempotency_key") ||
        sqlIncludesColumn(condition, "resend_of_attempt_id")
      ) {
        return [];
      }
      return attempts;
    }
    if (name === "sms_send_attempt_events") {
      const matched = events.filter((event) =>
        sqlIncludesColumnParamPair(condition, "attempt_id", event.attemptId),
      );
      return [
        ...(sqlIncludesColumn(condition, "attempt_id") ? matched : events),
      ].reverse();
    }
    if (name === "clients") return clientRows;
    return [];
  };

  const select = vi.fn((fields?: Record<string, unknown>) => {
    let table: unknown;
    let condition: unknown;
    const settle = () => Promise.resolve(rowsFor(table, fields, condition));
    const limited = () => Object.assign(settle(), { for: settle });
    const builder = {
      from(value: unknown) {
        table = value;
        return builder;
      },
      where(value: unknown) {
        condition = value;
        return builder;
      },
      orderBy: () => builder,
      limit: limited,
      for: settle,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => settle().then(resolve, reject),
    };
    return builder;
  });

  const insert = vi.fn((table: unknown) => ({
    values(values: Record<string, unknown>) {
      let committed: Record<string, unknown> | undefined;
      const commit = () => {
        if (committed) return committed;
        const name = getTableName(table as never);
        if (name === "sms_send_attempts") {
          const duplicate = attempts.find(
            (attempt) =>
              attempt.practiceId === values.practiceId &&
              (attempt.idempotencyKey === values.idempotencyKey ||
                (values.resendOfAttemptId &&
                  attempt.resendOfAttemptId === values.resendOfAttemptId)),
          );
          if (duplicate) return undefined;
          committed = {
            ...values,
            id: `00000000-0000-0000-0000-${String(++id).padStart(12, "0")}`,
            createdAt: new Date(),
            clientId: values.clientId ?? null,
            locationId: values.locationId ?? null,
            communicationId: values.communicationId ?? null,
            resendOfAttemptId: values.resendOfAttemptId ?? null,
            requestedByActorType: values.requestedByActorType ?? null,
            requestedByUserId: values.requestedByUserId ?? null,
            requestedByIdentity: values.requestedByIdentity ?? null,
            requestedByName: values.requestedByName ?? null,
            senderMessagingServiceId: values.senderMessagingServiceId ?? null,
            senderE164: values.senderE164 ?? null,
          };
          attempts.push(committed as Attempt);
          return committed;
        }
        if (name === "sms_send_attempt_events") {
          const duplicate = events.find(
            (event) =>
              event.practiceId === values.practiceId &&
              event.eventKey === values.eventKey,
          );
          if (duplicate) return undefined;
          committed = {
            ...values,
            id: `10000000-0000-0000-0000-${String(++id).padStart(12, "0")}`,
            createdAt: new Date(),
            providerMessageId: values.providerMessageId ?? null,
            detail: values.detail ?? null,
          };
          events.push(committed as AttemptEvent);
          return committed;
        }
        return undefined;
      };
      const chain = {
        onConflictDoNothing: () => chain,
        returning: async () => {
          const row = commit();
          return row ? [row] : [];
        },
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(commit()).then(resolve, reject),
      };
      return chain;
    },
  }));

  const update = vi.fn(() => ({
    set(values: Record<string, unknown>) {
      updates.push(values);
      const chain = {
        where: () => chain,
        returning: async () =>
          communicationProjection.available ? [{ id: COMMUNICATION_ID }] : [],
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      };
      return chain;
    },
  }));

  const tx = { execute: vi.fn(async () => undefined), select, insert, update };
  return {
    tx,
    attempts,
    events,
    updates,
    registrations,
    locationMessagingRows,
    practiceRows,
    clientRows,
    suppressionRows,
    communicationRows,
    communicationProjection,
    throwOnSelect,
    selectedTables,
  };
}

function sendOptions(overrides: Record<string, unknown> = {}) {
  return {
    to: "+15555550199",
    body: "Miso's prescription is ready for pickup.",
    practiceId: PRACTICE_ID,
    locationId: LOCATION_ID,
    clientId: CLIENT_ID,
    communicationId: COMMUNICATION_ID,
    source: "inbox",
    sourceId: COMMUNICATION_ID,
    idempotencyKey: `sms:inbox:${COMMUNICATION_ID}`,
    ...overrides,
  };
}

function allowHostedPilot() {
  vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
  vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", PRACTICE_ID);
  vi.stubEnv("MESSAGING_SENDING_LOCATION_IDS", LOCATION_ID);
  state().registrations.push({
    displayName: "Neighborhood Veterinary",
    providerCampaignId: "campaign-1",
    providerBrandId: "brand-1",
  });
}

function transport(
  sender: { messagingServiceId?: string; from?: string },
  name: "telnyx" | "twilio" | "console" = "telnyx",
  send = mocks.providerSend,
) {
  return {
    provider: { name, isConfigured: () => true, send },
    sender,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  const state = createLedgerDb();
  mocks.tx = state.tx;
  mocks.withSystem.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
  );
  mocks.resolveMessagingTransport.mockResolvedValue(
    transport({ from: "+15555550100" }),
  );
  mocks.getMessagingProvider.mockReturnValue({
    name: "telnyx",
    isConfigured: () => true,
    send: mocks.providerSend,
  });
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.isQuietHours.mockReturnValue(false);
  mocks.providerSend.mockResolvedValue({
    status: "accepted",
    id: "msg-default",
  });
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.acquireSmsRecipientLockInTransaction.mockResolvedValue(undefined);
  mocks.practiceAllowsExternalSideEffects.mockResolvedValue(true);
  vi.stubEnv("MESSAGING_REGISTERED_DISPLAY_NAME", "Neighborhood Veterinary");
  (globalThis as Record<string, unknown>).__smsLedgerState = state;
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__smsLedgerState;
});

function state() {
  return (globalThis as Record<string, unknown>).__smsLedgerState as ReturnType<
    typeof createLedgerDb
  >;
}

describe("campaign-consistent SMS copy", () => {
  it("uses one registered-name prefix and one canonical STOP/HELP footer", () => {
    expect(
      prepareCampaignSmsBody({
        registeredDisplayName: "Neighborhood Veterinary",
        content: "Neighborhood Veterinary: Miso is ready.",
      }),
    ).toEqual({
      success: true,
      body: `Neighborhood Veterinary: Miso is ready. ${SMS_COMPLIANCE_FOOTER}`,
    });
  });

  it("rejects embedded compliance copy and validates the final 1600 characters", () => {
    expect(
      prepareCampaignSmsBody({
        registeredDisplayName: "Clinic",
        content: "Reply STOP to opt out.",
      }),
    ).toMatchObject({ success: false });
    expect(
      prepareCampaignSmsBody({
        registeredDisplayName: "Clinic",
        content: "x".repeat(1600),
      }),
    ).toMatchObject({ success: false });
  });
});

describe("operator queue classification", () => {
  const stale = new Date("2026-08-09T00:00:00Z");
  const now = new Date("2026-08-09T01:00:00Z");
  const event = (
    kind: "provider_result" | "reconciliation",
    outcome: "accepted" | "definite_failure" | "outcome_unknown",
  ) => ({ kind, outcome, providerMessageId: null, detail: null });

  it("queues stale missing and unknown outcomes but not fresh or resolved attempts", () => {
    expect(
      classifySmsAttemptForOps({ createdAt: stale, events: [], now }),
    ).toBe("missing_provider_result");
    expect(
      classifySmsAttemptForOps({
        createdAt: stale,
        events: [event("provider_result", "outcome_unknown")],
        now,
      }),
    ).toBe("outcome_unknown");
    expect(
      classifySmsAttemptForOps({
        createdAt: stale,
        events: [
          event("reconciliation", "definite_failure"),
          event("provider_result", "outcome_unknown"),
        ],
        now,
      }),
    ).toBeNull();
    expect(
      classifySmsAttemptForOps({
        createdAt: new Date("2026-08-09T00:55:00Z"),
        events: [],
        now,
      }),
    ).toBeNull();
  });
});

describe("independent ledger reservation", () => {
  it("retains scalar and tenant FKs to a durably precommitted communication", () => {
    const communicationForeignKeys = getTableConfig(smsSendAttempts)
      .foreignKeys.filter((foreignKey) =>
        foreignKey
          .reference()
          .columns.some((column) => column.name === "communication_id"),
      )
      .map((foreignKey) => foreignKey.getName());

    expect(communicationForeignKeys).toEqual(
      expect.arrayContaining([
        "sms_send_attempts_communication_id_communications_id_fk",
        "sms_send_attempts_communication_tenant_fk",
      ]),
    );
  });
});

describe("durable SMS dispatch", () => {
  it("blocks a held practice before resolving a sender or reserving delivery", async () => {
    mocks.practiceAllowsExternalSideEffects.mockResolvedValueOnce(false);

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: "recovery hold",
    });
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("keeps hosted sending default-off before DB or provider work", async () => {
    mocks.billingEnforced.mockReturnValue(true);

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("requires explicit hosted practice, location, and client scope", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      sendSms({
        to: "+15555550199",
        body: "Reminder",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Hosted SMS requires an explicit consented client.",
    });

    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("rejects non-Telnyx and console hosted transports before dispatch", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    const twilioSend = vi.fn();
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({ from: "+15555550100" }, "twilio", twilioSend),
    );

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      error:
        "Hosted texting is available only through the approved Telnyx pilot.",
    });
    expect(twilioSend).not.toHaveBeenCalled();

    const consoleSend = vi.fn();
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport({}, "console", consoleSend),
    );
    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:hosted-console",
          sourceId: "hosted-console",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error:
        "Hosted texting is available only through the approved Telnyx pilot.",
    });
    expect(consoleSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("rechecks current consent and phone after sender resolution", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    state().clientRows.splice(0, 1, {
      phone: "+15555550198",
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error:
        "Client SMS consent or phone changed before sending; delivery was blocked.",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("rechecks quiet hours at the final hosted provider boundary", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.isQuietHours.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: "SMS delivery is blocked during local quiet hours (9 PM–8 AM).",
    });

    expect(mocks.isQuietHours).toHaveBeenCalledTimes(2);
    expect(mocks.isQuietHours).toHaveBeenLastCalledWith(
      expect.any(Date),
      undefined,
    );
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("rechecks the complete hosted rollout scope at the final provider boundary", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    mocks.isQuietHours.mockImplementationOnce(() => {
      process.env.MESSAGING_SENDING_ENABLED = "false";
      return false;
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error:
        "Texting is not enabled for this clinic pilot. Contact OpenVPM support.",
    });

    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("dispatches hosted SMS only after JIT consent and suppression checks", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    state().clientRows[0]!.phone = "(555) 555-0199";
    mocks.providerSend.mockResolvedValue({
      status: "accepted",
      id: "sms-hosted-1",
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      sid: "sms-hosted-1",
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
    expect(state().selectedTables).toContain("clients");
    expect(state().selectedTables).toContain("sms_suppressions");
  });

  it("persists accepted outcome and linked communication projection together", async () => {
    mocks.providerSend.mockResolvedValue({
      status: "accepted",
      id: "sms-atomic-1",
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      sid: "sms-atomic-1",
    });
    expect(state().events.at(-1)).toMatchObject({
      kind: "provider_result",
      outcome: "accepted",
      providerMessageId: "sms-atomic-1",
    });
    expect(state().updates).toContainEqual({
      status: "sent",
      providerMessageId: "sms-atomic-1",
    });
  });

  it("returns unknown and alerts if an accepted outcome cannot project", async () => {
    state().communicationProjection.available = false;
    mocks.providerSend.mockResolvedValue({
      status: "accepted",
      id: "sms-unprojected-1",
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      error: expect.stringContaining("could not be persisted"),
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS provider outcome requires reconciliation",
      expect.stringContaining(`communication=${COMMUNICATION_ID}`),
    );
  });

  it("rechecks active location sender and carrier campaign at dispatch", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    state().locationMessagingRows[0]!.enabled = false;

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("sender changed or became inactive"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();

    const nextState = createLedgerDb();
    nextState.registrations.push({
      displayName: "Neighborhood Veterinary",
      providerCampaignId: null,
      providerBrandId: "brand-1",
    });
    mocks.tx = nextState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = nextState;
    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:inactive-campaign",
          sourceId: "inactive-campaign",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("carrier campaign changed"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();

    const mismatchedState = createLedgerDb();
    mismatchedState.registrations.push({
      displayName: "Neighborhood Veterinary",
      providerCampaignId: "campaign-2",
      providerBrandId: "brand-1",
    });
    mocks.tx = mismatchedState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = mismatchedState;
    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:mismatched-campaign",
          sourceId: "mismatched-campaign",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("carrier campaign changed"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("blocks JIT suppression and fails closed if that query errors", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    state().suppressionRows.push({ id: "suppression-1" });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: "Recipient has opted out of SMS (STOP).",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();

    const nextState = createLedgerDb();
    nextState.registrations.push({
      displayName: "Neighborhood Veterinary",
      providerCampaignId: "campaign-1",
      providerBrandId: "brand-1",
    });
    nextState.throwOnSelect.set(
      "sms_suppressions",
      new Error("suppression database unavailable"),
    );
    mocks.tx = nextState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = nextState;

    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:suppression-error",
          sourceId: "suppression-error",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      error: expect.stringContaining("could not be persisted"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("serializes STOP revocation ahead of the hosted consent recheck", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);

    const revokeReachedWrite = deferred();
    const allowRevokeCommit = deferred();
    const sendWaitingForRecipient = deferred();
    let recipientLocked = false;
    const recipientWaiters: Array<() => void> = [];
    const acquireRecipient = async (): Promise<undefined> => {
      if (!recipientLocked) {
        recipientLocked = true;
        return undefined;
      }
      sendWaitingForRecipient.resolve();
      await new Promise<void>((resolve) => recipientWaiters.push(resolve));
      recipientLocked = true;
      return undefined;
    };
    const releaseRecipient = () => {
      recipientLocked = false;
      recipientWaiters.shift()?.();
    };

    const revokeTx = {
      execute: vi.fn(acquireRecipient),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ id: "consent-event-1" }],
          }),
          onConflictDoUpdate: async () => undefined,
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              revokeReachedWrite.resolve();
              await allowRevokeCommit.promise;
              return [{ id: CLIENT_ID }];
            },
          }),
        }),
      }),
    };
    const revokePromise = (async () => {
      const result = await revokeSmsConsentByPhoneInTransaction(
        revokeTx as never,
        {
          practiceId: PRACTICE_ID,
          phone: "+15555550199",
          reason: "manual",
          evidence: {
            source: "staff_manual_revoke:v1",
            actorType: "staff",
            actorUserId: ACTOR_ID,
            actorName: "Operator",
            eventKey: "staff:test-race",
          },
        },
      );
      state().clientRows.splice(0, 1, {
        phone: "+15555550199",
        smsConsent: false,
        smsConsentAt: null,
        smsConsentSource: null,
        smsConsentDisclosure: null,
      });
      state().suppressionRows.push({ id: "suppression-1" });
      releaseRecipient();
      return result;
    })();
    await revokeReachedWrite.promise;
    mocks.acquireSmsRecipientLockInTransaction.mockImplementation(
      acquireRecipient,
    );

    const sendPromise = sendSms(sendOptions());
    await sendWaitingForRecipient.promise;
    expect(mocks.providerSend).not.toHaveBeenCalled();

    allowRevokeCommit.resolve();
    await expect(revokePromise).resolves.toEqual({
      phone: "+15555550199",
      clientsRevoked: 1,
    });
    await expect(sendPromise).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("fails closed when hosted practice entitlement is missing or inactive", async () => {
    allowHostedPilot();
    mocks.billingEnforced.mockReturnValue(true);
    state().practiceRows.splice(0);

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: "Practice not found",
    });
    expect(mocks.hasHostedFullAccess).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();

    const nextState = createLedgerDb();
    nextState.registrations.push({
      displayName: "Neighborhood Veterinary",
      providerCampaignId: "campaign-1",
      providerBrandId: "brand-1",
    });
    mocks.tx = nextState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = nextState;
    mocks.hasHostedFullAccess.mockReturnValue(false);

    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:inactive-practice",
          sourceId: "inactive-practice",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("read-only"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("normalizes recipients and rejects invalid phones before any work", async () => {
    mocks.providerSend.mockResolvedValue({ status: "accepted", id: "sms-1" });

    await expect(
      sendSms(sendOptions({ to: " (555) 555-0199 " })),
    ).resolves.toMatchObject({ success: true, sid: "sms-1" });
    expect(mocks.providerSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: `Neighborhood Veterinary: Miso's prescription is ready for pickup. ${SMS_COMPLIANCE_FOOTER}`,
      sender: { from: "+15555550100" },
    });

    vi.clearAllMocks();
    await expect(sendSms(sendOptions({ to: "12345" }))).resolves.toMatchObject({
      success: false,
      error:
        "SMS recipient phone number must be a valid E.164 or US/CA number.",
    });
    expect(mocks.resolveMessagingTransport).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("meters only accepted real sends and awaits metering", async () => {
    const usage = deferred<undefined>();
    mocks.providerSend.mockResolvedValue({ status: "accepted", id: "sms-1" });
    mocks.recordUsage.mockReturnValueOnce(usage.promise);
    let settled = false;
    const sendPromise = sendSms(sendOptions()).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(mocks.recordUsage).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    usage.resolve(undefined);
    await expect(sendPromise).resolves.toMatchObject({
      success: true,
      sid: "sms-1",
    });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      kind: "sms",
    });
  });

  it("never turns accepted-send metering failure into a retry signal", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.providerSend.mockResolvedValue({ status: "accepted", id: "sms-1" });
    mocks.recordUsage.mockRejectedValueOnce(new Error("meter unavailable"));

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      sid: "sms-1",
    });
    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      sid: "sms-1",
      replayed: true,
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
    expect(mocks.recordUsage).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[messaging] accepted SMS usage metering failed",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("does not meter definite failures, unknown outcomes, or console sends", async () => {
    mocks.providerSend.mockResolvedValueOnce({
      status: "definite_failure",
      error: "Provider rejected",
    });
    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();

    const nextState = createLedgerDb();
    mocks.tx = nextState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = nextState;
    mocks.providerSend.mockResolvedValueOnce({
      status: "outcome_unknown",
      error: "Provider timed out",
    });
    await expect(
      sendSms(
        sendOptions({
          idempotencyKey: "sms:inbox:unknown-meter",
          sourceId: "unknown-meter",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "outcome_unknown" });
    expect(mocks.recordUsage).not.toHaveBeenCalled();

    const consoleState = createLedgerDb();
    mocks.tx = consoleState.tx;
    mocks.withSystem.mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
    );
    (globalThis as Record<string, unknown>).__smsLedgerState = consoleState;
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });
    mocks.resolveMessagingTransport.mockResolvedValue(transport({}, "console"));
    mocks.providerSend.mockResolvedValueOnce({
      status: "accepted",
      id: "console-1",
    });
    await expect(
      sendSms({
        to: "+15555550199",
        body: "Console reminder",
        practiceId: PRACTICE_ID,
        idempotencyKey: "sms:console:1",
      }),
    ).resolves.toMatchObject({ success: true, sid: "console-1" });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("allows safe console sending in hosted demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", " true ");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.getMessagingProvider.mockReturnValue({
      name: "console",
      isConfigured: () => true,
      send: mocks.providerSend,
    });
    mocks.resolveMessagingTransport.mockResolvedValue(transport({}, "console"));
    mocks.providerSend.mockResolvedValue({
      status: "accepted",
      id: "console-demo-1",
    });

    await expect(
      sendSms({
        to: "+15555550199",
        body: "Demo reminder",
        practiceId: PRACTICE_ID,
        idempotencyKey: "sms:demo:1",
      }),
    ).resolves.toMatchObject({ success: true, sid: "console-demo-1" });
    expect(mocks.providerSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: `Neighborhood Veterinary: Demo reminder ${SMS_COMPLIANCE_FOOTER}`,
      sender: {},
    });
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it("fails closed for an explicit location without an active sender", async () => {
    mocks.resolveMessagingTransport.mockResolvedValue(undefined);

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      error: "No active texting sender is configured for this location.",
    });
    expect(mocks.getMessagingProvider).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("classifies escaped pre-reservation setup errors as definite failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.resolveMessagingTransport.mockRejectedValue(
      new Error("sender lookup unavailable"),
    );

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: "SMS could not be prepared; send blocked.",
    });
    expect(state().attempts).toHaveLength(0);
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("dispatches explicit locations through their persisted provider and sender", async () => {
    const twilioSend = vi.fn().mockResolvedValue({
      status: "accepted",
      id: "SM-location",
    });
    mocks.resolveMessagingTransport.mockResolvedValue(
      transport(
        { messagingServiceId: "MG-location", from: "+15555550122" },
        "twilio",
        twilioSend,
      ),
    );
    state().locationMessagingRows.splice(0, 1, {
      provider: "twilio",
      messagingServiceId: "MG-location",
      senderE164: "+15555550122",
      enabled: true,
      registrationStatus: "active",
    });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      sid: "SM-location",
    });
    expect(mocks.getMessagingProvider).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(twilioSend).toHaveBeenCalledWith({
      to: "+15555550199",
      body: `Neighborhood Veterinary: Miso's prescription is ready for pickup. ${SMS_COMPLIANCE_FOOTER}`,
      sender: {
        messagingServiceId: "MG-location",
        from: "+15555550122",
      },
    });
  });

  it("preserves provider ids and canonical bodies through reminder helpers", async () => {
    mocks.providerSend
      .mockResolvedValueOnce({ status: "accepted", id: "sms-reminder-1" })
      .mockResolvedValueOnce({ status: "accepted", id: "sms-vax-1" });

    await expect(
      sendAppointmentReminderSms({
        to: "+15555550199",
        patientName: "Miso",
        appointmentDate: "August 12",
        appointmentTime: "9:00 AM",
        practiceName: "Stale Caller Name",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
        idempotencyKey: "sms:appointment:1",
      }),
    ).resolves.toMatchObject({ success: true, sid: "sms-reminder-1" });
    await expect(
      sendVaccinationReminderSms({
        to: "+15555550199",
        patientName: "Miso",
        vaccineName: "Rabies",
        practiceName: "Stale Caller Name",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
        idempotencyKey: "sms:vaccination:1",
      }),
    ).resolves.toMatchObject({ success: true, sid: "sms-vax-1" });

    expect(mocks.providerSend).toHaveBeenNthCalledWith(1, {
      to: "+15555550199",
      body: `Neighborhood Veterinary: Reminder: Miso has an appointment on August 12 at 9:00 AM. Contact us to reschedule. ${SMS_COMPLIANCE_FOOTER}`,
      sender: { from: "+15555550100" },
    });
    expect(mocks.providerSend).toHaveBeenNthCalledWith(2, {
      to: "+15555550199",
      body: `Neighborhood Veterinary: Miso is due for their Rabies vaccination. Contact us to schedule. ${SMS_COMPLIANCE_FOOTER}`,
      sender: { from: "+15555550100" },
    });
  });

  it("allows only the reservation winner to call the provider", async () => {
    let resolveProvider!: (value: { status: "accepted"; id: string }) => void;
    mocks.providerSend.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
    );

    const first = sendSms(sendOptions());
    await vi.waitFor(() => expect(mocks.providerSend).toHaveBeenCalledOnce());
    const second = await sendSms(sendOptions());

    expect(second).toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      replayed: true,
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();

    resolveProvider({ status: "accepted", id: "msg-1" });
    await expect(first).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      sid: "msg-1",
    });
    expect(state().attempts).toHaveLength(1);
    expect(state().events).toHaveLength(1);
  });

  it("persists missing provider ids as unknown and never retries them", async () => {
    mocks.providerSend.mockResolvedValue({ status: "accepted", id: "   " });

    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "outcome_unknown",
    });
    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      replayed: true,
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
    expect(mocks.alertOps).toHaveBeenCalledOnce();
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS provider outcome requires reconciliation",
      `practice=${PRACTICE_ID} attempt=${state().attempts[0]!.id} communication=${COMMUNICATION_ID} source=inbox`,
    );
    expect(JSON.stringify(mocks.alertOps.mock.calls)).not.toContain(
      "+15555550199",
    );
    expect(JSON.stringify(mocks.alertOps.mock.calls)).not.toContain(
      "prescription",
    );
  });

  it("blocks an idempotency replay onto a different communication", async () => {
    mocks.providerSend.mockResolvedValue({ status: "accepted", id: "msg-1" });
    await expect(sendSms(sendOptions())).resolves.toMatchObject({
      success: true,
      sid: "msg-1",
    });

    await expect(
      sendSms(
        sendOptions({
          communicationId: "00000000-0000-0000-0000-0000000000de",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      replayed: true,
      error: expect.stringContaining("different dispatch data"),
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
  });

  it("blocks a fresh communication from bypassing recent ambiguity", async () => {
    mocks.providerSend.mockResolvedValueOnce({
      status: "outcome_unknown",
      error: "gateway timed out",
    });
    await sendSms(sendOptions());

    await expect(
      sendSms(
        sendOptions({
          communicationId: "00000000-0000-0000-0000-0000000000de",
          sourceId: "00000000-0000-0000-0000-0000000000de",
          idempotencyKey: "sms:inbox:00000000-0000-0000-0000-0000000000de",
        }),
      ),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("unresolved provider outcome"),
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
  });

  it("reconciles only stale ambiguous attempts without a provider call", async () => {
    const ledger = state();
    ledger.attempts.push({
      ...sendOptions(),
      id: "00000000-0000-0000-0000-000000000001",
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:ambiguous:1",
      resendOfAttemptId: null,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000001",
      createdAt: new Date(Date.now() - 19 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: ledger.attempts[0]!.id,
      kind: "provider_result",
      outcome: "outcome_unknown",
      providerMessageId: null,
      detail: "timeout",
      eventKey: "provider-result:1",
    });

    await expect(
      reconcileSmsSendAttempt({
        practiceId: PRACTICE_ID,
        attemptId: ledger.attempts[0]!.id,
        outcome: "accepted",
        providerMessageId: "msg-reconciled",
        detail: "Confirmed in provider console.",
        actorType: "platform_operator",
        actorUserId: ACTOR_ID,
        actorIdentity: "ops@openvpm.com",
        actorName: "OpenVPM Ops",
        reconciliationKey: "operator-reconciliation:1",
      }),
    ).resolves.toMatchObject({ success: true, sid: "msg-reconciled" });
    expect(mocks.providerSend).not.toHaveBeenCalled();
    expect(ledger.events.at(-1)).toMatchObject({
      kind: "reconciliation",
      actorType: "platform_operator",
      actorIdentity: "ops@openvpm.com",
    });
  });

  it("keeps reconciliation durable and alerts when communication projection misses", async () => {
    const ledger = state();
    ledger.communicationProjection.available = false;
    ledger.attempts.push({
      ...sendOptions(),
      id: "00000000-0000-0000-0000-000000000011",
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:ambiguous:projection-miss",
      resendOfAttemptId: null,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000011",
      createdAt: new Date(Date.now() - 19 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: ledger.attempts[0]!.id,
      kind: "provider_result",
      outcome: "outcome_unknown",
      providerMessageId: null,
      detail: "timeout",
      eventKey: "provider-result:projection-miss",
    });

    await expect(
      reconcileSmsSendAttempt({
        practiceId: PRACTICE_ID,
        attemptId: ledger.attempts[0]!.id,
        outcome: "definite_failure",
        detail: "Provider confirmed rejection.",
        actorType: "platform_operator",
        actorUserId: ACTOR_ID,
        actorIdentity: "ops@openvpm.com",
        actorName: "OpenVPM Ops",
        reconciliationKey: "operator-reconciliation:projection-miss",
      }),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
    });
    expect(ledger.events.at(-1)).toMatchObject({ kind: "reconciliation" });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "SMS reconciliation projection requires review",
      expect.stringContaining(`communication=${COMMUNICATION_ID}`),
    );
  });

  it("projects an accepted explicit resend onto its communication", async () => {
    const ledger = state();
    ledger.communicationRows[0]!.status = "failed";
    ledger.attempts.push({
      ...sendOptions(),
      id: "00000000-0000-0000-0000-000000000002",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:failed:1",
      resendOfAttemptId: null,
      destinationE164: "+15555550199",
      registeredDisplayName: "Neighborhood Veterinary",
      provider: "telnyx",
      senderE164: "+15555550100",
      senderMessagingServiceId: null,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      communicationId: COMMUNICATION_ID,
      body: `Neighborhood Veterinary: Ready. ${SMS_COMPLIANCE_FOOTER}`,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000002",
      createdAt: new Date(Date.now() - 59 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: ledger.attempts[0]!.id,
      kind: "provider_result",
      outcome: "definite_failure",
      providerMessageId: null,
      detail: "rejected",
      eventKey: "provider-result:2",
    });
    mocks.providerSend.mockResolvedValue({
      status: "accepted",
      id: "msg-resend",
    });

    await expect(
      resendSmsAttempt({
        practiceId: PRACTICE_ID,
        attemptId: ledger.attempts[0]!.id,
        idempotencyKey: "sms:operator-resend:1",
        actorType: "platform_operator",
        actorUserId: ACTOR_ID,
        actorIdentity: "ops@openvpm.com",
        actorName: "OpenVPM Ops",
      }),
    ).resolves.toMatchObject({ success: true, sid: "msg-resend" });
    expect(ledger.attempts[1]).toMatchObject({
      resendOfAttemptId: ledger.attempts[0]!.id,
      requestedByActorType: "platform_operator",
      requestedByIdentity: "ops@openvpm.com",
    });
    expect(ledger.updates).toContainEqual({
      status: "sent",
      providerMessageId: "msg-resend",
    });
  });

  it("blocks explicit resend after a linked email fallback was delivered", async () => {
    const ledger = state();
    ledger.communicationRows[0]!.status = "sent";
    ledger.attempts.push({
      ...sendOptions(),
      id: "00000000-0000-0000-0000-000000000012",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:failed:fallback-delivered",
      resendOfAttemptId: null,
      destinationE164: "+15555550199",
      registeredDisplayName: "Neighborhood Veterinary",
      provider: "telnyx",
      senderE164: "+15555550100",
      senderMessagingServiceId: null,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      communicationId: COMMUNICATION_ID,
      body: `Neighborhood Veterinary: Ready. ${SMS_COMPLIANCE_FOOTER}`,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000012",
      createdAt: new Date(Date.now() - 59 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: ledger.attempts[0]!.id,
      kind: "provider_result",
      outcome: "definite_failure",
      providerMessageId: null,
      detail: "rejected",
      eventKey: "provider-result:fallback-delivered",
    });

    await expect(
      resendSmsAttempt({
        practiceId: PRACTICE_ID,
        attemptId: ledger.attempts[0]!.id,
        idempotencyKey: "sms:operator-resend:fallback-delivered",
        actorType: "platform_operator",
        actorUserId: ACTOR_ID,
        actorIdentity: "ops@openvpm.com",
        actorName: "OpenVPM Ops",
      }),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("must be definitively failed"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("rechecks and locks failed communication state at resend dispatch", async () => {
    const ledger = state();
    ledger.communicationRows[0]!.status = "failed";
    ledger.attempts.push({
      ...sendOptions(),
      id: "00000000-0000-0000-0000-000000000013",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:failed:fallback-race",
      resendOfAttemptId: null,
      destinationE164: "+15555550199",
      registeredDisplayName: "Neighborhood Veterinary",
      provider: "telnyx",
      senderE164: "+15555550100",
      senderMessagingServiceId: null,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      communicationId: COMMUNICATION_ID,
      body: `Neighborhood Veterinary: Ready. ${SMS_COMPLIANCE_FOOTER}`,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000013",
      createdAt: new Date(Date.now() - 59 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: ledger.attempts[0]!.id,
      kind: "provider_result",
      outcome: "definite_failure",
      providerMessageId: null,
      detail: "rejected",
      eventKey: "provider-result:fallback-race",
    });
    mocks.resolveMessagingTransport.mockImplementation(async () => {
      // Simulate an email fallback becoming terminal after the eligibility
      // read but before the child attempt reaches its provider boundary.
      ledger.communicationRows[0]!.status = "sent";
      return transport({ from: "+15555550100" });
    });

    await expect(
      resendSmsAttempt({
        practiceId: PRACTICE_ID,
        attemptId: ledger.attempts[0]!.id,
        idempotencyKey: "sms:operator-resend:fallback-race",
        actorType: "platform_operator",
        actorUserId: ACTOR_ID,
        actorIdentity: "ops@openvpm.com",
        actorName: "OpenVPM Ops",
      }),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("no longer failed"),
    });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("allows only one child attempt and provider call for concurrent resend keys", async () => {
    const ledger = state();
    ledger.communicationRows[0]!.status = "failed";
    const originalAttemptId = "00000000-0000-0000-0000-000000000003";
    ledger.attempts.push({
      ...sendOptions(),
      id: originalAttemptId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      practiceId: PRACTICE_ID,
      idempotencyKey: "sms:failed:concurrent",
      resendOfAttemptId: null,
      destinationE164: "+15555550199",
      registeredDisplayName: "Neighborhood Veterinary",
      provider: "telnyx",
      senderE164: "+15555550100",
      senderMessagingServiceId: null,
      clientId: CLIENT_ID,
      locationId: LOCATION_ID,
      communicationId: COMMUNICATION_ID,
      body: `Neighborhood Veterinary: Ready. ${SMS_COMPLIANCE_FOOTER}`,
    });
    ledger.events.push({
      id: "10000000-0000-0000-0000-000000000003",
      createdAt: new Date(Date.now() - 59 * 60 * 1000),
      practiceId: PRACTICE_ID,
      attemptId: originalAttemptId,
      kind: "provider_result",
      outcome: "definite_failure",
      providerMessageId: null,
      detail: "rejected",
      eventKey: "provider-result:3",
    });
    const provider = deferred<{ status: "accepted"; id: string }>();
    mocks.providerSend.mockReturnValueOnce(provider.promise);
    const resendOptions = {
      practiceId: PRACTICE_ID,
      attemptId: originalAttemptId,
      actorType: "platform_operator" as const,
      actorUserId: ACTOR_ID,
      actorIdentity: "ops@openvpm.com",
      actorName: "OpenVPM Ops",
    };

    const first = resendSmsAttempt({
      ...resendOptions,
      idempotencyKey: "sms:operator-resend:concurrent:a",
    });
    await vi.waitFor(() => expect(mocks.providerSend).toHaveBeenCalledOnce());
    const second = await resendSmsAttempt({
      ...resendOptions,
      idempotencyKey: "sms:operator-resend:concurrent:b",
    });

    expect(second).toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      replayed: true,
    });
    expect(ledger.attempts.filter((row) => row.resendOfAttemptId)).toHaveLength(
      1,
    );
    expect(mocks.providerSend).toHaveBeenCalledOnce();

    provider.resolve({ status: "accepted", id: "msg-one-child" });
    await expect(first).resolves.toMatchObject({
      success: true,
      sid: "msg-one-child",
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
  });
});
