import assert from "node:assert/strict";
import test from "node:test";
import { databaseTargetFingerprint } from "./deployment-target";
import {
  assertLocalResetPolicy,
  assertStagingResetPolicy,
} from "./reset-policy";

const isolatedRef = "abcdefghijklmnopqrst";
const isolatedUrl = `postgresql://owner:secret@db.${isolatedRef}.supabase.co:5432/postgres`;
const isolatedFingerprint = databaseTargetFingerprint(isolatedRef);
const forbiddenFingerprint = databaseTargetFingerprint("zyxwvutsrqponmlkjihg");

test("local reset requires loopback, an OpenVPM database, and typed intent", () => {
  assert.doesNotThrow(() =>
    assertLocalResetPolicy({
      DATABASE_URL: "postgresql://openpims:secret@127.0.0.1:5432/openpims_dev",
      RESET_DATABASE_CONFIRMATION: "RESET_LOCAL_OPENVPM",
      OPENVPM_ENVIRONMENT: "development",
    }),
  );
  for (const env of [
    {
      DATABASE_URL: isolatedUrl,
      RESET_DATABASE_CONFIRMATION: "RESET_LOCAL_OPENVPM",
    },
    {
      DATABASE_URL: "postgresql://openpims:secret@localhost/openpims",
      RESET_DATABASE_CONFIRMATION: "yes",
    },
    {
      DATABASE_URL: "postgresql://openpims:secret@localhost/customer_records",
      RESET_DATABASE_CONFIRMATION: "RESET_LOCAL_OPENVPM",
    },
    {
      DATABASE_URL: "postgresql://openpims:secret@localhost/openpims",
      RESET_DATABASE_CONFIRMATION: "RESET_LOCAL_OPENVPM",
      CI: "true",
    },
  ]) {
    assert.throws(() => assertLocalResetPolicy(env));
  }
});

test("staging reset binds intent to the isolated environment target", () => {
  assert.deepEqual(
    assertStagingResetPolicy({
      DATABASE_URL: isolatedUrl,
      STAGING_DATABASE_URL: isolatedUrl,
      STAGING_PROJECT_REF: isolatedRef,
      DATABASE_TARGET_FINGERPRINT: isolatedFingerprint,
      FORBIDDEN_DATABASE_TARGET_FINGERPRINTS: forbiddenFingerprint,
      OPENVPM_ENVIRONMENT: "staging",
      STAGING_RESET_CONFIRMATION: "RESET_STAGING_DATA",
    }),
    { projectRefFingerprint: isolatedFingerprint },
  );
});

test("staging reset fails closed on every identity or intent mismatch", () => {
  const healthy = {
    DATABASE_URL: isolatedUrl,
    STAGING_DATABASE_URL: isolatedUrl,
    STAGING_PROJECT_REF: isolatedRef,
    DATABASE_TARGET_FINGERPRINT: isolatedFingerprint,
    FORBIDDEN_DATABASE_TARGET_FINGERPRINTS: forbiddenFingerprint,
    OPENVPM_ENVIRONMENT: "staging",
    STAGING_RESET_CONFIRMATION: "RESET_STAGING_DATA",
  };
  for (const override of [
    { OPENVPM_ENVIRONMENT: "production" },
    { STAGING_RESET_CONFIRMATION: "RESET_STAGING" },
    { STAGING_PROJECT_REF: "zyxwvutsrqponmlkjihg" },
    { DATABASE_TARGET_FINGERPRINT: forbiddenFingerprint },
    { FORBIDDEN_DATABASE_TARGET_FINGERPRINTS: isolatedFingerprint },
    {
      STAGING_DATABASE_URL:
        "postgresql://owner:secret@db.zyxwvutsrqponmlkjihg.supabase.co/postgres",
    },
  ]) {
    assert.throws(() => assertStagingResetPolicy({ ...healthy, ...override }));
  }
});

test("staging reset independently rejects known data-bearing projects", () => {
  const protectedRef = "pgcbnjctkohehngiyola";
  const protectedUrl = `postgresql://owner:secret@db.${protectedRef}.supabase.co/postgres`;
  assert.throws(
    () =>
      assertStagingResetPolicy({
        DATABASE_URL: protectedUrl,
        STAGING_DATABASE_URL: protectedUrl,
        STAGING_PROJECT_REF: protectedRef,
        DATABASE_TARGET_FINGERPRINT: databaseTargetFingerprint(protectedRef),
        FORBIDDEN_DATABASE_TARGET_FINGERPRINTS: forbiddenFingerprint,
        OPENVPM_ENVIRONMENT: "staging",
        STAGING_RESET_CONFIRMATION: "RESET_STAGING_DATA",
      }),
    /protected data-bearing target/,
  );
});
