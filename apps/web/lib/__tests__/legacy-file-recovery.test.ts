import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bytesMatch,
  inspectLegacyFileBytes,
  parseLegacyFileRecoveryArgs,
  resolveLegacyRecoveryChecksum,
  sha256Hex,
} from "../legacy-file-recovery";

const FILE_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHECKSUM = "a".repeat(64);

describe("legacy file recovery", () => {
  it("checks exact-byte authorization before reading legacy provider bytes", () => {
    const script = readFileSync(
      resolve("scripts/recover-legacy-file.ts"),
      "utf8",
    );
    const evidenceGate = script.indexOf(
      "const expectedChecksumSha256 = resolveLegacyRecoveryChecksum",
    );
    const providerRead = script.indexOf("const legacy = legacyClient()");

    expect(evidenceGate).toBeGreaterThan(0);
    expect(providerRead).toBeGreaterThan(evidenceGate);
  });

  it("keeps audit read-only and scoped to one UUID", () => {
    expect(
      parseLegacyFileRecoveryArgs(["audit", "--file-id", FILE_ID]),
    ).toEqual({
      command: "audit",
      fileId: FILE_ID,
      execute: false,
      confirmation: undefined,
      expectedChecksumSha256: undefined,
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

    expect(() =>
      parseLegacyFileRecoveryArgs([
        "restore",
        "--file-id",
        FILE_ID,
        "--execute",
        "--expected-sha256",
        CHECKSUM,
        "--confirmation",
        `RESTORE-LEGACY-FILE:${FILE_ID}`,
      ]),
    ).toThrow(`RESTORE-LEGACY-FILE:${FILE_ID}:${CHECKSUM}`);

    expect(
      parseLegacyFileRecoveryArgs([
        "restore",
        "--file-id",
        FILE_ID,
        "--execute",
        "--expected-sha256",
        CHECKSUM,
        "--confirmation",
        `RESTORE-LEGACY-FILE:${FILE_ID}:${CHECKSUM}`,
      ]).expectedChecksumSha256,
    ).toBe(CHECKSUM);
  });

  it("rejects malformed reviewed checksum evidence", () => {
    expect(() =>
      parseLegacyFileRecoveryArgs([
        "audit",
        "--file-id",
        FILE_ID,
        "--expected-sha256",
        "ABC123",
      ]),
    ).toThrow("lowercase SHA-256 digest");
  });

  it("requires reviewed exact-byte evidence before executing a checksum-less restore", () => {
    expect(
      resolveLegacyRecoveryChecksum({
        recordedChecksumSha256: null,
        execute: false,
      }),
    ).toBeNull();
    expect(() =>
      resolveLegacyRecoveryChecksum({
        recordedChecksumSha256: null,
        execute: true,
      }),
    ).toThrow("separately reviewed --expected-sha256");
    expect(
      resolveLegacyRecoveryChecksum({
        recordedChecksumSha256: null,
        reviewedChecksumSha256: CHECKSUM,
        execute: true,
      }),
    ).toBe(CHECKSUM);
  });

  it("rejects reviewed evidence that conflicts with the recorded checksum", () => {
    expect(() =>
      resolveLegacyRecoveryChecksum({
        recordedChecksumSha256: "b".repeat(64),
        reviewedChecksumSha256: CHECKSUM,
        execute: true,
      }),
    ).toThrow("does not match the recorded manifest checksum");
  });

  it("verifies legacy bytes without exposing their contents", () => {
    const body = new TextEncoder().encode("synthetic-clinic-file");
    const inspected = inspectLegacyFileBytes({
      body,
      expectedFileSizeBytes: body.byteLength,
      expectedChecksumSha256: sha256Hex(body),
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

  it("does not treat a missing expected checksum as a successful match", () => {
    const inspected = inspectLegacyFileBytes({
      body: new Uint8Array([1, 2, 3]),
      expectedFileSizeBytes: 3,
      expectedChecksumSha256: null,
    });

    expect(inspected.sizeMatches).toBe(true);
    expect(inspected.checksumMatches).toBe(false);
  });
});
