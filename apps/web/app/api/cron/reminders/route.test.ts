import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
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

  const claimResults: unknown[][] = [];
  const insertReturning = vi.fn(
    async () => claimResults.shift() ?? [{ id: "comm-1" }]
  );
  const insertOnConflict = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({ onConflictDoNothing: insertOnConflict }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const deleteResults: unknown[][] = [];
  const deleteReturning = vi.fn(
    async () => deleteResults.shift() ?? [{ id: "old-claim" }]
  );
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteRows = vi.fn(() => ({ where: deleteWhere }));
  const db = { select, insert, update, delete: deleteRows };

  return {
    db,
    selectResults,
    claimResults,
    deleteResults,
    insertValues,
    insertOnConflict,
    insertReturning,
    updateSet,
    updateWhere,
    deleteRows,
    deleteWhere,
    deleteReturning,
    sendAppointmentReminder: vi.fn(),
    sendAppointmentReminderSms: vi.fn(),
    alertOps: vi.fn(async () => undefined),
    cronAuthError: vi.fn(() => null),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db)
    ),
    withTenant: vi.fn(
      async (_db: unknown, _practiceId: string, fn: (tx: unknown) => unknown) =>
        fn(db)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));

vi.mock("@/lib/email", () => ({
  sendAppointmentReminder: mocks.sendAppointmentReminder,
}));

vi.mock("@/lib/sms", () => ({
  sendAppointmentReminderSms: mocks.sendAppointmentReminderSms,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/cron-auth", () => ({
  cronAuthError: mocks.cronAuthError,
}));

const { GET } = await import("./route");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";

let consoleLog: { mockRestore: () => void } | undefined;

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    startTime: new Date("2026-07-02T16:00:00Z"),
    endTime: new Date("2026-07-02T16:30:00Z"),
    practiceId: PRACTICE_ID,
    patientName: "Miso",
    clientId: CLIENT_ID,
    clientFirstName: "Ada",
    clientLastName: "Lovelace",
    clientEmail: "ada@lovelacevet.com",
    emailSuppressionReason: null,
    clientPhone: "(555) 555-0100",
    preferredContactMethod: "sms",
    smsConsent: true,
    doctorName: "Dr. Vet",
    practiceName: "Neighborhood Veterinary",
    practicePhone: "555-0100",
    practiceTimezone: "America/New_York",
    locationId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T16:00:00Z"));
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.sendAppointmentReminder.mockResolvedValue({ success: true });
  mocks.sendAppointmentReminderSms.mockResolvedValue({ success: true });
});

afterEach(() => {
  consoleLog?.mockRestore();
  consoleLog = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.claimResults.length = 0;
  mocks.deleteResults.length = 0;
});

describe("appointment reminder cron", () => {
  it("does not send when active recipient joins filter out every appointment", async () => {
    mocks.selectResults.push([]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("suppresses seeded demo appointments before any provider or delivery claim", async () => {
    mocks.selectResults.push([
      appointment({
        isSeededDemoAppointment: true,
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 1,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      "Cron reminders completed: 0 sent, 0 failed, 0 deferred (quiet hours), 0 deduped, 1 suppressed (1 demo, 0 reserved address) out of 1 total"
    );
    expect(consoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining("Miso")
    );
    expect(consoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining("lovelacevet.com")
    );
  });

  it("suppresses reserved fixture email domains even when SMS is preferred", async () => {
    mocks.selectResults.push([
      appointment({
        clientEmail: " ada@reminders.openvpm.test ",
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 1,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      "Cron reminders completed: 0 sent, 0 failed, 0 deferred (quiet hours), 0 deduped, 1 suppressed (0 demo, 1 reserved address) out of 1 total"
    );
  });

  it("uses an active practice sender for scheduled SMS reminders", async () => {
    mocks.sendAppointmentReminderSms.mockResolvedValueOnce({
      success: true,
      sid: "sms-cron-1",
    });
    mocks.selectResults.push(
      [
        appointment({
          startTime: new Date("2026-07-02T16:00:00Z"),
          practiceTimezone: " America/Los_Angeles ",
          locationId: LOCATION_ID,
        }),
      ],
      [{ locationId: LOCATION_ID }]
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "(555) 555-0100",
        appointmentDate: "Thursday, July 2, 2026",
        appointmentTime: "9:00 AM",
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        clientId: CLIENT_ID,
      })
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        status: "pending",
        dedupeKey: `reminder:appointment:${APPOINTMENT_ID}:2026-07-02T16:00:00.000Z`,
      })
    );
    expect(mocks.insertOnConflict).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        status: "sent",
        providerMessageId: "sms-cron-1",
      })
    );
  });

  it("falls back to email when scheduled SMS has no active sender", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-cron-1",
    });
    mocks.selectResults.push(
      [appointment({ clientEmail: " Ada@LovelaceVet.COM " })],
      []
    );

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@lovelacevet.com" })
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        status: "pending",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
        providerMessageId: "email-cron-1",
      })
    );
  });

  it("uses email directly when the preferred SMS phone is invalid", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({
      success: true,
      id: "email-cron-2",
    });
    mocks.selectResults.push([
      appointment({
        clientEmail: " Ada@LovelaceVet.COM ",
        clientPhone: "12345",
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@lovelacevet.com" })
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        status: "pending",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
        providerMessageId: "email-cron-2",
      })
    );
  });

  it("defers SMS-only scheduled reminders during quiet hours with padded timezones", async () => {
    vi.setSystemTime(new Date("2026-07-02T02:30:00Z"));
    mocks.selectResults.push([
      appointment({
        clientEmail: null,
        practiceTimezone: " America/New_York ",
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 1,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("blocks scheduled email reminders to provider-suppressed recipients", async () => {
    mocks.selectResults.push([
      appointment({
        preferredContactMethod: "email",
        clientPhone: null,
        smsConsent: false,
        emailSuppressionReason: "bounce",
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        status: "pending",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "failed",
        content: expect.stringContaining(
          "Client email is suppressed after a delivery bounce"
        ),
      })
    );
  });

  it("fails SMS-only scheduled reminders when no active sender exists", async () => {
    mocks.selectResults.push([appointment({ clientEmail: null })], []);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        status: "pending",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "sms",
        status: "failed",
      })
    );
  });

  it("dedupes already-claimed scheduled reminders before transport", async () => {
    mocks.selectResults.push([appointment()]);
    mocks.claimResults.push([]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deduped: 1,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("keeps fresh pending scheduled reminder claims deduped", async () => {
    mocks.selectResults.push(
      [appointment({ preferredContactMethod: "email" })],
      [
        {
          id: "comm-existing",
          status: "pending",
          createdAt: new Date("2026-07-01T15:45:00Z"),
        },
      ]
    );
    mocks.claimResults.push([]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deduped: 1,
      suppressed: 0,
    });
    expect(mocks.deleteRows).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminder).not.toHaveBeenCalled();
    expect(mocks.sendAppointmentReminderSms).not.toHaveBeenCalled();
  });

  it("retries failed scheduled reminder claims", async () => {
    mocks.selectResults.push(
      [appointment({ preferredContactMethod: "email" })],
      [
        {
          id: "comm-failed",
          status: "failed",
          createdAt: new Date("2026-07-01T15:55:00Z"),
        },
      ]
    );
    mocks.claimResults.push([]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.deleteRows).toHaveBeenCalledOnce();
    expect(mocks.insertReturning).toHaveBeenCalledTimes(2);
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "sent",
      })
    );
  });

  it("reclaims stale pending scheduled reminder claims", async () => {
    mocks.selectResults.push(
      [appointment({ preferredContactMethod: "email" })],
      [
        {
          id: "comm-stale",
          status: "pending",
          createdAt: new Date("2026-07-01T15:00:00Z"),
        },
      ]
    );
    mocks.claimResults.push([]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 1,
      failed: 0,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.deleteRows).toHaveBeenCalledOnce();
    expect(mocks.insertReturning).toHaveBeenCalledTimes(2);
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
  });

  it("marks claimed email reminders failed when the email provider rejects the send", async () => {
    mocks.sendAppointmentReminder.mockResolvedValueOnce({ success: false });
    mocks.selectResults.push([
      appointment({
        preferredContactMethod: "email",
        startTime: new Date("2026-07-02T16:00:00Z"),
        practiceTimezone: "America/Los_Angeles",
      }),
    ]);

    const response = await GET(
      new Request("https://openvpm.test/api/cron/reminders")
    );

    await expect(response.json()).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: 0,
      deduped: 0,
      suppressed: 0,
    });
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledOnce();
    expect(mocks.sendAppointmentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentDate: "Thursday, July 2, 2026",
        appointmentTime: "9:00 AM",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "email",
        status: "failed",
      })
    );
  });
});

describe("appointment reminder cron query scoping", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  function expectScopedJoin(table: string, foreignKey: string) {
    expect(source).toMatch(
      new RegExp(
        `leftJoin\\(\\s*${table},\\s*and\\(\\s*eq\\(${foreignKey.replace(
          ".",
          "\\."
        )}, ${table}\\.id\\),\\s*eq\\(${table}\\.practiceId, appointments\\.practiceId\\),\\s*isNull\\(${table}\\.deletedAt\\)\\s*\\)\\s*\\)`,
        "s"
      )
    );
  }

  it("keeps reminder sweep joins scoped to active appointment practices", () => {
    expect(source).toMatch(
      /leftJoin\(\s*patients,\s*and\(\s*eq\(appointments\.patientId, patients\.id\),\s*eq\(patients\.clientId, appointments\.clientId\),\s*eq\(patients\.practiceId, appointments\.practiceId\),\s*isNull\(patients\.deletedAt\)\s*\)\s*\)/s
    );
    expectScopedJoin("clients", "appointments.clientId");
    expectScopedJoin("users", "appointments.doctorId");
    expectScopedJoin("rooms", "appointments.roomId");
    expect(source).toMatch(
      /innerJoin\(\s*practices,\s*and\(\s*eq\(appointments\.practiceId, practices\.id\),\s*isNull\(practices\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toContain('eq(appointments.status, "confirmed")');
    expect(source).not.toContain(
      'inArray(appointments.status, ["scheduled", "confirmed"])'
    );
  });

  it("matches provider suppressions against trimmed normalized client emails", () => {
    expect(source).toContain(
      "sql`${emailSuppressions.email} = lower(trim(${clients.email}))`"
    );
    expect(source).not.toContain(
      "sql`${emailSuppressions.email} = lower(${clients.email})`"
    );
  });

  it("projects both demo-data markers needed for pre-provider suppression", () => {
    expect(source).toContain("isSeededDemoClient: sql<boolean>");
    expect(source).toContain("isSeededDemoAppointment: sql<boolean>");
    expect(source).toContain("'demoData' -> 'clientIds'");
    expect(source).toContain("'demoData' -> 'appointmentIds'");
  });

  it("formats reminder appointment times in the practice timezone", () => {
    expect(source).toContain("function formatAppointmentReminderDateTime");
    expect(source).toContain("const normalizedTimeZone = timeZone?.trim()");
    expect(source).toContain("timeZone: normalizedTimeZone");
    expect(source).toContain(
      "formatAppointmentReminderDateTime(startDate, appt.practiceTimezone)"
    );
    expect(source).not.toContain('startDate.toLocaleTimeString("en-US", {');
  });

  it("reclaims failed or stale reminder claims with scoped predicates", () => {
    expect(source).toContain("const REMINDER_PENDING_RECLAIM_MS");
    expect(source).toContain('existing.status === "failed"');
    expect(source).toContain("lte(communications.createdAt, staleBefore)");
    expect(source).toContain("eq(communications.practiceId, opts.practiceId)");
    expect(source).toContain("eq(communications.dedupeKey, opts.dedupeKey)");
    expect(source).toContain("isNull(communications.deletedAt)");
  });
});
