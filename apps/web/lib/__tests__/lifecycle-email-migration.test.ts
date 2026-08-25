import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "../../packages/db/drizzle/0097_handy_toad_men.sql",
  "utf8",
);
const rls = readFileSync("../../packages/db/rls/enable-rls.sql", "utf8");

describe("durable lifecycle email migration", () => {
  it("creates the outbox, attempt history, identity fence, and uniqueness constraints", () => {
    expect(migration).toContain('CREATE TABLE "lifecycle_email_jobs"');
    expect(migration).toContain('CREATE TABLE "lifecycle_email_attempts"');
    expect(migration).toContain('"subscription_generation" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain("lifecycle_email_jobs_dedupe_key_uq");
    expect(migration).toContain("lifecycle_email_attempts_job_attempt_uq");
    expect(migration).toContain("lifecycle_email_jobs_communication_tenant_fk");
    expect(migration).toContain("lifecycle_email_attempts_job_tenant_fk");
  });

  it("enables deny-by-default system-only RLS in both migration and canonical policy", () => {
    for (const table of ["lifecycle_email_jobs", "lifecycle_email_attempts"]) {
      expect(migration).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(`REVOKE ALL ON public.lifecycle_email_jobs, public.lifecycle_email_attempts FROM PUBLIC`);
      expect(rls).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(rls).toContain(`CREATE POLICY system_only ON ${table}`);
    }
    expect(rls).toContain(
      "GRANT SELECT, INSERT, UPDATE ON lifecycle_email_jobs, lifecycle_email_attempts TO openpims_app",
    );
  });

  it("models pending, retry, lease, terminal failure, and unknown outcomes separately", () => {
    for (const state of [
      "pending",
      "retry",
      "delivering",
      "blocked_recovery",
      "delivered",
      "suppressed_stale",
      "failed",
      "outcome_unknown",
    ]) {
      expect(migration).toContain(state);
    }
    expect(migration).toContain("lifecycle_email_jobs_state_check");
    expect(migration).toContain("lifecycle_email_attempts_outcome_check");
  });
});
