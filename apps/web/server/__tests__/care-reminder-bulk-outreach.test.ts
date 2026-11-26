import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkCareReminderRequestId,
  careReminderBulkRateLimitKey,
  careReminderOutreachCopy,
  careReminderOutreachDedupeKey,
} from "@/lib/care-reminder-outreach";
import { careRemindersRouter } from "../routers/care-reminders";

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-4000-8000-0000000000bb";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const REMINDER_ID = "00000000-0000-4000-8000-0000000000cc";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000dd";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000ee";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000ff";
const COMMUNICATION_ID = "00000000-0000-4000-8000-000000000010";

const mocks = vi.hoisted(() => ({
  sendCareReminder: vi.fn(),
  sendCareReminderSms: vi.fn(),
  rateLimit: vi.fn(),
  recordAuditLog: vi.fn(),
  lockPracticeForExternalSideEffects: vi.fn(),
  assertOutboundEmailAllowed: vi.fn(),
  db: null as unknown,
}));

vi.mock("@/lib/email", () => ({
  sendCareReminder: mocks.sendCareReminder,
}));
vi.mock("@/lib/sms", () => ({
  sendCareReminderSms: mocks.sendCareReminderSms,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));
vi.mock("@/lib/recovery-hold", () => ({
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE:
    "This clinic is in protected recovery mode. External delivery and automated changes remain paused until OpenVPM completes recovery reconciliation.",
}));
vi.mock("@/lib/outbound-email-security", () => ({
  assertOutboundEmailAllowed: mocks.assertOutboundEmailAllowed,
}));
vi.mock("@/lib/messaging/durable-sms-communication", () => ({
  withDurableSmsCommunication: async (
    _practiceId: string,
    fn: (db: unknown) => Promise<unknown>,
  ) => fn(mocks.db),
  recoverStaleUnreservedSmsCommunication: vi.fn(async () => null),
  STALE_SMS_COMMUNICATION_CLAIM_MS: 15 * 60 * 1000,
}));

function queueDb(selects: unknown[][]) {
  let selectIndex = 0;
  const updates: unknown[] = [];
  const db = {
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => {
      const result = selects[selectIndex++] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.from = vi.fn(self);
      chain.innerJoin = vi.fn(self);
      chain.leftJoin = vi.fn(self);
      chain.where = vi.fn(self);
      chain.orderBy = vi.fn(self);
      chain.limit = vi.fn(async () => result);
      chain.for = vi.fn(async () => result);
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        const pending = Promise.resolve(undefined);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: COMMUNICATION_ID }]),
          })),
          then: pending.then.bind(pending),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updates.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  mocks.db = db;
  return { db, updates };
}

function caller(
  db: ReturnType<typeof queueDb>["db"],
  role: "veterinarian" | "viewer" = "veterinarian",
) {
  return careRemindersRouter.createCaller({
    db,
    ip: "203.0.113.8",
    session: {
      user: {
        id: USER_ID,
        email: "doctor@example.test",
        name: "Dr. Rivera",
        role,
        practiceId: PRACTICE_ID,
        emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        practiceCreatedAt: new Date("2025-01-01T00:00:00.000Z"),
        practiceInPreview: false,
      },
    },
  } as never);
}

function practiceRow() {
  return {
    id: PRACTICE_ID,
    name: "River Clinic",
    phone: "415-555-1212",
    address: null,
    timezone: "America/New_York",
    settings: {},
  };
}

function reminderRow(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: REMINDER_ID,
    practiceId: PRACTICE_ID,
    title: "Dental recheck",
    dueDate: "2026-01-01",
    status: "open",
    imported: true,
    patientName: "River",
    patientStatus: "active",
    species: "canine",
    patientId: PATIENT_ID,
    clientId: CLIENT_ID,
    clientFirstName: "Ada",
    clientLastName: "Lovelace",
    clientEmail: "ada@river-clinic.com",
    clientPhone: "+14155551212",
    preferredContactMethod: "email",
    clientSmsConsent: false,
    emailSuppressionReason: null,
    lastContactedAt: null,
    ...overrides,
  };
}

function emailDedupeKey() {
  const copy = careReminderOutreachCopy({
    clientName: "Ada Lovelace",
    patientName: "River",
    title: "Dental recheck",
    dueDate: "2026-01-01",
    timeZone: "America/New_York",
  });
  return careReminderOutreachDedupeKey(
    PRACTICE_ID,
    "email",
    bulkCareReminderRequestId({
      reminderId: REMINDER_ID,
      channel: "email",
      subject: copy.subject,
      content: copy.content,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 3,
    resetAt: new Date("2026-11-19T15:00:00.000Z"),
  });
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.assertOutboundEmailAllowed.mockResolvedValue(undefined);
  mocks.recordAuditLog.mockResolvedValue(undefined);
  mocks.sendCareReminder.mockResolvedValue({ success: true, id: "email_1" });
  mocks.sendCareReminderSms.mockResolvedValue({
    success: true,
    outcome: "accepted",
    sid: "SM1",
    attemptId: "attempt-1",
    replayed: false,
  });
});

describe("bulk care reminder outreach router", () => {
  it("rejects a reminder that belongs to another clinic before any provider call", async () => {
    const { db } = queueDb([
      [practiceRow()],
      [reminderRow({ practiceId: OTHER_PRACTICE_ID })],
    ]);

    await expect(
      caller(db).sendOutreach({
        reminderId: REMINDER_ID,
        channel: "email",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
    expect(mocks.sendCareReminderSms).not.toHaveBeenCalled();
  });

  it("counts another clinic's ids as blocked and does not send them", async () => {
    const { db } = queueDb([
      [practiceRow()],
      [reminderRow({ practiceId: OTHER_PRACTICE_ID })],
      [],
      [],
    ]);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "auto" },
        reminderIds: [REMINDER_ID],
      }),
    ).resolves.toEqual({ sent: 0, failed: 0, blocked: 1, deduped: 0 });
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: careReminderBulkRateLimitKey(PRACTICE_ID),
      limit: 4,
      windowMs: 60 * 60 * 1000,
    });
  });

  it("stops the batch when the clinic is over its hourly limit", async () => {
    const { db } = queueDb([]);
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-11-19T15:00:00.000Z"),
    });

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "email" },
        reminderIds: [REMINDER_ID],
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(mocks.lockPracticeForExternalSideEffects).not.toHaveBeenCalled();
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
  });

  it("dedupes a reminder that was already sent with the same wording", async () => {
    const { db } = queueDb([
      [practiceRow()],
      [reminderRow()],
      [],
      [],
      [
        {
          dedupeKey: emailDedupeKey(),
          status: "sent",
          createdAt: new Date("2026-02-01T15:00:00.000Z"),
          updatedAt: new Date("2026-02-01T15:00:00.000Z"),
          channel: "email",
          hasSmsAttempt: false,
        },
      ],
    ]);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "auto" },
        reminderIds: [REMINDER_ID],
      }),
    ).resolves.toEqual({ sent: 0, failed: 0, blocked: 0, deduped: 1 });
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: USER_ID,
        path: "careReminders.bulkOutreach",
        resultData: { sent: 0, failed: 0, blocked: 0, deduped: 1 },
      }),
    );
  });

  it("sends through the email provider and records the batch", async () => {
    const { db, updates } = queueDb([
      [practiceRow()],
      [reminderRow()],
      [],
      [],
      [],
    ]);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "email" },
        reminderIds: [REMINDER_ID],
      }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });
    expect(mocks.sendCareReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@river-clinic.com",
        patientName: "River",
        reminderTitle: "Dental recheck",
      }),
    );
    expect(mocks.sendCareReminderSms).not.toHaveBeenCalled();
    expect(updates).toContainEqual(
      expect.objectContaining({ status: "sent", providerMessageId: "email_1" }),
    );
  });

  it("does not text an imported reminder that has no current SMS consent", async () => {
    const { db } = queueDb([
      [practiceRow()],
      [
        reminderRow({
          imported: true,
          clientEmail: null,
          clientSmsConsent: false,
          preferredContactMethod: "sms",
        }),
      ],
      [{ locationId: "00000000-0000-4000-8000-000000000021" }],
      [],
      [],
    ]);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "sms" },
        reminderIds: [REMINDER_ID],
      }),
    ).resolves.toEqual({ sent: 0, failed: 0, blocked: 1, deduped: 0 });
    expect(mocks.sendCareReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
  });

  it("refuses the batch while the clinic is on a recovery hold", async () => {
    const { db } = queueDb([]);
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "email" },
        selectAllMatching: true,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
  });

  it("re-checks every matching reminder when staff choose select all", async () => {
    const { db } = queueDb([
      [practiceRow()],
      [reminderRow()],
      [],
      [],
      [],
    ]);

    await expect(
      caller(db).sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "email" },
        selectAllMatching: true,
      }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });
    expect(mocks.sendCareReminder).toHaveBeenCalledTimes(1);
  });

  it("sends a text only through the SMS provider when consent is current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T20:00:00.000Z"));
    const { db } = queueDb([
      [practiceRow()],
      [
        reminderRow({
          clientEmail: null,
          clientSmsConsent: true,
          preferredContactMethod: "sms",
          imported: true,
        }),
      ],
      [{ locationId: "00000000-0000-4000-8000-000000000021" }],
      [],
      [],
    ]);

    try {
      await expect(
        caller(db).sendBulkOutreach({
          filters: { due: "overdue", lastContacted: "any", channel: "sms" },
          reminderIds: [REMINDER_ID],
        }),
      ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.sendCareReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+14155551212",
        patientName: "River",
        reminderTitle: "Dental recheck",
        practiceId: PRACTICE_ID,
      }),
    );
    expect(mocks.sendCareReminder).not.toHaveBeenCalled();
  });

  it("hides bulk outreach from read-only staff", async () => {
    const { db } = queueDb([]);
    await expect(
      caller(db, "viewer").sendBulkOutreach({
        filters: { due: "overdue", lastContacted: "any", channel: "email" },
        reminderIds: [REMINDER_ID],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
});
