import { describe, expect, it, vi } from "vitest";
import { processSmsOperationsAlertStateWithDatabase } from "../sms-operations-alert";

function databaseWithRows(...rows: unknown[][]) {
  return {
    execute: vi.fn(async () => rows.shift() ?? []),
  };
}

describe("SMS operations alert state", () => {
  it("suppresses only an unchanged delivered incident inside the cooldown", async () => {
    const database = databaseWithRows(
      [],
      [
        {
          fingerprint: "same",
          state: "degraded",
          withinCooldown: true,
        },
      ],
    );
    const deliver = vi.fn(async () => true);

    await expect(
      processSmsOperationsAlertStateWithDatabase(database as never, {
        fingerprint: "same",
        state: "degraded",
        deliver,
      }),
    ).resolves.toEqual({ alerted: false, deliveryFailed: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("alerts an identical incident immediately after a healthy transition", async () => {
    const database = databaseWithRows(
      [],
      [
        {
          fingerprint: "same",
          state: "healthy",
          withinCooldown: true,
        },
      ],
      [],
    );
    const deliver = vi.fn(async () => true);

    await expect(
      processSmsOperationsAlertStateWithDatabase(database as never, {
        fingerprint: "same",
        state: "degraded",
        deliver,
      }),
    ).resolves.toEqual({ alerted: true, deliveryFailed: false });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(database.execute).toHaveBeenCalledTimes(3);
  });

  it("does not persist cooldown suppression when alert delivery fails", async () => {
    const database = databaseWithRows([], []);
    const deliver = vi.fn(async () => false);

    await expect(
      processSmsOperationsAlertStateWithDatabase(database as never, {
        fingerprint: "new-incident",
        state: "degraded",
        deliver,
      }),
    ).resolves.toEqual({ alerted: false, deliveryFailed: true });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("records recovery once so a later recurrence is a state change", async () => {
    const database = databaseWithRows(
      [],
      [
        {
          fingerprint: "old-incident",
          state: "degraded",
          withinCooldown: true,
        },
      ],
      [],
    );

    await expect(
      processSmsOperationsAlertStateWithDatabase(database as never, {
        fingerprint: "healthy",
        state: "healthy",
      }),
    ).resolves.toEqual({ alerted: false, deliveryFailed: false });
    expect(database.execute).toHaveBeenCalledTimes(3);
  });
});
