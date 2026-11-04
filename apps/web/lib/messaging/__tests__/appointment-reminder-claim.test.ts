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
  EMAIL_REMINDER_KEY_REUSE_WINDOW_MS,
  STALE_EMAIL_REMINDER_CLAIM_MS,
  appointmentReminderEmailFields,
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderMessageFields,
  appointmentReminderSmsIdempotencyKey,
  claimAppointmentReminderCommunication,
  definiteReminderFailureOutcomeSql,
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
    updateSets: Record<string, unknown>[];
    updateWheres: SQL[];
  } = { updateSets: [], updateWheres: [] };
  // Reclaim, then the expired email claim check, then SMS recovery.
  const updateResults = [opts.reclaimed, [], opts.recovered ?? []];
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
        state.updateSets.push(values);
        return {
          where: vi.fn((where: SQL) => {
            state.updateWhere ??= where;
            state.updateWheres.push(where);
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
    const { db, state } = claimDb({
      inserted: [{ id: "new", claimToken: "token-1" }],
      reclaimed: [],
    });

    await expect(claim(db)).resolves.toEqual({
      id: "new",
      channel: "email",
      attempt: 1,
      claimToken: "token-1",
      redispatch: false,
    });
    expect(render(state.insertValues!.reminderClaimToken).sql).toBe(
      "gen_random_uuid()",
    );

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
      reclaimed: [
        {
          id: "failed-row",
          channel: "email",
          attempt: 2,
          claimToken: "token-2",
          redispatch: false,
        },
      ],
    });

    await expect(claim(db)).resolves.toEqual({
      id: "failed-row",
      channel: "email",
      attempt: 2,
      claimToken: "token-2",
      redispatch: false,
    });
    // Every reclaim writes a new fencing token.
    expect(render(state.updateSet!.reminderClaimToken).sql).toBe(
      "gen_random_uuid()",
    );

    expect(state.updateSet).toMatchObject({
      status: "pending",
      subject: APPOINTMENT_REMINDER_SUBJECT,
      providerMessageId: null,
      reminderOutcome: null,
    });
    // The reclaim refreshes updated_at on the database clock in the same
    // statement, so no other claimer can treat the row as stale.
    expect(render(state.updateSet!.updatedAt).sql).toBe("now()");
    // Only a retried failure takes the requested channel; a reclaimed pending
    // email stays an email.
    expect(render(state.updateSet!.channel).sql).toBe(
      `case when "communications"."status" = 'failed' then $1::comm_channel else "communications"."channel" end`,
    );
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
    // An unknown outcome is never a retryable failure (a new attempt).
    const inList = sql.match(
      /"communications"\."reminder_outcome" in \(\$(\d+), \$(\d+)\)/,
    );
    expect(inList).not.toBeNull();
    expect([
      params[Number(inList![1]) - 1],
      params[Number(inList![2]) - 1],
    ]).toEqual(["staff_failure", "automated_failure"]);
    // Neither the attempt clock nor the attempt moves for a same-key reclaim.
    expect(render(state.updateSet!.reminderAttemptStartedAt).sql).toBe(
      `case when "communications"."status" = 'failed' then now() else "communications"."reminder_attempt_started_at" end`,
    );
    expect(mocks.recoverStaleUnreservedSmsCommunication).not.toHaveBeenCalled();
  });

  it("reclaims a stale or unconfirmed pending email only while its key is honored", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db)).resolves.toBeNull();

    const { sql, params } = render(state.updateWhere);
    expect(sql).toMatch(
      /"communications"\."status" = \$\d+ and "communications"\."channel" = \$\d+ and "communications"\."reminder_attempt_started_at" > now\(\) - make_interval\(secs => \$\d+\) and \(\("communications"\."reminder_outcome" is null and "communications"\."updated_at" <= now\(\) - make_interval\(secs => \$\d+\)\) or "communications"\."reminder_outcome" = \$\d+\)/,
    );
    expect(params).toEqual(
      expect.arrayContaining([
        "email",
        EMAIL_REMINDER_KEY_REUSE_WINDOW_MS / 1000,
        STALE_EMAIL_REMINDER_CLAIM_MS / 1000,
        "outcome_unknown",
      ]),
    );
    expect(EMAIL_REMINDER_KEY_REUSE_WINDOW_MS).toBeLessThan(
      24 * 60 * 60 * 1000,
    );
  });

  it("marks an abandoned email claim past the key window as delivery unknown", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db)).resolves.toBeNull();

    expect(state.updateSets[1]).toMatchObject({
      reminderOutcome: "outcome_unknown",
    });
    expect(state.updateSets[1]).not.toHaveProperty("status");
    expect(state.updateSets[1]).not.toHaveProperty("reminderAttempt");
    const { sql, params } = render(state.updateWheres[1]);
    expect(sql).toContain('"communications"."reminder_outcome" is null');
    expect(sql).toContain(
      '("communications"."reminder_attempt_started_at" is null or not ("communications"."reminder_attempt_started_at" > now() - make_interval(secs => $',
    );
    expect(params).toEqual(
      expect.arrayContaining([
        "pending",
        "email",
        STALE_EMAIL_REMINDER_CLAIM_MS / 1000,
        EMAIL_REMINDER_KEY_REUSE_WINDOW_MS / 1000,
      ]),
    );
  });

  it("lets an SMS claim resume a pending email only as an email redispatch", async () => {
    const { db, state } = claimDb({
      inserted: [],
      reclaimed: [
        {
          id: "email-row",
          channel: "email",
          attempt: 1,
          claimToken: "token-2",
          redispatch: true,
        },
      ],
    });

    await expect(claim(db, { channel: "sms" })).resolves.toEqual({
      id: "email-row",
      channel: "email",
      attempt: 1,
      claimToken: "token-2",
      redispatch: true,
    });

    const { sql, params } = render(state.updateWhere);
    expect(sql).toMatch(
      /"communications"\."status" = \$\d+ and "communications"\."channel" = \$\d+ and "communications"\."reminder_attempt_started_at" > now\(\) - make_interval\(secs => \$\d+\)/,
    );
    expect(params).toEqual(expect.arrayContaining(["pending", "email"]));
    // The row keeps its email channel; "sms" applies only to a retried failure.
    expect(render(state.updateSet!.channel).params).toEqual(["sms"]);
    expect(mocks.recoverStaleUnreservedSmsCommunication).not.toHaveBeenCalled();
  });

  it("bounds the sweep's retries and waits before retrying its own failure", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db, { source: "automated" })).resolves.toBeNull();

    expect(state.updateSet).toMatchObject({
      subject: AUTOMATED_APPOINTMENT_REMINDER_SUBJECT,
    });
    // Only retrying a definite failure counts against the sweep's budget.
    expect(render(state.updateSet!.reminderAutomatedAttempts).sql).toBe(
      `case when "communications"."status" = 'failed' then "communications"."reminder_automated_attempts" + 1 else "communications"."reminder_automated_attempts" end`,
    );
    // Shorter than the hourly cadence, so cron jitter can't skip a run.
    expect(AUTOMATED_REMINDER_RETRY_DELAY_MS).toBeLessThan(60 * 60 * 1000);
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
      recovered: [{ attempt: 3, claimToken: "token-3" }],
    });

    await expect(claim(db, { channel: "sms" })).resolves.toEqual({
      id: "stale-sms",
      channel: "sms",
      attempt: 3,
      claimToken: "token-3",
      // No provider attempt was ever reserved, so nothing may have gone out.
      redispatch: false,
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
    claim: {
      id: "row",
      channel: "email" as const,
      attempt: 1,
      claimToken: "token-1",
      redispatch: false,
    },
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
      // Only this claim's pending row (or the same accepted message) is
      // updated.
      const where = render(state.where);
      expect(where.sql).toContain('"communications"."status" = $');
      expect(where.sql).toContain('"communications"."reminder_claim_token" = $');
      expect(where.params).toContain("token-1");
    },
  );

  it.each([
    ["staff", "failed", "pending", "outcome_unknown"],
    ["automated", "failed", "pending", "outcome_unknown"],
    ["staff", "unknown", "pending", "outcome_unknown"],
    ["automated", "sent", "sent", null],
  ] as const)(
    "on a redispatch records %s %s as status %s with outcome %s",
    async (source, result, status, reminderOutcome) => {
      const { db, state } = outcomeDb();
      await recordAppointmentReminderOutcome(db as never, {
        ...base,
        claim: { ...base.claim, redispatch: true },
        result,
        source,
        providerMessageId: result === "sent" ? "msg-1" : undefined,
      });
      // Nothing short of a confirmed send proves the earlier send failed.
      expect(state.set).toMatchObject({ status, reminderOutcome });
    },
  );
});

describe("appointment reminder message formatting", () => {
  it("builds identical email content from identical data on every path", () => {
    const fields = appointmentReminderEmailFields({
      startTime: START,
      timeZone: " America/New_York ",
      clientFirstName: "Ada",
      clientLastName: "Lovelace",
      patientName: "Miso",
      practiceName: "  Neighborhood Veterinary ",
      practicePhone: " 555-0100 ",
    });
    expect(fields).toEqual({
      clientName: "Ada Lovelace",
      patientName: "Miso",
      appointmentDate: "Thursday, July 2, 2026",
      appointmentTime: "10:00 AM",
      practiceName: "Neighborhood Veterinary",
      practicePhone: "555-0100",
    });
    expect(
      appointmentReminderEmailFields({
        startTime: START.toISOString(),
        timeZone: "America/New_York",
        clientFirstName: "Ada",
        clientLastName: "Lovelace",
        patientName: "Miso",
        practiceName: "Neighborhood Veterinary",
        practicePhone: "555-0100",
      }),
    ).toEqual(fields);
  });

  it("falls back to UTC and generic names for missing data", () => {
    expect(
      appointmentReminderMessageFields({
        startTime: START,
        timeZone: "Not/AZone",
        patientName: null,
        practiceName: "  ",
        practicePhone: null,
      }),
    ).toEqual({
      appointmentDate: "Thursday, July 2, 2026",
      appointmentTime: "2:00 PM",
      patientName: "Unknown",
      practiceName: "your clinic",
    });
  });
});

describe("definiteReminderFailureOutcomeSql", () => {
  it("makes a confirmed SMS failure retryable by the source that claimed it", () => {
    const rendered = render(definiteReminderFailureOutcomeSql());
    expect(rendered.sql).toContain('"communications"."reminder_attempt" is null then null');
    expect(rendered.sql).toContain("then 'automated_failure'");
    expect(rendered.sql).toContain("else 'staff_failure'");
    expect(rendered.params).toEqual([AUTOMATED_APPOINTMENT_REMINDER_SUBJECT]);
  });
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
