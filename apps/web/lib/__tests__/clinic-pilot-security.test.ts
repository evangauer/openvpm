import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  "../../packages/db/schema/clinic-pilots.ts",
  "utf8",
);
const rls = readFileSync("../../packages/db/rls/enable-rls.sql", "utf8");
const migration = readFileSync(
  "../../packages/db/drizzle/0072_lucky_kate_bishop.sql",
  "utf8",
);
const evidenceBindingMigration = readFileSync(
  "../../packages/db/drizzle/0073_omniscient_phil_sheldon.sql",
  "utf8",
);
const service = readFileSync("lib/admin/clinic-pilots.ts", "utf8");
const router = readFileSync("server/routers/admin.ts", "utf8");
const ui = readFileSync("components/admin/clinic-pilot-console.tsx", "utf8");

describe("clinic pilot operating boundary", () => {
  it("uses bounded PHI-free state plus immutable snapshots", () => {
    expect(schema).toContain('"clinic_pilots"');
    expect(schema).toContain('"clinic_pilot_events"');
    expect(schema).toContain('payloadHash: varchar("payload_hash"');
    expect(schema).toContain("qualificationChecklist");
    expect(schema).toContain("readinessChecklist");
    expect(schema).toContain("blockerCodes");
    expect(schema).not.toContain("patientId");
    expect(schema).not.toContain("clientId");
    expect(schema).not.toContain("notes:");
  });

  it("keeps both tables system-only and the event ledger append-only", () => {
    expect(rls).toContain(
      "ALTER TABLE clinic_pilots ENABLE ROW LEVEL SECURITY",
    );
    expect(rls).toContain(
      "ALTER TABLE clinic_pilot_events ENABLE ROW LEVEL SECURITY",
    );
    expect(rls).toContain("GRANT SELECT, INSERT, UPDATE ON clinic_pilots");
    expect(rls).toContain("GRANT SELECT, INSERT ON clinic_pilot_events");
    expect(rls).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON clinic_pilot_events",
    );
    expect(rls).not.toContain(
      "GRANT SELECT, INSERT, DELETE ON clinic_pilot_events",
    );
    expect(rls).toContain("clinic_pilots_require_event");
    expect(rls).toContain("clinic_pilot_events_immutable");
  });

  it("ships the schema as a real migration with lifecycle constraints", () => {
    expect(migration).toContain('CREATE TABLE "clinic_pilots"');
    expect(migration).toContain('CREATE TABLE "clinic_pilot_events"');
    expect(migration).toContain('CONSTRAINT "clinic_pilots_lifecycle_check"');
    expect(migration).toContain('"payload_hash" varchar(64) NOT NULL');
    expect(migration).toContain(
      "ALTER TABLE clinic_pilots ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("clinic_pilots_require_event");
    expect(
      migration.indexOf(
        'CREATE UNIQUE INDEX "clinic_pilots_id_practice_uq"',
      ),
    ).toBeLessThan(
      migration.indexOf(
        'ADD CONSTRAINT "clinic_pilot_events_pilot_practice_fk"',
      ),
    );
    expect(evidenceBindingMigration).toContain(
      '"first_visit_validated_closeout_id"',
    );
    expect(evidenceBindingMigration).toContain('"clinic_use_validated_hash"');
    expect(evidenceBindingMigration).toContain(
      "CREATE OR REPLACE FUNCTION enforce_clinic_pilot_projection_audit()",
    );
  });

  it("separates exact product evidence from operator state", () => {
    expect(service).toContain("from practice_conversion_milestones");
    expect(service).toContain("from visit_closeouts vc");
    expect(service).toContain("distinct_clinic_days");
    expect(service).toContain("payment_method_collected");
    expect(service).toContain("first_positive_payment");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("payloadHash !== hash");
    expect(service).toContain("firstVisitValidationCurrent");
    expect(service).toContain("clinicUseValidationCurrent");
  });

  it("uses platform-admin-only strict inputs and has no side-effect action", () => {
    expect(router).toContain("clinicPilotSaveInput");
    expect(router).toContain(".strict()");
    expect(router).toContain("saveClinicPilot: platformAdminProcedure");
    expect(ui).toContain("it never emails a clinic");
    expect(ui).toContain("enables texting");
    expect(ui).not.toContain("sendEmail");
    expect(ui).not.toContain("assignMessagingNumbers");
    expect(ui).not.toContain("checkout");
    expect(ui).toContain("stageRequirements");
    expect(ui).toContain("This stage is gated");
  });
});
