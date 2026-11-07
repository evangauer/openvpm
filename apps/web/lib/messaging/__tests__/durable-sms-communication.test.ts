import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  recoverStaleUnreservedSmsCommunication,
  STALE_SMS_COMMUNICATION_CLAIM_MS,
} from "../durable-sms-communication";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const COMMUNICATION_ID = "00000000-0000-0000-0000-000000000003";

function dbWithUpdateResult(result: unknown[]) {
  const state: { set?: Record<string, unknown>; where?: SQL } = {};
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      state.set = values;
      return {
        where: vi.fn((where: SQL) => {
          state.where = where;
          return { returning: vi.fn(async () => result) };
        }),
      };
    }),
  }));
  return { db: { update }, state };
}

describe("stale durable SMS communication recovery", () => {
  it("recovers a stale unreserved claim in one conditional update", async () => {
    const { db, state } = dbWithUpdateResult([{ id: COMMUNICATION_ID }]);

    await expect(
      recoverStaleUnreservedSmsCommunication(db as never, {
        practiceId: PRACTICE_ID,
        dedupeKey: "reminder:appointment:one",
      }),
    ).resolves.toBe(COMMUNICATION_ID);
    expect(db.update).toHaveBeenCalledTimes(1);

    const { sql, params } = new PgDialect().sqlToQuery(state.where!);
    // Staleness is judged on the database clock against the last write, so a
    // row another claimer just reset is fresh.
    expect(sql).toContain(
      '"communications"."updated_at" <= now() - make_interval(secs => $',
    );
    expect(sql).not.toContain('"created_at"');
    expect(params).toContain(STALE_SMS_COMMUNICATION_CLAIM_MS / 1000);
    // Any reserved attempt means the provider may have been called.
    expect(sql).toMatch(/not exists \(\s*select 1 from "sms_send_attempts"/);
    // Winning the claim refreshes updated_at in the same statement.
    expect(
      new PgDialect().sqlToQuery(state.set!.updatedAt as SQL).sql,
    ).toBe("now()");
  });

  it("returns nothing when the row is fresh, reserved, or gone", async () => {
    const { db } = dbWithUpdateResult([]);

    await expect(
      recoverStaleUnreservedSmsCommunication(db as never, {
        practiceId: PRACTICE_ID,
        dedupeKey: "reminder:appointment:two",
      }),
    ).resolves.toBeNull();
  });

  it("uses a fifteen-minute minimum stale window", () => {
    expect(STALE_SMS_COMMUNICATION_CLAIM_MS).toBe(15 * 60 * 1000);
  });
});
