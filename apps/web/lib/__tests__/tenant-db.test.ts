import { describe, expect, it, vi } from "vitest";
import { withTenantReadOnlySnapshot } from "../tenant-db";

describe("tenant database snapshots", () => {
  it("sets repeatable-read/read-only characteristics before tenant scope and export reads", async () => {
    const execute = vi.fn(async () => undefined);
    const tx = { execute };
    const exportRead = vi.fn(async () => "exported");
    const transaction = vi.fn(
      async (fn: (transactionDb: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await expect(
      withTenantReadOnlySnapshot(
        { transaction } as never,
        "practice-1",
        exportRead as never,
      ),
    ).resolves.toBe("exported");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(exportRead).toHaveBeenCalledWith(tx);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[1]!,
    );
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      exportRead.mock.invocationCallOrder[0]!,
    );
  });
});
