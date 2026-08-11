import { describe, expect, it, vi } from "vitest";
import {
  assertPracticeAllowsExternalSideEffects,
  lockPracticeForExternalSideEffects,
  practiceAllowsExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "../recovery-hold";

function databaseWithPractice(recoveryHold: boolean | null) {
  const limit = vi.fn(async () =>
    recoveryHold === null ? [] : [{ recoveryHold }],
  );
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { database: { select }, select, limit };
}

function lockDatabaseWithPractice(recoveryHold: boolean) {
  const locked = vi.fn(async () => [{ recoveryHold }]);
  const limit = vi.fn(() => ({ for: locked }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { database: { select }, locked };
}

describe("practice recovery hold", () => {
  it("allows side effects only for an existing, active, released practice", async () => {
    const released = databaseWithPractice(false);
    const held = databaseWithPractice(true);
    const missing = databaseWithPractice(null);

    await expect(
      practiceAllowsExternalSideEffects(released.database as never, "p-1"),
    ).resolves.toBe(true);
    await expect(
      practiceAllowsExternalSideEffects(held.database as never, "p-1"),
    ).resolves.toBe(false);
    await expect(
      practiceAllowsExternalSideEffects(missing.database as never, "p-1"),
    ).resolves.toBe(false);
  });

  it("fails closed with an operator-facing recovery message", async () => {
    const held = databaseWithPractice(true);

    await expect(
      assertPracticeAllowsExternalSideEffects(held.database as never, "p-1"),
    ).rejects.toThrow(RECOVERY_HOLD_BLOCK_MESSAGE);
  });

  it("takes a shared practice-row lock for transactional provider work", async () => {
    const released = lockDatabaseWithPractice(false);
    const held = lockDatabaseWithPractice(true);

    await expect(
      lockPracticeForExternalSideEffects(released.database as never, "p-1"),
    ).resolves.toBe(true);
    await expect(
      lockPracticeForExternalSideEffects(held.database as never, "p-1"),
    ).resolves.toBe(false);
    expect(released.locked).toHaveBeenCalledWith("share", expect.any(Object));
  });
});
