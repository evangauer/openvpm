import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "../../packages/db/drizzle/0110_controlled_substance_ledger_integrity.sql",
  "utf8",
);
const rls = readFileSync("../../packages/db/rls/enable-rls.sql", "utf8");
const audit = readFileSync(
  "../../packages/db/audit-controlled-substance-ledger.ts",
  "utf8",
);
const seed = readFileSync("../../packages/db/seed.ts", "utf8");

describe("controlled-substance ledger database contract", () => {
  it("backfills retry identity before making it required", () => {
    const addNullable = migration.indexOf("ADD COLUMN operation_id uuid;");
    const backfill = migration.indexOf("SET operation_id = id");
    const makeRequired = migration.indexOf(
      "ALTER COLUMN operation_id SET NOT NULL",
    );

    expect(addNullable).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(addNullable);
    expect(makeRequired).toBeGreaterThan(backfill);
    expect(migration).toContain(
      "controlled_substance_log_practice_operation_uq",
    );
  });

  it("binds every attributed identity to the declared tenant", () => {
    expect(migration).toContain("controlled_substance_log_patient_tenant_fk");
    expect(migration).toContain("controlled_substance_log_performer_tenant_fk");
    expect(migration).toContain("controlled_substance_log_witness_tenant_fk");
    expect(migration.match(/FOREIGN KEY \(practice_id, /g)).toHaveLength(3);
  });

  it("enforces regulatory row shape in PostgreSQL", () => {
    for (const constraint of [
      "controlled_substance_log_positive_quantity_check",
      "controlled_substance_log_administered_patient_check",
      "controlled_substance_log_waste_witness_check",
      "controlled_substance_log_distinct_witness_check",
    ]) {
      expect(migration).toContain(constraint);
    }
    expect(migration).toContain("witnessed_by <> performed_by");
  });

  it("keeps the regulatory ledger append-only after migrations and RLS refresh", () => {
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON public.controlled_substance_log",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON public.controlled_substance_log TO openpims_app",
    );
    expect(rls).toContain(
      "GRANT SELECT, INSERT ON controlled_substance_log TO openpims_app",
    );
    expect(rls).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON controlled_substance_log TO openpims_app",
    );
  });

  it("provides an explicit, aggregate-only, read-only adoption preflight", () => {
    expect(audit).toContain("--allow-live-read-only");
    expect(audit).toContain(
      "CONTROLLED_SUBSTANCE_LEDGER_READ_ONLY_CONFIRMATION",
    );
    expect(audit).toContain('"isolation level repeatable read read only"');
    expect(audit).toContain('mode: "read_only_aggregate"');
    expect(audit).not.toContain("select *");
    expect(audit).not.toContain('as "email"');
    expect(audit).not.toContain("practice.email as");
    expect(audit).not.toContain("patient.name");
    expect(audit).not.toContain("drug_name as");
  });

  it("seeds receipts before every synthetic controlled-drug consumption", () => {
    const ledgerSeed = seed.match(
      /\/\/ 19\. Controlled substance log(?<ledger>[\s\S]*?)\/\/ 20\. Treatment templates/,
    )?.groups?.ledger;

    expect(ledgerSeed).toBeTruthy();
    expect(ledgerSeed?.match(/action: "received"/g)).toHaveLength(6);
    expect(ledgerSeed?.match(/action: "administered"/g)).toHaveLength(5);
    expect(ledgerSeed?.match(/action: "wasted"/g)).toHaveLength(1);
    expect(
      ledgerSeed?.match(/operationId: crypto\.randomUUID\(\)/g),
    ).toHaveLength(12);

    for (const drug of [
      "Tramadol HCl 50mg",
      "Buprenorphine 0.3 mg/mL",
      "Phenobarbital 30mg",
      "Ketamine 100 mg/mL",
      "Morphine 15 mg/mL",
      "Gabapentin 100mg",
    ]) {
      const first = ledgerSeed?.indexOf(`drugName: "${drug}"`) ?? -1;
      const second =
        ledgerSeed?.indexOf(`drugName: "${drug}"`, first + 1) ?? -1;
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeGreaterThan(first);
      expect(ledgerSeed?.slice(first, second)).toContain('action: "received"');
    }
  });
});
