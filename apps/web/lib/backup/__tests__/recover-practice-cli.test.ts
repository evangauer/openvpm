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
});
