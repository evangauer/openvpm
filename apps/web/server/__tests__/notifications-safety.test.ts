import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  sendAppointmentReminder: vi.fn(
    async (): Promise<{
      success: boolean;
      id?: string;
      error?: string;
      outcome?: "accepted" | "definite_failure" | "outcome_unknown";
    }> => ({ success: true }),
  ),
  sendInvoiceEmail: vi.fn(async () => ({
    success: true,
    id: undefined as string | undefined,
    error: undefined as string | undefined,
  })),
  sendVaccinationReminder: vi.fn(async () => ({
    success: true,
    id: undefined as string | undefined,
    error: undefined as string | undefined,
  })),
  sendAppointmentReminderSms: vi.fn(async () => ({
    success: true,
    sid: undefined as string | undefined,
    error: undefined as string | undefined,
  })),
  sendVaccinationReminderSms: vi.fn(async () => ({
    success: true,
    sid: undefined as string | undefined,
    error: undefined as string | undefined,
  })),
  recordAuditLog: vi.fn(async () => undefined),
  alertOps: vi.fn(async () => undefined),
  durableDb: {} as Record<string, unknown>,
  withDurableSmsCommunication: vi.fn(),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
  assertOutboundEmailAllowed: vi.fn(async () => undefined),
}));

vi.mock("@/lib/email", () => ({
  sendAppointmentReminder: mocks.sendAppointmentReminder,
  sendInvoiceEmail: mocks.sendInvoiceEmail,
  sendVaccinationReminder: mocks.sendVaccinationReminder,
}));

vi.mock("@/lib/sms", () => ({
  sendAppointmentReminderSms: mocks.sendAppointmentReminderSms,
  sendVaccinationReminderSms: mocks.sendVaccinationReminderSms,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));

vi.mock("@/lib/messaging/durable-sms-communication", () => ({
  withDurableSmsCommunication: mocks.withDurableSmsCommunication,
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));

vi.mock("@/lib/outbound-email-security", () => ({
  assertOutboundEmailAllowed: mocks.assertOutboundEmailAllowed,
}));

const { REMINDER_BATCH_MAX_TARGETS, notificationsRouter } =
  await import("../routers/notifications");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const STALE_APPOINTMENT_ID = "00000000-0000-0000-0000-000000000004";
const PATIENT_ID = "00000000-0000-0000-0000-000000000005";
const STALE_PATIENT_ID = "00000000-0000-0000-0000-000000000006";
const INVOICE_ID = "00000000-0000-0000-0000-000000000007";
const LOCATION_ID = "00000000-0000-0000-0000-000000000008";
const SECOND_LOCATION_ID = "00000000-0000-0000-0000-000000000012";
const VACCINATION_RECORD_ID = "00000000-0000-0000-0000-000000000009";
const SECOND_VACCINATION_RECORD_ID = "00000000-0000-0000-0000-000000000010";
const COMMUNICATION_ID = "00000000-0000-0000-0000-000000000011";
const PRACTICE_SETTINGS = {
  name: "Neighborhood Veterinary",
  phone: "555-0100",
  timezone: "America/Los_Angeles",
  currency: "usd",
  country: "US",
};

function callerWithDb(db: Record<string, unknown>) {
  mocks.durableDb = db;
  mocks.withDurableSmsCommunication.mockImplementation(
    (_practiceId: string, fn: (durableDb: unknown) => unknown) =>
      fn(mocks.durableDb),
  );
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return notificationsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  practiceRows?: unknown[];
  claimResults?: unknown[][];
  reclaimResults?: unknown[][];
}) {
  const selectResults = [
    opts?.practiceRows ?? [{ id: PRACTICE_ID }],
    ...(opts?.selectResults ?? []),
  ];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const claimResults = [...(opts?.claimResults ?? [])];
  const reclaimResults = [...(opts?.reclaimResults ?? [])];
  const insertReturning = vi.fn(
    async () => claimResults.shift() ?? [{ id: COMMUNICATION_ID }],
  );
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({
    onConflictDoNothing,
    then: (
      resolve: (value: undefined) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(undefined).then(resolve, reject),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateReturning = vi.fn(async () => reclaimResults.shift() ?? []);
  const updateWhere = vi.fn(() => ({
    returning: updateReturning,
    then: (
      resolve: (value: undefined) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(undefined).then(resolve, reject),
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return {
    db,
    select,
    insertValues,
    insertReturning,
    updateSet,
    updateReturning,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Noon in Los Angeles / 3 PM in New York: outside SMS quiet hours.
  vi.setSystemTime(new Date("2026-07-01T19:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("notification target safety", () => {
  it("rejects notification reads and sends when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ practiceRows: [] });
    const caller = callerWithDb(db);

    await expect(
      caller.sendAppointmentReminder({ appointmentId: APPOINTMENT_ID }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.getUpcomingReminders()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.getOverdueVaccinations()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.sendInvoiceEmail).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects manual appointment reminders when active recipient joins are missing", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects manual reminders for an unconfirmed appointment request", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "scheduled",
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            preferredContactMethod: "email",
            smsConsent: false,
            practiceName: "Neighborhood Veterinary",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Confirm the appointment before sending a reminder.",
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("omits upcoming reminders filtered out by inactive recipient joins", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(callerWithDb(db).getUpcomingReminders()).resolves.toEqual([]);
  });

  it("uses an active practice sender for manual SMS appointment reminders", async () => {
    mocks.sendAppointmentReminderSms.mockResolvedValueOnce({
      success: true,
      sid: "sms-manual-1",
      error: undefined,
    });
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-01T04:30:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ success: true, channel: "sms" });

    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "(555) 555-0100",
        appointmentDate: "Tuesday, June 30, 2026",
        appointmentTime: "9:30 PM",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        status: "sent",
        providerMessageId: "sms-manual-1",
      }),
    );
    expect(mocks.withDurableSmsCommunication).toHaveBeenCalledTimes(2);
  });

  it("blocks an SMS-only manual reminder during the clinic's quiet hours", async () => {
    vi.setSystemTime(new Date("2026-07-02T05:00:00Z")); // 10 PM in Los Angeles
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-03T19:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: null,
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "SMS reminders cannot be sent during quiet hours (9 PM–8 AM local time). Try again after 8 AM.",
    });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("falls back to email instead of texting during quiet hours", async () => {
    vi.setSystemTime(new Date("2026-07-02T05:00:00Z")); // 10 PM in Los Angeles
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-03T19:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ success: true, channel: "email" });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "email", status: "pending" }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "email", status: "sent" }),
    );
  });

  it("falls back to email when manual SMS has no active practice sender", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-manual-1",
      error: undefined,
    });
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/New_York",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ success: true, channel: "email" });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
        providerMessageId: "email-manual-1",
      }),
    );
  });

  it("blocks manual appointment reminder emails to provider-suppressed recipients", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            emailSuppressionReason: "bounce",
            clientPhone: null,
            preferredContactMethod: "email",
            smsConsent: false,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Client email is suppressed after a delivery bounce. Update the client email before sending.",
    });

    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects manual SMS-only reminders when no active sender exists", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            status: "confirmed",
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: null,
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/New_York",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("counts stale or cross-tenant appointment ids as failed bulk reminders", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T04:30:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "email",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({
        appointmentIds: [APPOINTMENT_ID, STALE_APPOINTMENT_ID],
      }),
    ).resolves.toEqual({ sent: 1, failed: 1 });

    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentDate: "Tuesday, June 30, 2026",
        appointmentTime: "9:30 PM",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
      }),
    );
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "email", status: "sent" }),
    );
  });

  it("routes bulk SMS reminders through an active practice sender", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T04:30:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({
        appointmentIds: [APPOINTMENT_ID, STALE_APPOINTMENT_ID],
      }),
    ).resolves.toEqual({ sent: 1, failed: 1 });

    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledOnce();
    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "(555) 555-0100",
        appointmentDate: "Tuesday, June 30, 2026",
        appointmentTime: "9:30 PM",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      }),
    );
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", status: "sent" }),
    );
  });

  it("falls back to email for bulk SMS reminders with no active sender", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-bulk-1",
      error: undefined,
    });
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
        providerMessageId: "email-bulk-1",
      }),
    );
  });

  it("counts bulk appointment emails to suppressed recipients as failed", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            emailSuppressionReason: "complaint",
            clientPhone: null,
            preferredContactMethod: "email",
            smsConsent: false,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("preserves the pending claim when bulk SMS transport throws", async () => {
    mocks.sendAppointmentReminderSms.mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
            locationId: LOCATION_ID,
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledOnce();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        status: "pending",
      }),
    );
  });

  it("counts bulk SMS-only reminders with no active sender as failed", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: APPOINTMENT_ID,
            startTime: new Date("2026-07-01T14:00:00Z"),
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: null,
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
            practiceName: "Neighborhood Veterinary",
            practicePhone: "555-0100",
            practiceTimezone: "America/Los_Angeles",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("counts all-missing appointment ids as failed without sending", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).sendBulkReminders({
        appointmentIds: [STALE_APPOINTMENT_ID],
      }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects oversized bulk reminder batches before DB work", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).sendBulkReminders({
        appointmentIds: Array.from(
          { length: REMINDER_BATCH_MAX_TARGETS + 1 },
          () => APPOINTMENT_ID,
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).sendVaccinationReminders({
        patientIds: Array.from(
          { length: REMINDER_BATCH_MAX_TARGETS + 1 },
          () => PATIENT_ID,
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
  });

  it("blocks stale or cross-tenant patient ids from vaccination reminders", async () => {
    mocks.sendVaccinationReminderSms.mockResolvedValueOnce({
      success: true,
      sid: "sms-vax-1",
      error: undefined,
    });
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ ...PRACTICE_SETTINGS, timezone: "America/New_York" }],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "email",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({
        patientIds: [PATIENT_ID, STALE_PATIENT_ID],
      }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 1, deduped: 0 });

    expect(mocks.sendVaccinationReminder).toHaveBeenCalledOnce();
    expect(mocks.sendVaccinationReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        dueDate: "Jun 1, 2026",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        subject: "Vaccination Reminder",
        status: "pending",
        dedupeKey: expect.stringContaining("vaccination-recall:v1"),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
      }),
    );
  });

  it("routes vaccination SMS reminders through an active practice sender", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
          {
            vaccinationRecordId: SECOND_VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Bordetella",
            nextDueDate: "2026-06-02",
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({
        patientIds: [PATIENT_ID, STALE_PATIENT_ID],
      }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 1, deduped: 0 });

    expect(mocks.sendVaccinationReminderSms).toHaveBeenCalledOnce();
    expect(mocks.sendVaccinationReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "(303) 555-0200",
        patientName: "Miso",
        vaccineName: "Rabies, Bordetella",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
      }),
    );
    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        subject: "Vaccination Reminder",
        content: "Vaccination reminder for Miso: Rabies, Bordetella",
        status: "pending",
        dedupeKey: expect.stringContaining("vaccination-recall:v1"),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        content: "Vaccination reminder sent for Miso: Rabies, Bordetella",
        status: "sent",
        providerMessageId: "sms-vax-1",
      }),
    );
  });

  it("falls back to email for vaccination SMS reminders with no active sender", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });

    expect(mocks.sendVaccinationReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        subject: "Vaccination Reminder",
        status: "pending",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        content: "Vaccination reminder sent for Miso: Rabies",
        status: "sent",
      }),
    );
  });

  it("fails closed to email when multiple clinic texting senders are active", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
        [{ locationId: LOCATION_ID }, { locationId: SECOND_LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });

    expect(mocks.sendVaccinationReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "email", status: "sent" }),
    );
  });

  it("combines a patient's overdue vaccines into one idempotent email", async () => {
    mocks.sendVaccinationReminder.mockResolvedValueOnce({
      success: true,
      id: "email-vax-combined",
      error: undefined,
    });
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: null,
            preferredContactMethod: "email",
            smsConsent: false,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
          {
            vaccinationRecordId: SECOND_VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: null,
            preferredContactMethod: "email",
            smsConsent: false,
            vaccineName: "Bordetella",
            nextDueDate: "2026-06-02",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0, blocked: 0, deduped: 0 });

    expect(mocks.sendVaccinationReminder).toHaveBeenCalledOnce();
    expect(mocks.sendVaccinationReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        vaccineName: "Rabies, Bordetella",
        dueDate: "Jun 1, 2026",
      }),
    );
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        subject: "Vaccination Reminder",
        content: "Vaccination reminder for Miso: Rabies, Bordetella",
        status: "pending",
        dedupeKey: expect.stringContaining("vaccination-recall:v1"),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        content: "Vaccination reminder sent for Miso: Rabies, Bordetella",
        status: "sent",
        providerMessageId: "email-vax-combined",
      }),
    );
  });

  it("counts vaccination emails to suppressed recipients as failed", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            emailSuppressionReason: "suppressed",
            clientPhone: null,
            preferredContactMethod: "email",
            smsConsent: false,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 0, blocked: 1, deduped: 0 });

    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("preserves the pending claim when vaccination SMS transport throws", async () => {
    mocks.sendVaccinationReminderSms.mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1, blocked: 0, deduped: 0 });

    expect(mocks.sendVaccinationReminderSms).toHaveBeenCalledOnce();
    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        subject: "Vaccination Reminder",
        status: "pending",
      }),
    );
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("releases a failed recall claim so a deliberate retry is possible", async () => {
    mocks.sendVaccinationReminderSms.mockResolvedValueOnce({
      success: false,
      sid: undefined,
      error: "SMS unavailable",
    });
    mocks.sendVaccinationReminder.mockResolvedValueOnce({
      success: false,
      id: undefined,
      error: "Email unavailable",
    });
    const { db, updateSet } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@realclinic.com",
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1, blocked: 0, deduped: 0 });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", dedupeKey: null }),
    );
  });

  it("blocks SMS-only recalls when there is no active sender", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [PRACTICE_SETTINGS],
        [
          {
            vaccinationRecordId: VACCINATION_RECORD_ID,
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: null,
            clientPhone: "(303) 555-0200",
            preferredContactMethod: "sms",
            smsConsent: true,
            vaccineName: "Rabies",
            nextDueDate: "2026-06-01",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).sendVaccinationReminders({ patientIds: [PATIENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 0, blocked: 1, deduped: 0 });

    expect(mocks.sendVaccinationReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendVaccinationReminder).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("uses the practice timezone when listing overdue vaccinations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db } = createDb({
      selectResults: [
        [{ timezone: "America/Los_Angeles" }],
        [
          {
            patientId: PATIENT_ID,
            patientName: "Miso",
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            vaccineName: "Rabies",
            nextDueDate: "2026-07-13",
          },
        ],
      ],
    });

    await expect(callerWithDb(db).getOverdueVaccinations()).resolves.toEqual([
      {
        patientId: PATIENT_ID,
        patientName: "Miso",
        clientId: CLIENT_ID,
        clientFirstName: "Ada",
        clientLastName: "Lovelace",
        clientEmail: "ada@example.com",
        overdueVaccines: [{ vaccineName: "Rabies", nextDueDate: "2026-07-13" }],
      },
    ]);
  });

  it("rejects invoice sends when the tenant invoice/client target is missing", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.sendInvoiceEmail).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not email a draft invoice", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "123.45",
            paidAmount: "25.00",
            dueDate: null,
            status: "draft",
            isEstimate: false,
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Only sent or overdue invoices can be emailed. Use the receipt for paid invoices.",
    });
    expect(mocks.sendInvoiceEmail).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not email a paid invoice as though its total were still due", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "123.45",
            dueDate: null,
            status: "paid",
            isEstimate: false,
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.sendInvoiceEmail).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("brands manual invoice emails with practice identity and formatted due dates", async () => {
    mocks.sendInvoiceEmail.mockResolvedValueOnce({
      success: true,
      id: "email-invoice-1",
      error: undefined,
    });
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "123.45",
            paidAmount: "25.00",
            dueDate: "2026-07-01",
            status: "sent",
            isEstimate: false,
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: " Ada@Example.COM ",
          },
        ],
        [{ amount: "10.00" }],
        [PRACTICE_SETTINGS],
      ],
    });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).resolves.toEqual({ success: true });

    expect(mocks.sendInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        clientName: "Ada Lovelace",
        invoiceTotal: "$88.45",
        dueDate: "Jul 1, 2026",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        subject: "Invoice",
        content: "Invoice sent — amount due: $88.45",
        status: "sent",
        providerMessageId: "email-invoice-1",
      }),
    );
  });

  it("blocks invoice emails to provider-suppressed recipients", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "123.45",
            paidAmount: "0.00",
            dueDate: "2026-07-01",
            status: "sent",
            isEstimate: false,
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
            emailSuppressionReason: "suppressed",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Client email is suppressed after provider suppression. Update the client email before sending.",
    });

    expect(mocks.sendInvoiceEmail).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("does not log invoice emails as sent when delivery fails", async () => {
    mocks.sendInvoiceEmail.mockResolvedValueOnce({
      success: false,
      id: undefined,
      error: "Email provider rejected the message",
    });
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: INVOICE_ID,
            total: "123.45",
            dueDate: "2026-07-01",
            status: "sent",
            isEstimate: false,
            clientId: CLIENT_ID,
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            clientEmail: "ada@example.com",
          },
        ],
        [],
        [PRACTICE_SETTINGS],
      ],
    });

    await expect(
      callerWithDb(db).sendInvoiceEmail({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Email provider rejected the message",
    });

    expect(insertValues).not.toHaveBeenCalled();
  });
});

function reminderAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    status: "confirmed",
    startTime: new Date("2026-07-02T16:00:00Z"),
    patientName: "Miso",
    clientId: CLIENT_ID,
    clientFirstName: "Ada",
    clientLastName: "Lovelace",
    clientEmail: "ada@example.com",
    emailSuppressionReason: null,
    clientPhone: null,
    preferredContactMethod: "email",
    smsConsent: false,
    practiceName: "Neighborhood Veterinary",
    practicePhone: "555-0100",
    practiceTimezone: "America/Los_Angeles",
    locationId: LOCATION_ID,
    ...overrides,
  };
}

describe("appointment reminder state transitions", () => {
  it("records a failed email with the provider's reason instead of leaving it pending", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: false,
      id: undefined,
      error: "Mailbox unavailable",
    });
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({
      message: "The email provider rejected the reminder.",
    });

    expect(updateSet).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "failed",
        reminderOutcome: "staff_failure",
        content: expect.stringContaining(
          ": The email provider rejected the reminder.",
        ),
      }),
    );
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^email:reminder:appointment:.*:attempt-1$/,
        ),
      }),
    );
  });

  it("marks an email with an unknown provider outcome as delivery unknown", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: false,
      id: undefined,
      outcome: "outcome_unknown",
      error: "Email send timed out after 10000ms",
    });
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toThrow(/did not confirm the send/);

    expect(updateSet).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        reminderOutcome: "outcome_unknown",
        content: expect.stringContaining("delivery unknown"),
      }),
    );
  });

  it("explains a conflict on a reminder whose delivery is unknown", async () => {
    const { db } = createDb({
      selectResults: [
        [reminderAppointment()],
        [{ status: "pending", reminderOutcome: "outcome_unknown" }],
      ],
      claimResults: [[]],
      reclaimResults: [[]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("may have been delivered"),
    });
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("records a failed email when the provider call throws", async () => {
    mocks.sendAppointmentReminder.mockRejectedValueOnce(
      new Error("Email provider timed out"),
    );
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toThrow("Email provider timed out");

    // Raw error text is logged server-side, not shown in the timeline.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        content: expect.stringContaining(
          ": An unexpected error stopped the reminder.",
        ),
      }),
    );
  });

  it("checks the sender gate before claiming so a blocked send leaves no row", async () => {
    mocks.assertOutboundEmailAllowed.mockRejectedValueOnce(
      new Error("Verify your email address before sending external email."),
    );
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toThrow("Verify your email address");

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("lets staff retry after an earlier failure for the same visit", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-retry-1",
      error: undefined,
    });
    const { db, updateSet, updateReturning } = createDb({
      selectResults: [[reminderAppointment()]],
      // The dedupe key already exists (the failed attempt)...
      claimResults: [[]],
      // ...and the failed row is reclaimed for this retry.
      reclaimResults: [[{ id: COMMUNICATION_ID }]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ success: true, channel: "email" });

    expect(updateReturning).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "pending", providerMessageId: null }),
    );
    expect(updateSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "sent",
        providerMessageId: "email-retry-1",
      }),
    );
    expect(mocks.assertOutboundEmailAllowed).toHaveBeenCalledOnce();
  });

  it("still rejects a send while another reminder for the visit is in flight or sent", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
      claimResults: [[]],
      reclaimResults: [[]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    // Only the (unsuccessful) reclaim ran; no outcome was written.
    expect(updateSet).toHaveBeenCalledOnce();
  });

  it("sends a staff SMS retry of a definite failure under a new attempt key", async () => {
    mocks.sendAppointmentReminderSms.mockResolvedValueOnce({
      success: true,
      outcome: "accepted",
      sid: "SM-retry",
      attemptId: "attempt-2",
      replayed: false,
    } as never);
    const { db } = createDb({
      selectResults: [
        [
          reminderAppointment({
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
          }),
        ],
        [{ locationId: LOCATION_ID }],
      ],
      claimResults: [[]],
      reclaimResults: [[{ id: COMMUNICATION_ID, attempt: 2 }]],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).resolves.toEqual({ success: true, channel: "sms" });

    // A new key is a new provider send rather than a replay of the failure.
    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^sms:reminder:appointment:.*:attempt-2$/,
        ),
      }),
    );
  });

  it("keeps an SMS with an unknown provider outcome pending", async () => {
    mocks.sendAppointmentReminderSms.mockRejectedValueOnce(
      new Error("Provider unavailable"),
    );
    const { db, updateSet } = createDb({
      selectResults: [
        [
          reminderAppointment({
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
          }),
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toThrow("Provider unavailable");

    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("records the reason when an SMS fails and the email fallback is blocked", async () => {
    mocks.sendAppointmentReminderSms.mockResolvedValueOnce({
      success: false,
      outcome: "definite_failure",
      error: "Recipient has opted out of SMS (STOP).",
    } as never);
    mocks.assertOutboundEmailAllowed.mockRejectedValueOnce(
      new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Email sending is temporarily unavailable.",
      }),
    );
    const { db, updateSet } = createDb({
      selectResults: [
        [
          reminderAppointment({
            clientPhone: "(555) 555-0100",
            preferredContactMethod: "sms",
            smsConsent: true,
          }),
        ],
        [{ locationId: LOCATION_ID }],
      ],
    });

    await expect(
      callerWithDb(db).sendAppointmentReminder({
        appointmentId: APPOINTMENT_ID,
      }),
    ).rejects.toThrow("Email sending is temporarily unavailable.");

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "failed",
        // Both reasons survive the fallback.
        content: expect.stringContaining(
          ": Text message: The client has opted out of text messages. Email fallback: Email sending is temporarily unavailable.",
        ),
      }),
    );
  });

  it("records the reason for failed bulk reminder emails", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: false,
      id: undefined,
      error: "Mailbox unavailable",
    });
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "failed",
        reminderOutcome: "staff_failure",
        content: expect.stringContaining(
          ": The email provider rejected the reminder.",
        ),
      }),
    );
  });

  it("never marks an accepted bulk email as failed when recording it throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-accepted-1",
      error: undefined,
    });
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });
    updateSet.mockImplementationOnce(() => {
      throw new Error("projection unavailable");
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(updateSet).toHaveBeenCalledOnce();
    expect(updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("records a bulk email with an unknown provider outcome as delivery unknown", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: false,
      id: undefined,
      outcome: "outcome_unknown",
      error: "Email send timed out after 10000ms",
    });
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 0, failed: 1 });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        reminderOutcome: "outcome_unknown",
      }),
    );
  });

  it("retries a previously failed visit in a bulk send", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[reminderAppointment()]],
      claimResults: [[]],
      reclaimResults: [[{ id: COMMUNICATION_ID }]],
    });

    await expect(
      callerWithDb(db).sendBulkReminders({ appointmentIds: [APPOINTMENT_ID] }),
    ).resolves.toEqual({ sent: 1, failed: 0 });

    expect(updateSet).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "sent" }),
    );
  });
});

describe("notification query scoping", () => {
  const routerSource = readFileSync(
    new URL("../routers/notifications.ts", import.meta.url),
    "utf8",
  );
  const recallSource = readFileSync(
    new URL("../vaccination-recalls.ts", import.meta.url),
    "utf8",
  );
  const source = `${routerSource}\n${recallSource}`;

  it("allows the operational veterinarian role to send one-off appointment reminders", () => {
    const procedure = routerSource.slice(
      routerSource.indexOf("sendAppointmentReminder: protectedProcedure"),
      routerSource.indexOf("sendInvoiceEmail: protectedProcedure"),
    );
    expect(procedure).toContain(
      'requireRole("admin", "veterinarian", "front_desk")',
    );
  });

  function expectScopedJoin(
    joinKind: "leftJoin" | "innerJoin",
    table: string,
    foreignKey: string,
    tenantExpr: string,
    minCount = 1,
  ) {
    const joins = source.match(
      new RegExp(
        `${joinKind}\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
          ".",
          "\\.",
        )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, ${tenantExpr.replace(
          ".",
          "\\.",
        )}\\),\\s*activePracticePredicate\\(${tenantExpr.replace(
          ".",
          "\\.",
        )}\\),\\s*isNull\\(${table}\\.deletedAt\\),?\\s*\\),?\\s*\\)`,
        "gs",
      ),
    );
    expect(joins?.length).toBeGreaterThanOrEqual(minCount);
  }

  it("keeps appointment reminder display joins tenant scoped and active", () => {
    expect(source).toContain("function activePracticeWhere");
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("throw practiceNotFound()");

    const appointmentPatientJoins = source.match(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(appointments\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointments\.clientId\),\s*eq\(patients\.practiceId, ctx\.practiceId\),\s*activePracticePredicate\(ctx\.practiceId\),\s*isNull\(patients\.deletedAt\),?\s*\),?\s*\)/gs,
    );
    expect(appointmentPatientJoins?.length).toBeGreaterThanOrEqual(3);
    expectScopedJoin(
      "leftJoin",
      "clients",
      "appointments.clientId",
      "ctx.practiceId",
      3,
    );
    expectScopedJoin(
      "leftJoin",
      "users",
      "appointments.doctorId",
      "ctx.practiceId",
    );
    expect(source).not.toContain(
      'inArray(appointments.status, ["scheduled", "confirmed"])',
    );
    expect(source).toContain('if (appt.status !== "confirmed")');
    expect(
      source.match(/eq\(appointments\.status, "confirmed"\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps active reminder SMS sender lookup tenant scoped and active", () => {
    const senderBlock = source.slice(
      source.indexOf("async function activeReminderSmsSender"),
      source.indexOf("export const notificationsRouter"),
    );

    expect(senderBlock).toContain(
      "eq(locationMessaging.practiceId, ctx.practiceId)",
    );
    expect(senderBlock).toContain("activePracticePredicate(ctx.practiceId)");
    expect(senderBlock).toContain("eq(locations.practiceId, ctx.practiceId)");
    expect(senderBlock).toContain("isNull(locationMessaging.deletedAt)");
    expect(senderBlock).toContain("isNull(locations.deletedAt)");
    expect(senderBlock).toContain("eq(locationMessaging.enabled, true)");
    expect(senderBlock).toContain(
      'eq(locationMessaging.registrationStatus, "active")',
    );
    expect(senderBlock).toContain("hasNonBlankMessagingSender()");
    expect(senderBlock).not.toContain(
      "isNotNull(locationMessaging.senderE164)",
    );
    expect(senderBlock).not.toContain(
      "isNotNull(locationMessaging.messagingProfileId)",
    );
  });

  it("keeps invoice and vaccination reminder recipient joins tenant scoped and active", () => {
    expectScopedJoin(
      "leftJoin",
      "clients",
      "invoices.clientId",
      "ctx.practiceId",
    );
    expectScopedJoin(
      "innerJoin",
      "patients",
      "vaccinationRecords.patientId",
      "ctx.practiceId",
      2,
    );
    expectScopedJoin(
      "innerJoin",
      "clients",
      "patients.clientId",
      "ctx.practiceId",
      2,
    );
  });

  it("matches provider suppressions against trimmed normalized client emails", () => {
    const suppressionJoins = source.match(
      /sql`\$\{emailSuppressions\.email\} = lower\(trim\(\$\{clients\.email\}\)\)`/g,
    );

    expect(suppressionJoins?.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toContain(
      "sql`${emailSuppressions.email} = lower(${clients.email})`",
    );
  });

  it("uses the practice timezone for vaccination overdue cutoffs", () => {
    const recallPreviewBlock = recallSource.slice(
      recallSource.indexOf("async function loadVaccinationRecallRecipients"),
      recallSource.indexOf("export async function getVaccinationRecallPreview"),
    );
    const vaccinationBlock = source.slice(
      source.indexOf("getOverdueVaccinations:"),
      source.indexOf("sendVaccinationReminders:"),
    );

    expect(source).toContain("async function practiceDateInput");
    expect(source).toContain(
      "formatDateInputForTimeZone(new Date(), practice.timezone)",
    );
    expect(vaccinationBlock).toContain(
      "const today = await practiceDateInput(ctx)",
    );
    expect(recallPreviewBlock).toContain(
      "const today = formatDateInputForTimeZone(new Date(), practice.timezone)",
    );
    expect(recallPreviewBlock).toContain("latestVaccinationRecordPredicate()");
    expect(recallPreviewBlock).toContain('eq(patients.status, "active")');
    expect(source).not.toContain('new Date().toISOString().split("T")[0]');
  });

  it("formats manual appointment reminder labels in the practice timezone", () => {
    expect(source).toContain(
      "function formatDate(d: Date | string, timeZone?: string | null)",
    );
    expect(source).toContain(
      "function formatTime(d: Date | string, timeZone?: string | null)",
    );
    expect(source).toContain("practiceTimezone: practices.timezone");
    expect(source).toContain(
      "formatDate(appt.startTime, appt.practiceTimezone)",
    );
    expect(source).toContain(
      "formatTime(appt.startTime, appt.practiceTimezone)",
    );
    expect(source).not.toContain("formatDate(appt.startTime)");
    expect(source).not.toContain("formatTime(appt.startTime)");
  });

  it("keeps customer notification emails branded with a practice display name", () => {
    expect(source).toContain("function practiceDisplayName");
    expect(source).toContain("async function practiceNotificationSettings");
    expect(source).toContain(
      "practiceName: practiceDisplayName(appt.practiceName)",
    );
    expect(source).toContain("name: practiceDisplayName(practice.name)");
    expect(source).not.toContain("practice?.name");
    expect(source).not.toContain("practice?.phone");
    expect(source).not.toContain("practice?.timezone");
    expect(source).toContain("practiceName: practice.name");
    expect(source).toContain("practicePhone: practice.phone ?? undefined");
    expect(source).not.toContain('practiceName: ""');
  });
});
