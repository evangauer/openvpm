import { describe, expect, it, vi } from "vitest";
import {
  recoverStaleUnreservedSmsCommunication,
  STALE_SMS_COMMUNICATION_CLAIM_MS,
} from "../durable-sms-communication";

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const COMMUNICATION_ID = "00000000-0000-0000-0000-000000000003";

function dbWithSelectResults(results: unknown[][]) {
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      for: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  return { select };
}

describe("stale durable SMS communication recovery", () => {
  it("reuses a stale pending communication only when no attempt exists", async () => {
    const db = dbWithSelectResults([[{ id: COMMUNICATION_ID }], []]);

    await expect(
      recoverStaleUnreservedSmsCommunication(db as never, {
        practiceId: PRACTICE_ID,
        dedupeKey: "reminder:appointment:one",
        now: new Date("2026-08-09T01:00:00Z"),
      }),
    ).resolves.toBe(COMMUNICATION_ID);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("never reuses a communication linked to any send attempt", async () => {
    const db = dbWithSelectResults([
      [{ id: COMMUNICATION_ID }],
      [{ id: "00000000-0000-0000-0000-000000000004" }],
    ]);

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
