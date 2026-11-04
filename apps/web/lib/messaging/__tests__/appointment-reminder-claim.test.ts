import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  recoverStaleUnreservedSmsCommunication: vi.fn(async () => null),
}));

vi.mock("@/lib/messaging/durable-sms-communication", () => ({
  recoverStaleUnreservedSmsCommunication:
    mocks.recoverStaleUnreservedSmsCommunication,
}));

const {
  APPOINTMENT_REMINDER_SUBJECT,
  AUTOMATED_APPOINTMENT_REMINDER_SUBJECT,
  AUTOMATED_REMINDER_RETRY_DELAY_MS,
  MAX_AUTOMATED_REMINDER_ATTEMPTS,
  STALE_EMAIL_REMINDER_CLAIM_MS,
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderSmsIdempotencyKey,
  claimAppointmentReminderCommunication,
  emailReminderFailureReason,
  recordAppointmentReminderOutcome,
  reminderFailureReason,
  smsReminderFailureReason,
} = await import("../appointment-reminder");
const { TRPCError } = await import("@trpc/server");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const START = new Date("2026-07-02T14:00:00Z");
const DEDUPE_KEY = `reminder:appointment:${APPOINTMENT_ID}:${START.toISOString()}`;

function claimDb(opts: {
  inserted: unknown[];
  reclaimed: unknown[];
  recovered?: unknown[];
}) {
  const state: {
    insertValues?: Record<string, unknown>;
    updateSet?: Record<string, unknown>;
    updateWhere?: SQL;
  } = {};
  const updateResults = [opts.reclaimed, opts.recovered ?? []];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertValues = values;
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => opts.inserted),
          })),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updateSet ??= values;
        return {
          where: vi.fn((where: SQL) => {
            state.updateWhere ??= where;
            const result = updateResults.shift() ?? [];
            return { returning: vi.fn(async () => result) };
          }),
        };
      }),
    })),
  };
  return { db, state };
}

function claim(
  db: ReturnType<typeof claimDb>["db"],
  overrides: Partial<{
    channel: "sms" | "email";
    source: "staff" | "automated";
  }> = {},
) {
  return claimAppointmentReminderCommunication(db as never, {
    practiceId: PRACTICE_ID,
    appointmentId: APPOINTMENT_ID,
    clientId: CLIENT_ID,
    channel: "email",
    patientName: "Miso",
    startTime: START,
    ...overrides,
  });
}

const dialect = new PgDialect();
function render(fragment: unknown) {
  return dialect.sqlToQuery(fragment as SQL);
}

describe("appointment reminder claim", () => {
  it("claims a new reminder as the first send attempt", async () => {
    const { db, state } = claimDb({ inserted: [{ id: "new" }], reclaimed: [] });

    await expect(claim(db)).resolves.toEqual({ id: "new", attempt: 1 });

    expect(state.insertValues).toMatchObject({
      status: "pending",
      dedupeKey: DEDUPE_KEY,
      subject: APPOINTMENT_REMINDER_SUBJECT,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 0,
      reminderOutcome: null,
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("counts the sweep's first claim", async () => {
    const { db, state } = claimDb({ inserted: [{ id: "new" }], reclaimed: [] });

    await claim(db, { source: "automated" });

    expect(state.insertValues).toMatchObject({
      subject: AUTOMATED_APPOINTMENT_REMINDER_SUBJECT,
      reminderAutomatedAttempts: 1,
    });
  });

  it("lets staff retry a recorded failure as a new send attempt", async () => {
    const { db, state } = claimDb({
      inserted: [],
      reclaimed: [{ id: "failed-row", attempt: 2 }],
    });

    await expect(claim(db)).resolves.toEqual({ id: "failed-row", attempt: 2 });

    expect(state.updateSet).toMatchObject({
      status: "pending",
      subject: APPOINTMENT_REMINDER_SUBJECT,
      providerMessageId: null,
      reminderOutcome: null,
    });
    // The reclaim refreshes updated_at on the database clock in the same
    // statement, so no other claimer can treat the row as stale.
    expect(render(state.updateSet!.updatedAt).sql).toBe("now()");
    // Only a retried failure starts a new send attempt.
    expect(render(state.updateSet!.reminderAttempt).sql).toBe(
      `case when "communications"."status" = 'failed' then "communications"."reminder_attempt" + 1 else "communications"."reminder_attempt" end`,
    );

    const { sql, params } = render(state.updateWhere);
    expect(sql).toContain('"communications"."practice_id" = $');
    expect(sql).toContain('"communications"."dedupe_key" = $');
    expect(sql).toContain('"communications"."deleted_at" is null');
    // Rows written before retries existed are never reclaimed.
    expect(sql).toContain('"communications"."reminder_attempt" is not null');
    expect(sql).toContain('"communications"."reminder_outcome" in ($');
    expect(params).toEqual(
      expect.arrayContaining([
        PRACTICE_ID,
        DEDUPE_KEY,
        "failed",
        "staff_failure",
        "automated_failure",
      ]),
    );
    // An unknown outcome is never a retryable failure.
    expect(params).not.toContain("outcome_unknown");
    expect(mocks.recoverStaleUnreservedSmsCommunication).not.toHaveBeenCalled();
  });

  it("only reclaims unmarked pending email rows once stale on the database clock", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db)).resolves.toBeNull();

    const { sql, params } = render(state.updateWhere);
    expect(sql).toMatch(
      /"communications"\."status" = \$\d+ and "communications"\."channel" = \$\d+ and "communications"\."reminder_outcome" is null and "communications"\."updated_at" <= now\(\) - make_interval\(secs => \$\d+\)/,
    );
    expect(params).toEqual(
      expect.arrayContaining(["email", STALE_EMAIL_REMINDER_CLAIM_MS / 1000]),
    );
  });

  it("never lets an SMS claim take over a stale email claim", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db, { channel: "sms" })).resolves.toBeNull();

    const { sql } = render(state.updateWhere);
    expect(sql).not.toContain('"communications"."channel" = $');
    expect(sql).not.toContain("make_interval(secs => $");
  });

  it("bounds the sweep's retries and waits an hour before retrying its own failure", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db, { source: "automated" })).resolves.toBeNull();

    expect(state.updateSet).toMatchObject({
      subject: AUTOMATED_APPOINTMENT_REMINDER_SUBJECT,
    });
    expect(render(state.updateSet!.reminderAutomatedAttempts).sql).toBe(
      '"communications"."reminder_automated_attempts" + 1',
    );
    const { sql, params } = render(state.updateWhere);
    expect(sql).toMatch(
      /"communications"\."reminder_automated_attempts" < \$\d+ and \("communications"\."reminder_outcome" = \$\d+ or \("communications"\."reminder_outcome" = \$\d+ and "communications"\."updated_at" <= now\(\) - make_interval\(secs => \$\d+\)\)\)/,
    );
    expect(params).toEqual(
      expect.arrayContaining([
        MAX_AUTOMATED_REMINDER_ATTEMPTS,
        "staff_failure",
        "automated_failure",
        AUTOMATED_REMINDER_RETRY_DELAY_MS / 1000,
      ]),
    );
  });

  it("falls back to stale unreserved SMS recovery and keeps the send attempt", async () => {
    mocks.recoverStaleUnreservedSmsCommunication.mockResolvedValueOnce(
      "stale-sms" as never,
    );
    const { db } = claimDb({
      inserted: [],
      reclaimed: [],
      recovered: [{ attempt: 3 }],
    });

    await expect(claim(db, { channel: "sms" })).resolves.toEqual({
      id: "stale-sms",
      attempt: 3,
    });
    expect(mocks.recoverStaleUnreservedSmsCommunication).toHaveBeenCalledWith(
      db,
      { practiceId: PRACTICE_ID, dedupeKey: DEDUPE_KEY },
    );
  });
});

describe("appointment reminder idempotency keys", () => {
  const appointment = { id: APPOINTMENT_ID, startTime: START };

  it("keeps the original SMS key for the first attempt", () => {
    expect(appointmentReminderSmsIdempotencyKey(appointment)).toBe(
      `sms:${DEDUPE_KEY}`,
    );
    expect(appointmentReminderSmsIdempotencyKey(appointment, 1)).toBe(
      `sms:${DEDUPE_KEY}`,
    );
  });

  it("scopes retries to a new key per attempt", () => {
    expect(appointmentReminderSmsIdempotencyKey(appointment, 2)).toBe(
      `sms:${DEDUPE_KEY}:attempt-2`,
    );
    expect(appointmentReminderEmailIdempotencyKey(appointment, 1)).toBe(
      `email:${DEDUPE_KEY}:attempt-1`,
    );
    expect(appointmentReminderEmailIdempotencyKey(appointment, 2)).toBe(
      `email:${DEDUPE_KEY}:attempt-2`,
    );
    expect(
      appointmentReminderSmsIdempotencyKey(appointment, 99).length,
    ).toBeLessThanOrEqual(200);
  });
});

describe("recordAppointmentReminderOutcome", () => {
  function outcomeDb() {
    const state: { set?: Record<string, unknown>; where?: SQL } = {};
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          state.set = values;
          return {
            where: vi.fn(async (where: SQL) => {
              state.where = where;
            }),
          };
        }),
      })),
    };
    return { db, state };
  }
  const base = {
    practiceId: PRACTICE_ID,
    communicationId: "row",
    channel: "email" as const,
    content: "x",
  };

  it.each([
    ["failed", "staff", "failed", "staff_failure"],
    ["failed", "automated", "failed", "automated_failure"],
    ["unknown", "staff", "pending", "outcome_unknown"],
    ["sent", "automated", "sent", null],
  ] as const)(
    "records %s from %s as status %s with outcome %s",
    async (result, source, status, reminderOutcome) => {
      const { db, state } = outcomeDb();
      await recordAppointmentReminderOutcome(db as never, {
        ...base,
        result,
        source,
        providerMessageId: result === "sent" ? "msg-1" : undefined,
      });
      expect(state.set).toMatchObject({ status, reminderOutcome });
      expect(render(state.set!.updatedAt).sql).toBe("now()");
      // Only a pending claim (or the same accepted message) is updated.
      expect(render(state.where).sql).toContain(
        '"communications"."status" = $',
      );
    },
  );
});

describe("staff-facing failure reasons", () => {
  it("passes staff-facing errors through and hides unexpected ones", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      reminderFailureReason(
        new TRPCError({
          code: "BAD_REQUEST",
          message: "  Client does not have\n an email address on file ",
        }),
      ),
    ).toBe("Client does not have an email address on file");
    expect(
      reminderFailureReason(new Error('duplicate key value "communications"')),
    ).toBe("An unexpected error stopped the reminder.");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("maps provider errors to friendly reasons", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(
      emailReminderFailureReason({
        outcome: "definite_failure",
        error: "The example.com domain is not verified",
      }),
    ).toBe("The email provider rejected the reminder.");
    expect(
      emailReminderFailureReason({
        outcome: "outcome_unknown",
        error: "Email send timed out after 10000ms",
      }),
    ).toMatch(/did not confirm/);
    expect(
      smsReminderFailureReason({
        outcome: "definite_failure",
        error: "Recipient has opted out of SMS (STOP).",
      }),
    ).toBe("The client has opted out of text messages.");
    expect(
      smsReminderFailureReason({
        outcome: "definite_failure",
        error: "Twilio 21211: invalid To number",
      }),
    ).toBe("The text message provider rejected the reminder.");
    consoleError.mockRestore();
  });
});
