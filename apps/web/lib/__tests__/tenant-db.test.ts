import { describe, expect, it, vi } from "vitest";
import {
  withSystemSavepoint,
  withTenant,
  withTenantReadOnlySnapshot,
} from "../tenant-db";

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlText).join(" ");
  if (!value || typeof value !== "object") return "";
  const candidate = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(candidate.queryChunks ?? []),
    ...(candidate.value === undefined ? [] : [candidate.value]),
  ]
    .map(sqlText)
    .join(" ");
}

describe("tenant database transactions", () => {
  it("sets serializable isolation before tenant scope and application work", async () => {
    const execute = vi.fn(async (_statement: unknown) => undefined);
    const tx = { execute };
    const work = vi.fn(async () => "merged");
    const transaction = vi.fn(
      async (fn: (transactionDb: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await expect(
      withTenant({ transaction } as never, "practice-1", work as never, {
        isolationLevel: "serializable",
      }),
    ).resolves.toBe("merged");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sqlText(execute.mock.calls[0]?.[0])).toContain(
      "set transaction isolation level serializable",
    );
    expect(sqlText(execute.mock.calls[1]?.[0])).toContain(
      "app.current_practice_id",
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[1]!,
    );
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      work.mock.invocationCallOrder[0]!,
    );
  });
});

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

describe("system database transactions", () => {
  it("restores the caller's RLS bypass after nested system work", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ bypass: "" }])
      .mockResolvedValue(undefined);
    const tx = { execute };
    const work = vi.fn(async () => "system result");
    const transaction = vi.fn(
      async (fn: (transactionDb: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await expect(
      withSystemSavepoint({ transaction } as never, work as never),
    ).resolves.toBe("system result");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(sqlText(execute.mock.calls[0]?.[0])).toContain("app.rls_bypass");
    expect(sqlText(execute.mock.calls[1]?.[0])).toContain("app.rls_bypass");
    expect(work).toHaveBeenCalledWith(tx);
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(
      work.mock.invocationCallOrder[0]!,
    );
    expect(work.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[2]!,
    );
  });

  it("restores an existing system scope after a nested savepoint", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ bypass: "on" }])
      .mockResolvedValue(undefined);
    const tx = { execute };
    const transaction = vi.fn(
      async (fn: (transactionDb: typeof tx) => Promise<unknown>) => fn(tx),
    );

    await withSystemSavepoint(
      { transaction } as never,
      async () => "nested result",
    );

    expect(sqlText(execute.mock.calls[2]?.[0])).toContain("on");
  });
});
