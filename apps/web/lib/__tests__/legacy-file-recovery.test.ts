import { describe, expect, it } from "vitest";
import {
  bytesMatch,
  inspectLegacyFileBytes,
  parseLegacyFileRecoveryArgs,
} from "../legacy-file-recovery";

const FILE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("legacy file recovery", () => {
  it("keeps audit read-only and scoped to one UUID", () => {
    expect(
      parseLegacyFileRecoveryArgs(["audit", "--file-id", FILE_ID]),
    ).toEqual({
      command: "audit",
      fileId: FILE_ID,
      execute: false,
      confirmation: undefined,
    });
    expect(() =>
      parseLegacyFileRecoveryArgs(["audit", "--file-id", FILE_ID, "--execute"]),
    ).toThrow("audit is always read-only");

    expect(
      parseLegacyFileRecoveryArgs(["--", "audit", "--file-id", FILE_ID])
        .command,
    ).toBe("audit");
  });

  it("requires an exact per-file confirmation for writes", () => {
    expect(() =>
      parseLegacyFileRecoveryArgs([
        "restore",
        "--file-id",
        FILE_ID,
        "--execute",
      ]),
    ).toThrow(`RESTORE-LEGACY-FILE:${FILE_ID}`);

    expect(
      parseLegacyFileRecoveryArgs([
        "restore",
        "--file-id",
        FILE_ID,
        "--execute",
        "--confirmation",
        `RESTORE-LEGACY-FILE:${FILE_ID}`,
      ]).execute,
    ).toBe(true);
  });

  it("verifies legacy bytes without exposing their contents", () => {
    const body = new TextEncoder().encode("synthetic-clinic-file");
    const inspected = inspectLegacyFileBytes({
      body,
      expectedFileSizeBytes: body.byteLength,
      expectedChecksumSha256: null,
    });

    expect(inspected.sizeMatches).toBe(true);
    expect(inspected.checksumMatches).toBe(true);
    expect(bytesMatch(body, inspected.checksumSha256, body.byteLength)).toBe(
      true,
    );
    expect(
      bytesMatch(
        new TextEncoder().encode("different"),
        inspected.checksumSha256,
        body.byteLength,
      ),
    ).toBe(false);
  });

  it("rejects a legacy object whose recorded byte length disagrees", () => {
    const body = new Uint8Array([1, 2, 3]);
    expect(
      inspectLegacyFileBytes({
        body,
        expectedFileSizeBytes: 4,
        expectedChecksumSha256: null,
      }).sizeMatches,
    ).toBe(false);
  });
});
