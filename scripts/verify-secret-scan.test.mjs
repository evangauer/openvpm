import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFindingFingerprints,
  validateExceptionRegistry,
} from "./verify-secret-scan.mjs";

const fingerprint = "test/example.test.ts:generic-api-key:10";
const healthyManifest = {
  schemaVersion: 1,
  exceptions: [
    {
      fingerprint,
      owner: "@maintainer",
      reason: "Synthetic fixture with no provider or deployment value.",
      addedOn: "2026-08-29",
      expiresOn: "2026-11-30",
    },
  ],
};

test("accepts a current, exactly mirrored exception", () => {
  const result = validateExceptionRegistry({
    ignoreText: `${fingerprint}\n`,
    manifest: structuredClone(healthyManifest),
    nowMs: Date.parse("2026-08-29T12:00:00.000Z"),
  });
  assert.deepEqual([...result], [fingerprint]);
});

test("rejects an expired exception", () => {
  assert.throws(
    () =>
      validateExceptionRegistry({
        ignoreText: `${fingerprint}\n`,
        manifest: structuredClone(healthyManifest),
        nowMs: Date.parse("2026-12-01T00:00:00.000Z"),
      }),
    /expired on 2026-11-30/,
  );
});

test("rejects a normalized but impossible calendar date", () => {
  const manifest = structuredClone(healthyManifest);
  manifest.exceptions[0].expiresOn = "2026-11-31";
  assert.throws(
    () =>
      validateExceptionRegistry({
        ignoreText: `${fingerprint}\n`,
        manifest,
        nowMs: Date.parse("2026-08-29T12:00:00.000Z"),
      }),
    /expiresOn is invalid/,
  );
});

test("rejects an ignore entry without reviewed metadata", () => {
  assert.throws(
    () =>
      validateExceptionRegistry({
        ignoreText: `${fingerprint}\nextra.test.ts:generic-api-key:20\n`,
        manifest: structuredClone(healthyManifest),
        nowMs: Date.parse("2026-08-29T12:00:00.000Z"),
      }),
    /must exactly match/,
  );
});

test("reports unknown findings and stale exceptions", () => {
  assert.deepEqual(
    compareFindingFingerprints(
      ["new.test.ts:generic-api-key:2"],
      new Set([fingerprint]),
    ),
    {
      unknown: ["new.test.ts:generic-api-key:2"],
      stale: [fingerprint],
    },
  );
});
