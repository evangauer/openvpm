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
  STALE_EMAIL_REMINDER_CLAIM_MS,
  claimAppointmentReminderCommunication,
  reminderFailureReason,
} = await import("../appointment-reminder");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const NOW = new Date("2026-07-01T16:00:00Z");
const START = new Date("2026-07-02T14:00:00Z");
const DEDUPE_KEY = `reminder:appointment:${APPOINTMENT_ID}:${START.toISOString()}`;

function claimDb(opts: { inserted: unknown[]; reclaimed: unknown[] }) {
  const state: {
    insertValues?: Record<string, unknown>;
    updateSet?: Record<string, unknown>;
    updateWhere?: SQL;
  } = {};
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
        state.updateSet = values;
        return {
          where: vi.fn((where: SQL) => {
            state.updateWhere = where;
            return { returning: vi.fn(async () => opts.reclaimed) };
          }),
        };
      }),
    })),
    select: vi.fn(),
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
    now: NOW,
    ...overrides,
  });
}

function renderWhere(where: SQL | undefined) {
  return new PgDialect().sqlToQuery(where!);
}

describe("appointment reminder claim", () => {
  it("claims a new reminder without touching existing rows", async () => {
    const { db, state } = claimDb({ inserted: [{ id: "new" }], reclaimed: [] });

    await expect(claim(db)).resolves.toBe("new");

    expect(state.insertValues).toMatchObject({
      status: "pending",
      dedupeKey: DEDUPE_KEY,
      subject: APPOINTMENT_REMINDER_SUBJECT,
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("lets staff retry a failed reminder by reclaiming the same row", async () => {
    const { db, state } = claimDb({
      inserted: [],
      reclaimed: [{ id: "failed-row" }],
    });

    await expect(claim(db)).resolves.toBe("failed-row");

    expect(state.updateSet).toMatchObject({
      status: "pending",
      subject: APPOINTMENT_REMINDER_SUBJECT,
      providerMessageId: null,
      updatedAt: NOW,
    });
    const { sql, params } = renderWhere(state.updateWhere);
    // Scoped to this practice's reminder for this exact start time.
    expect(sql).toContain('"communications"."practice_id" = $');
    expect(sql).toContain('"communications"."dedupe_key" = $');
    expect(sql).toContain('"communications"."deleted_at" is null');
    expect(params).toEqual(
      expect.arrayContaining([PRACTICE_ID, DEDUPE_KEY, "failed", "pending"]),
    );
    // Staff retries are not restricted by who recorded the failure.
    expect(sql).not.toContain('"communications"."subject" <>');
    expect(mocks.recoverStaleUnreservedSmsCommunication).not.toHaveBeenCalled();
  });

  it("only reclaims pending email rows once they are stale", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db)).resolves.toBeNull();

    const { sql, params } = renderWhere(state.updateWhere);
    // A live pending claim (a send in flight) must keep blocking.
    expect(sql).toMatch(
      /"communications"\."status" = \$\d+ and "communications"\."channel" = \$\d+ and "communications"\."updated_at" <= \$\d+/,
    );
    expect(params).toEqual(
      expect.arrayContaining([
        "email",
        new Date(NOW.getTime() - STALE_EMAIL_REMINDER_CLAIM_MS).toISOString(),
      ]),
    );
  });

  it("keeps the automated sweep from re-attempting its own failures", async () => {
    const { db, state } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db, { source: "automated" })).resolves.toBeNull();

    expect(state.updateSet).toMatchObject({
      subject: AUTOMATED_APPOINTMENT_REMINDER_SUBJECT,
    });
    const { sql, params } = renderWhere(state.updateWhere);
    expect(sql).toMatch(
      /"communications"\."status" = \$\d+ and "communications"\."subject" <> \$\d+/,
    );
    expect(params).toContain(AUTOMATED_APPOINTMENT_REMINDER_SUBJECT);
  });

  it("falls back to stale unreserved SMS recovery for SMS claims", async () => {
    mocks.recoverStaleUnreservedSmsCommunication.mockResolvedValueOnce(
      "stale-sms" as never,
    );
    const { db } = claimDb({ inserted: [], reclaimed: [] });

    await expect(claim(db, { channel: "sms" })).resolves.toBe("stale-sms");
    expect(mocks.recoverStaleUnreservedSmsCommunication).toHaveBeenCalledWith(
      db,
      { practiceId: PRACTICE_ID, dedupeKey: DEDUPE_KEY },
    );
  });
});

describe("reminderFailureReason", () => {
  it("keeps reasons readable and bounded", () => {
    expect(reminderFailureReason(new Error("  Mailbox\n unavailable "))).toBe(
      "Mailbox unavailable",
    );
    expect(reminderFailureReason(undefined)).toBe("unknown error");
    expect(reminderFailureReason("x".repeat(500))).toHaveLength(300);
  });
});
