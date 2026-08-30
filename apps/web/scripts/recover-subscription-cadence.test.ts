import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCadenceRecoveryArgs } from "./recover-subscription-cadence";

const OPERATION_ID = "00000000-0000-4000-8000-0000000000aa";

describe("subscription cadence owner recovery CLI", () => {
  it("keeps the application database client lazy until the owner URL is selected", () => {
    const operationsSource = readFileSync(
      "lib/billing/subscription-cadence-operations.ts",
      "utf8",
    );
    expect(operationsSource).toContain(
      'import type { Database } from "@openpims/db/client"',
    );
    expect(operationsSource).not.toContain(
      'import { db, type Database } from "@openpims/db/client"',
    );
  });

  it("parses read-only inspection without mutation attestations", () => {
    expect(
      parseCadenceRecoveryArgs(["inspect", "--operation-id", OPERATION_ID]),
    ).toMatchObject({
      command: "inspect",
      operationId: OPERATION_ID,
      execute: false,
    });
  });

  it("requires every review attestation and an exact execute confirmation", () => {
    const base = [
      "supersede",
      "--operation-id",
      OPERATION_ID,
      "--expected-revision",
      "4",
      "--reason",
      "provider_corrected",
    ];
    expect(() => parseCadenceRecoveryArgs(base)).toThrow(
      "requires --provider-schedule-reviewed",
    );
    const reviewed = [
      ...base,
      "--provider-schedule-reviewed",
      "--subscription-reviewed",
      "--quantity-reviewed",
      "--execute",
    ];
    expect(() => parseCadenceRecoveryArgs(reviewed)).toThrow(
      `--confirmation must exactly equal SUPERSEDE:${OPERATION_ID}:4`,
    );
    expect(
      parseCadenceRecoveryArgs([
        ...reviewed,
        "--confirmation",
        `SUPERSEDE:${OPERATION_ID}:4`,
      ]),
    ).toMatchObject({
      command: "supersede",
      expectedRevision: 4,
      reason: "provider_corrected",
      execute: true,
    });
  });
});
