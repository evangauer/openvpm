import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant-db", () => ({
  withSystem: async (database: unknown, fn: (tx: unknown) => unknown) =>
    fn(database),
}));

const {
  AUTH_RECOVERY_EXPIRY_BATCH_SIZE,
  AUTH_RECOVERY_EXPIRY_MAX_BATCH_SIZE,
  AUTH_RECOVERY_GRANT_LENGTH,
  authRecoveryGrantHash,
  expireDueAuthRecoveryCases,
} = await import("../auth-recovery-lifecycle");

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name, `${directory.href}/`);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.[cm]?[jt]sx?$/.test(entry.name)
      ? [readFileSync(child, "utf8")]
      : [];
  });
}

describe("dormant auth recovery lifecycle", () => {
  it("hashes only exact 32-byte base64url grants with a domain separator", () => {
    const grant = "A".repeat(AUTH_RECOVERY_GRANT_LENGTH);
    expect(authRecoveryGrantHash(grant)).toBe(
      createHash("sha256")
        .update(`openvpm-auth-recovery-grant:v1:${grant}`)
        .digest("hex"),
    );
    for (const invalid of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}B`,
    ]) {
      expect(() => authRecoveryGrantHash(invalid)).toThrow(
        /invalid or expired/i,
      );
    }
  });

  it("calls the database-owned expiry function in a bounded system transaction", async () => {
    const execute = vi.fn(async (_query: unknown) => [{ expiredCount: 2 }]);
    await expect(
      expireDueAuthRecoveryCases({ execute } as never, 25),
    ).resolves.toBe(2);
    const query = new PgDialect().sqlToQuery(
      execute.mock.calls[0]![0] as SQL,
    );
    expect(query.sql).toContain("expire_due_auth_recovery_cases($1)::int");
    expect(query.params).toEqual([25]);
    expect(AUTH_RECOVERY_EXPIRY_BATCH_SIZE).toBe(100);
    expect(AUTH_RECOVERY_EXPIRY_MAX_BATCH_SIZE).toBe(1_000);
  });

  it("rejects invalid batches and impossible database results", async () => {
    const execute = vi.fn(async (_query: unknown) => [{ expiredCount: 26 }]);
    for (const invalid of [0, 1.5, 1_001]) {
      await expect(
        expireDueAuthRecoveryCases({ execute } as never, invalid),
      ).rejects.toThrow(/batch size/i);
    }
    await expect(
      expireDueAuthRecoveryCases({ execute } as never, 25),
    ).rejects.toThrow(/invalid result/i);
  });

  it("is not reachable from an HTTP route or tRPC router", () => {
    const exposedSources = [
      ...sourceFiles(new URL("../../app/api", import.meta.url)),
      ...sourceFiles(new URL("../routers", import.meta.url)),
    ];
    expect(
      exposedSources.some((source) =>
        source.includes("auth-recovery-lifecycle"),
      ),
    ).toBe(false);
  });
});
