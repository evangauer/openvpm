import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRecoveryArgs } from "../../../scripts/recover-practice";

const PRACTICE_ID = "00000000-0000-4000-8000-000000000001";

describe("owner practice recovery CLI", () => {
  it("keeps restore dry-run by default", () => {
    expect(
      parseRecoveryArgs([
        "restore",
        "--practice-id",
        PRACTICE_ID,
        "--backup",
        "/tmp/backup.json",
        "--practice-name",
        "Recovery shell",
      ]),
    ).toMatchObject({
      command: "restore",
      practiceId: PRACTICE_ID,
      execute: false,
      restoreLegalEvidence: false,
    });
  });

  it("requires an explicit operator flag for sealed legal evidence", () => {
    expect(
      parseRecoveryArgs([
        "restore",
        "--practice-id",
        PRACTICE_ID,
        "--backup",
        "/tmp/backup.json",
        "--practice-name",
        "Recovery shell",
        "--restore-legal-evidence",
      ]),
    ).toMatchObject({
      command: "restore",
      execute: false,
      restoreLegalEvidence: true,
    });
  });

  it("requires an exact destructive confirmation", () => {
    expect(() =>
      parseRecoveryArgs([
        "restore",
        "--practice-id",
        PRACTICE_ID,
        "--backup",
        "/tmp/backup.json",
        "--practice-name",
        "Recovery shell",
        "--execute",
      ]),
    ).toThrow(`--confirmation must exactly equal RESTORE:${PRACTICE_ID}`);
  });

  it("requires every reconciliation gate before releasing a hold", () => {
    expect(() =>
      parseRecoveryArgs([
        "release",
        "--practice-id",
        PRACTICE_ID,
        "--execute",
        "--confirmation",
        `RELEASE:${PRACTICE_ID}`,
      ]),
    ).toThrow("release requires");

    expect(
      parseRecoveryArgs([
        "release",
        "--practice-id",
        PRACTICE_ID,
        "--execute",
        "--confirmation",
        `RELEASE:${PRACTICE_ID}`,
        "--verified-objects",
        "--verified-user-access",
        "--reconciled-messaging",
        "--reconciled-payments",
        "--reviewed-autonomous-jobs",
      ]),
    ).toMatchObject({ command: "release", execute: true });
  });

  it("owns the practice lock while draining provider events and clears the hold only after a zero-backlog check", () => {
    const source = readFileSync("scripts/recover-practice.ts", "utf8");
    const releaseSource = source.slice(
      source.indexOf("async function release"),
      source.indexOf("export async function main"),
    );

    expect(releaseSource).toContain('.for("update")');
    expect(releaseSource).toContain("recoveryHoldSetAt");
    expect(releaseSource).toContain(
      "projectSmsProviderEventForLockedPracticeInTransaction",
    );
    expect(releaseSource).toContain("tx.transaction(async (eventTx)");
    expect(releaseSource).toContain("eventTx as unknown as Database");
    expect(releaseSource).toContain(
      "unresolvedSince: practice.recoveryHoldSetAt",
    );
    expect(releaseSource).toContain("remainingProviderEvents.total > 0");
    expect(releaseSource).toContain('action: "hold_release_blocked"');
    expect(releaseSource).toContain("invalidSignedConsents");
    expect(releaseSource).toContain("signedFileChecksumSha256");
    expect(releaseSource).toContain("signedFileSizeBytes");
    expect(releaseSource).toContain("storageStatus, \"available\"");
    expect(
      releaseSource.indexOf("remainingProviderEvents.total > 0"),
    ).toBeLessThan(releaseSource.indexOf("recoveryHold: false"));
  });
});
