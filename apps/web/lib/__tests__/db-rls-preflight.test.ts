import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeRlsDeploymentCapabilityFailure,
  rlsDeploymentCapabilityIsReady,
} from "@openpims/db/rls-preflight";

describe("RLS deployment ownership preflight", () => {
  it("passes only when every managed public object is manageable", () => {
    expect(
      rlsDeploymentCapabilityIsReady({
        currentRole: "migration_owner",
        unmanageableObjects: [],
      }),
    ).toBe(true);
    expect(
      rlsDeploymentCapabilityIsReady({
        currentRole: "migration_owner",
        unmanageableObjects: ["table out_of_band_table"],
      }),
    ).toBe(false);
  });

  it("emits a bounded, PHI-free operator error with a no-mutation guarantee", () => {
    const message = describeRlsDeploymentCapabilityFailure({
      currentRole: "staging_migrator",
      unmanageableObjects: Array.from(
        { length: 12 },
        (_, index) => `table drift_${index}`,
      ),
    });

    expect(message).toContain("RLS ownership preflight failed");
    expect(message).toContain("12 public object(s)");
    expect(message).toContain("and 2 more");
    expect(message).toContain("No migrations, role/password changes, grants");
    expect(message).not.toContain("drift_11");
  });

  it("runs before any RLS role or policy mutation", () => {
    const source = readFileSync(
      new URL("../../../../packages/db/apply-rls.ts", import.meta.url),
      "utf8",
    );
    const preflight = source.indexOf("assertRlsDeploymentCapability(sql)");
    const roleLookup = source.indexOf("select 1 from pg_roles");
    const policyApply = source.indexOf("sql.unsafe(sqlText)");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(roleLookup);
    expect(preflight).toBeLessThan(policyApply);
    expect(source).toContain("err instanceof Error ? err.message : err");
  });

  it("gates both hosted environments before migrations", () => {
    const workflow = readFileSync(
      new URL("../../../../.github/workflows/migrate.yml", import.meta.url),
      "utf8",
    );
    const jobs = workflow.split("  demo:");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const preflight = job.indexOf("run: pnpm db:rls:preflight");
      const migrate = job.indexOf("run: pnpm db:migrate");
      expect(preflight).toBeGreaterThanOrEqual(0);
      expect(preflight).toBeLessThan(migrate);
    }
  });
});
