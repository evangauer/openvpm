import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const drill = readFileSync(
  "lib/messaging/__tests__/sms-concurrency-drill.integration.test.ts",
  "utf8",
);
const ci = readFileSync("../../.github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

describe("provider-free SMS concurrency drill wiring", () => {
  it("uses real PostgreSQL locks and production event operations without provider adapters", () => {
    expect(drill).toContain("pg_blocking_pids");
    expect(drill).toContain("pg_locks");
    expect(drill).toContain("acquireSmsRecipientLockInTransaction");
    expect(drill).toContain("projectSmsProviderEventInTransaction");
    expect(drill).toContain(
      "projectSmsProviderEventForLockedPracticeInTransaction",
    );
    expect(drill).toContain("tx.transaction(async (eventTx)");
    expect(drill).not.toContain("telnyx-provisioning");
    expect(drill).not.toContain("twilio-provisioning");
    expect(drill).not.toContain("sendSms(");
  });

  it("runs in the real-Postgres CI job with every SMS capability disabled", () => {
    const resolutionContractIndex = ci.indexOf(
      "Execute SMS provider-resolution database contract",
    );
    const concurrencyDrillIndex = ci.indexOf(
      "Execute provider-free SMS concurrency drill",
    );
    const step = ci.slice(
      concurrencyDrillIndex,
      ci.indexOf("Execute appointment reminder policy SQL"),
    );
    expect(resolutionContractIndex).toBeGreaterThan(
      ci.indexOf("pnpm --filter @openpims/db db:rls"),
    );
    expect(concurrencyDrillIndex).toBeGreaterThan(resolutionContractIndex);
    expect(ci).toContain(
      "pnpm --filter @openpims/db db:sms-provider-resolutions:test",
    );
    expect(step).toContain('SMS_CONCURRENCY_DB_INTEGRATION: "1"');
    expect(step).toContain('MESSAGING_PROVISIONING_ENABLED: "false"');
    expect(step).toContain('MESSAGING_INBOUND_ENABLED: "false"');
    expect(step).toContain('MESSAGING_SENDING_ENABLED: "false"');
    expect(packageJson.scripts?.["test:sms-concurrency"]).toContain(
      "sms-concurrency-drill.integration.test.ts",
    );
  });

  it("restricts execution to disposable local PostgreSQL and protects immutable remediation evidence", () => {
    expect(drill).toContain("assertLocalDrillDatabase");
    expect(drill).toContain("sms_provider_event_resolutions");
    expect(drill).toContain(
      "Concurrency drill unexpectedly created immutable remediation evidence",
    );
    expect(drill).toContain("app.ledger_maintenance");
  });
});
